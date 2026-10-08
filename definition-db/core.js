// 맥락 보존형 정의 데이터베이스 — 공용 로직 (브라우저 viewer.html 과 Node dbtool.mjs 가 함께 사용)
//
// 저장 단위는 "메모"가 아니라 정의항(definiens)이다.
//   피정의항(term)  : 정의되는 말. 여러 개의 정의항을 가질 수 있다(다의어·분야별 정의).
//   정의항(definiens): 하나의 정의 문장 + 그 정의가 성립하는 맥락 + 다른 정의항으로 가는 연결.
//   연결(link)       : 정의항 → 정의항. "A의 이 정의에서 A는 B의 *이* 정의의 하위 개념이다"를 표현한다.
// 같은 피정의항이라도 정의항마다 상위/하위가 다를 수 있으므로, 연결은 피정의항이 아니라 정의항 ID 끼리 잇는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DefDB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'definition-db', PATCH_FORMAT = 'definition-db-patch', VERSION = 1;

  // 관계 종류. axis 가 있는 관계는 위계(상위/하위)를 만들고, dir 은 연결을 가진 정의항 기준 방향이다.
  const REL = {
    is_a:         { axis: 'kind',     dir: 'up',   label: '~의 일종',       up: '상위 범주', down: '하위 범주' },
    has_kind:     { axis: 'kind',     dir: 'down', label: '하위 종류로 ~를 가짐' },
    part_of:      { axis: 'part',     dir: 'up',   label: '~의 구성요소',   up: '전체',     down: '구성요소' },
    has_part:     { axis: 'part',     dir: 'down', label: '구성요소로 ~를 가짐' },
    instance_of:  { axis: 'instance', dir: 'up',   label: '~의 사례',       up: '유형',     down: '사례' },
    has_instance: { axis: 'instance', dir: 'down', label: '사례로 ~를 가짐' },
    requires:     { axis: null, label: '조건/전제',  inverse: '이를 전제로 하는 정의' },
    contrasts:    { axis: null, label: '대비',       inverse: '대비' },
    refers:       { axis: null, label: '정의에 사용', inverse: '이 개념을 사용하는 정의' },
  };
  const AXIS_UP = { kind: '상위 범주', part: '전체', instance: '유형' };
  const AXIS_DOWN = { kind: '하위 범주', part: '구성요소', instance: '사례' };

  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (s) => (s == null ? '' : String(s)).trim();
  const isTempId = (id) => !id || /#\+/.test(id);
  const termOfId = (id) => { const i = String(id).lastIndexOf('#'); return i < 0 ? String(id) : String(id).slice(0, i); };

  function emptyDB() { return { format: FORMAT, version: VERSION, terms: {} }; }

  // 느슨한 입력을 표준 형태로 맞춘다(필드 누락 보충, 문자열 정리). 원본은 건드리지 않는다.
  function normalize(input) {
    const db = emptyDB();
    if (!isObj(input) || !isObj(input.terms)) return db;
    for (const [key, t] of Object.entries(input.terms)) {
      const label = str(key);
      if (!label || !isObj(t)) continue;
      db.terms[label] = normTerm(label, t);
    }
    return db;
  }
  function normTerm(label, t) {
    const out = { label, aliases: [...new Set((t.aliases || []).map(str).filter(Boolean))], definientia: [] };
    if (str(t.note)) out.note = str(t.note);
    for (const d of t.definientia || []) if (isObj(d)) out.definientia.push(normDef(d));
    return out;
  }
  function normDef(d) {
    const out = { id: str(d.id), text: str(d.text), context: str(d.context), links: [], examples: [] };
    for (const l of d.links || []) {
      if (!isObj(l)) continue;
      const nl = { to: str(l.to), rel: str(l.rel) };
      if (str(l.span)) nl.span = str(l.span);
      if (str(l.note)) nl.note = str(l.note);
      out.links.push(nl);
    }
    out.examples = (d.examples || []).map(str).filter(Boolean);
    for (const k of ['source', 'by', 'at']) if (str(d[k])) out[k] = str(d[k]);
    return out;
  }

  // ===== 색인 =====
  // 그래프 노드: 정의항 ID("효소#1") 또는 감각이 정해지지 않은 피정의항("@효소").
  function index(db) {
    const defs = new Map();          // id -> {term, def}
    for (const t of Object.values(db.terms)) for (const d of t.definientia) defs.set(d.id, { term: t.label, def: d });
    const edges = [];
    for (const { term, def } of defs.values()) {
      def.links.forEach((link, i) => {
        const tgt = resolve(db, defs, link.to);
        const r = REL[link.rel] || {};
        const e = { from: def.id, fromTerm: term, link, i, target: tgt.node, status: tgt.status, rel: link.rel, axis: r.axis || null };
        if (r.axis) { e.child = r.dir === 'up' ? def.id : tgt.node; e.parent = r.dir === 'up' ? tgt.node : def.id; }
        edges.push(e);
      });
    }
    const up = new Map(), down = new Map(), side = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const e of edges) {
      if (e.axis) { push(up, e.child, e); push(down, e.parent, e); }
      else { push(side, e.from, e); if (e.target !== e.from) push(side, e.target, e); }
    }
    // "@효소"(감각 미정)로 연결된 것은 효소의 모든 정의항에서도 보이게 한다.
    const at = (node) => { const id = String(node); return id.startsWith('@') ? [] : ['@' + termOfId(id)]; };
    const get = (m, node) => [...(m.get(node) || []), ...at(node).flatMap((k) => m.get(k) || [])];
    return {
      defs, edges,
      parents: (node) => get(up, node),
      children: (node) => get(down, node),
      sides: (node) => get(side, node),
    };
  }
  // link.to 해석: "단백질#1" → 정의항, "단백질" → 정의항이 하나뿐이면 그것, 여러 개면 "@단백질"(감각 미정).
  function resolve(db, defs, to) {
    if (!to) return { node: '@', status: 'missing' };
    if (to.includes('#')) return defs.has(to) ? { node: to, status: 'ok' } : { node: to, status: 'missing' };
    const t = db.terms[to];
    if (!t) return { node: '@' + to, status: 'missing' };
    if (t.definientia.length === 1) return { node: t.definientia[0].id, status: 'auto' };
    return { node: '@' + to, status: 'ambiguous' };
  }

  // ===== 검사 =====
  function validate(db) {
    const errors = [], warnings = [];
    const E = (where, msg) => errors.push({ where, msg }), W = (where, msg) => warnings.push({ where, msg });
    const seen = new Set();
    for (const [key, t] of Object.entries(db.terms)) {
      if (key !== t.label) E(key, `피정의항 키와 label 이 다름 (${t.label})`);
      if (!t.definientia.length) W(key, '정의항이 없는 피정의항 (빈 자리)');
      for (const d of t.definientia) {
        const where = d.id || key;
        if (!d.id) E(key, '정의항 id 없음');
        else if (termOfId(d.id) !== key) E(where, `id 의 앞부분이 피정의항(${key})과 다름`);
        if (seen.has(d.id)) E(where, '중복 id'); seen.add(d.id);
        if (!d.text) E(where, '정의 문장(text) 없음');
        if (!d.context) W(where, '맥락(context) 없음 — 어느 분야/관점의 정의인지 적어야 함');
        d.links.forEach((l, i) => {
          if (!REL[l.rel]) E(where, `연결 ${i + 1}: 알 수 없는 관계 '${l.rel}'`);
          if (!l.to) E(where, `연결 ${i + 1}: 대상(to) 없음`);
          if (l.to === d.id || l.to === key) E(where, `연결 ${i + 1}: 자기 자신을 가리킴`);
          if (l.span && !d.text.includes(l.span)) W(where, `연결 ${i + 1}: 근거 구절 '${l.span}' 이 정의 문장에 없음`);
          if (!l.span && REL[l.rel] && l.rel !== 'contrasts') W(where, `연결 ${i + 1}(→${l.to}): 근거 구절(span) 없음`);
        });
      }
    }
    const ix = index(db);
    for (const e of ix.edges) {
      if (e.status === 'missing') W(e.from, `→ '${e.link.to}' 가 데이터베이스에 없음`);
      if (e.status === 'ambiguous') W(e.from, `→ '${e.link.to}' 의 정의항이 여러 개라 어느 뜻인지 불명확 (예: ${e.link.to}#1)`);
    }
    // 위계 순환 검사 (상위로 올라가다 자기 자신으로 돌아오면 오류)
    const parentsOf = new Map();
    for (const e of ix.edges) if (e.axis) { if (!parentsOf.has(e.child)) parentsOf.set(e.child, []); parentsOf.get(e.child).push(e.parent); }
    const state = new Map();
    const dfs = (n, path) => {
      if (state.get(n) === 1) { E(n, '위계 순환: ' + [...path.slice(path.indexOf(n)), n].join(' → ')); return; }
      if (state.get(n) === 2) return;
      state.set(n, 1); path.push(n);
      for (const p of parentsOf.get(n) || []) dfs(p, path);
      path.pop(); state.set(n, 2);
    };
    for (const n of parentsOf.keys()) dfs(n, []);
    return { errors, warnings };
  }

  // ===== 병합 (AI 가 만든 패치를 데이터베이스에 반영) =====
  // 패치 형식: { format:"definition-db-patch", terms:{ 피정의항:{aliases, definientia:[...]}}, remove:["효소#2"] }
  //  - 같은 id 의 정의항은 통째로 교체(수정), 새 정의항은 id 를 비우거나 "효소#+1" 같은 임시 id 사용.
  //  - 임시 id 는 다음 빈 번호로 바뀌고, 패치 안에서 그 임시 id 를 가리키던 연결도 함께 바뀐다.
  function merge(dbIn, patchIn) {
    const db = normalize(clone(dbIn));
    const p = normalize(patchIn);
    const report = { added: [], updated: [], removed: [], idmap: {}, problems: [] };
    const touched = [];
    for (const [key, pt] of Object.entries(p.terms)) {
      const t = db.terms[key] || (db.terms[key] = { label: key, aliases: [], definientia: [] });
      t.aliases = [...new Set([...t.aliases, ...pt.aliases])].filter((a) => a !== key);
      if (pt.note) t.note = pt.note;
      for (const d of pt.definientia) {
        if (isTempId(d.id)) {
          const nid = key + '#' + nextNum(t);
          if (d.id) report.idmap[d.id] = nid;
          d.id = nid; t.definientia.push(d); report.added.push(nid);
        } else if (termOfId(d.id) !== key) {
          report.problems.push(`${d.id}: '${key}' 아래에 있지만 id 가 다른 피정의항을 가리킴 — 건너뜀`); continue;
        } else {
          const i = t.definientia.findIndex((x) => x.id === d.id);
          if (i >= 0) { t.definientia[i] = d; report.updated.push(d.id); } else { t.definientia.push(d); report.added.push(d.id); }
        }
        touched.push(d);
      }
    }
    for (const d of touched) for (const l of d.links) if (report.idmap[l.to]) l.to = report.idmap[l.to];
    for (const id of (Array.isArray(patchIn && patchIn.remove) ? patchIn.remove : []).map(str)) {
      const t = db.terms[termOfId(id)];
      const n = t ? t.definientia.length : 0;
      if (t) t.definientia = t.definientia.filter((d) => d.id !== id);
      if (t && t.definientia.length < n) report.removed.push(id); else report.problems.push(`삭제 대상 ${id} 없음`);
    }
    // 삭제된 정의항을 가리키는 연결은 남겨 두면 끊어진 링크가 되므로 정리한다.
    if (report.removed.length) for (const t of Object.values(db.terms)) for (const d of t.definientia)
      d.links = d.links.filter((l) => !report.removed.includes(l.to));
    return { db, report };
  }
  function nextNum(t) {
    let m = 0;
    for (const d of t.definientia) { const n = parseInt(String(d.id).split('#').pop(), 10); if (n > m) m = n; }
    return m + 1;
  }

  // ===== 이전 형식(bionote v3 개념) 변환 =====
  const V3_ROLE = { '상위범주': 'is_a', '구성요소': 'has_part', '조건': 'requires', '대비': 'contrasts', '기능': 'refers', '미정': 'refers' };
  function fromV3(items) {
    const list = [];
    const walk = (o) => { if (!isObj(o)) return; if (o.kind === 'bundle') (o.items || []).forEach(walk); else if (o.title && (o.kind === 'concept' || !o.kind)) list.push(o); };
    (Array.isArray(items) ? items : [items]).forEach(walk);
    const patch = { format: PATCH_FORMAT, version: VERSION, terms: {} };
    for (const c of list) {
      const key = str(c.title);
      patch.terms[key] = {
        definientia: (c.defs || []).map((d, i) => ({
          id: key + '#' + (i + 1),
          text: str(d.text).replace(/\[\[([^\]]+)\]\]/g, '$1'),
          context: '',
          links: (d.links || []).map((l) => ({ to: str(l.to), rel: V3_ROLE[l.role] || 'refers', span: str(d.text).includes(l.to) ? str(l.to) : undefined, note: str(l.note) || undefined })),
          examples: (d.examples || []).map((e) => e.text),
          source: 'bionote v3 변환',
        })),
        note: (c.axioms || []).map((a) => '공리: ' + a.text).join('\n') || undefined,
      };
    }
    return patch;
  }
  const looksV3 = (o) => isObj(o) && (o.kind === 'bundle' || o.kind === 'concept' || (o.title && Array.isArray(o.defs)));

  // ===== 맥락 출력 (사람/AI 가 읽는 텍스트) =====
  function line(ix, db, node) {
    if (String(node).startsWith('@')) {
      const t = db.terms[node.slice(1)];
      return `[${node.slice(1)}] (뜻 미지정${t ? `, 정의항 ${t.definientia.length}개` : ', 데이터베이스에 없음'})`;
    }
    const x = ix.defs.get(node);
    if (!x) return `[${node}] (데이터베이스에 없음)`;
    return `[${node}] ${x.term} := ${x.def.text}${x.def.context ? ` 〈${x.def.context}〉` : ''}`;
  }
  function relName(e, dirUp) { return dirUp ? AXIS_UP[e.axis] : AXIS_DOWN[e.axis]; }
  function contextText(db, target, opt) {
    opt = Object.assign({ up: 4, down: 1 }, opt || {});
    db = normalize(db);
    const ix = index(db);
    const ids = target.includes('#') ? [target] : (db.terms[target] ? db.terms[target].definientia.map((d) => d.id) : []);
    if (!ids.length) return `'${target}' 은(는) 데이터베이스에 없습니다.`;
    const out = [];
    for (const id of ids) {
      out.push(line(ix, db, id));
      const x = ix.defs.get(id);
      if (x && x.def.examples.length) out.push('  예: ' + x.def.examples.join(' / '));
      const ups = [];
      const climb = (n, depth, pad, seen) => {
        if (depth >= opt.up) return;
        for (const e of ix.parents(n)) {
          const p = e.parent;
          ups.push(`${pad}↑ ${relName(e, true)}${e.link.span ? ` ("${e.link.span}")` : ''}: ${line(ix, db, p)}`);
          if (seen.has(p)) { ups.push(pad + '   (순환)'); continue; }
          climb(p, depth + 1, pad + '   ', new Set([...seen, p]));
        }
      };
      climb(id, 0, '  ', new Set([id]));
      if (ups.length) out.push(...ups);
      const downs = [];
      const sink = (n, depth, pad) => {
        if (depth >= opt.down) return;
        for (const e of ix.children(n)) { downs.push(`${pad}↓ ${relName(e, false)}: ${line(ix, db, e.child)}`); sink(e.child, depth + 1, pad + '   '); }
      };
      sink(id, 0, '  ');
      if (downs.length) out.push(...downs);
      for (const e of ix.sides(id)) {
        const r = REL[e.rel] || {};
        if (e.from === id) out.push(`  ↔ ${r.label || e.rel}${e.link.span ? ` ("${e.link.span}")` : ''}: ${line(ix, db, e.target)}`);
        else out.push(`  ↔ ${r.inverse || e.rel}: ${line(ix, db, e.from)}`);
      }
      out.push('');
    }
    return out.join('\n').trimEnd();
  }

  // ===== AI 에게 줄 작성 지침 + 현재 색인 =====
  function promptText(db, opt) {
    db = normalize(db);
    opt = opt || {};
    const idx = [];
    for (const t of Object.values(db.terms).sort((a, b) => a.label.localeCompare(b.label)))
      for (const d of t.definientia) idx.push(`${d.id} | ${d.context || '-'} | ${d.text.length > 60 ? d.text.slice(0, 60) + '…' : d.text}`);
    for (const t of Object.values(db.terms)) if (!t.definientia.length) idx.push(`${t.label} | (정의항 없음 — 자리만 있음)`);
    const rels = Object.entries(REL).map(([k, r]) => `  - ${k}: ${r.label}`).join('\n');
    return `너는 "맥락 보존형 정의 데이터베이스"에 항목을 추가하는 작성자다. 아래 자료를 읽고 패치 JSON 하나만 출력하라.

## 데이터 모델
- 피정의항(term): 정의되는 말. JSON 의 terms 키.
- 정의항(definiens): 피정의항의 정의 하나. 같은 말이라도 분야·관점이 다르면 정의항을 따로 만든다.
  - id: "피정의항#번호". 새 정의항은 "피정의항#+1", "피정의항#+2" 같은 임시 id 를 쓴다(병합 때 실제 번호로 바뀜).
  - text: 정의 문장 하나(유개념 + 종차 형태 권장: "B 중에서 ~한 것").
  - context: 이 정의가 성립하는 분야/관점/범위 (예: "생화학", "고등학교 생명과학 교과 수준").
  - links: 이 정의 문장 속 개념을 다른 정의항에 잇는다. { to, rel, span, note }
    - to: 반드시 정의항 id("단백질#1"). 아래 색인에 있으면 그 id, 없으면 같은 패치 안에서 새로 만든 임시 id.
    - span: 정의 문장 안에서 이 연결의 근거가 되는 구절(원문 그대로 부분 문자열).
    - note: 왜 이 연결인지 한 줄 (선택).
  - examples: 예시 (선택), source: 출처 (선택), by: 작성한 AI 이름, at: 작성 날짜(YYYY-MM-DD).
- rel 종류:
${rels}

## 규칙
1. 연결은 피정의항이 아니라 "그 뜻의 정의항"에 건다. 대상 개념의 뜻이 여러 개면 지금 정의 문맥에 맞는 하나를 고른다.
2. 정의 문장에 쓰인 핵심 개념이 색인에 없으면, 그 개념의 피정의항과 정의항도 함께 만들어 연결한다.
3. 상위/하위는 is_a(일종), part_of(구성요소), instance_of(사례) 중 의미에 맞는 것을 쓰고 순환을 만들지 않는다.
4. 기존 정의항을 고칠 때만 기존 id 를 쓴다(그 정의항 전체가 교체됨). 지울 정의항은 "remove": ["id"] 에 넣는다.
5. 자료에 없는 내용을 지어내지 말고, 불확실하면 note 에 적는다.
6. 출력은 JSON 하나만. 설명 문장, 코드 펜스 밖 텍스트 금지.

## 출력 형식
{
  "format": "definition-db-patch",
  "version": 1,
  "terms": {
    "효소": {
      "aliases": ["enzyme"],
      "definientia": [
        {
          "id": "효소#+1",
          "text": "생체 내 화학 반응의 활성화 에너지를 낮추는 단백질성 촉매",
          "context": "생화학",
          "links": [
            { "to": "촉매#1", "rel": "is_a", "span": "촉매" },
            { "to": "활성화 에너지#+1", "rel": "refers", "span": "활성화 에너지" }
          ],
          "examples": ["아밀레이스"],
          "by": "AI 이름", "at": "YYYY-MM-DD"
        }
      ]
    },
    "활성화 에너지": { "definientia": [ { "id": "활성화 에너지#+1", "text": "…", "context": "화학", "links": [] } ] }
  },
  "remove": []
}

## 현재 데이터베이스 색인 (id | 맥락 | 정의 앞부분)
${idx.length ? idx.join('\n') : '(비어 있음)'}

## 자료
${opt.material || '(여기에 정리할 자료를 붙여 넣으세요)'}
`;
  }

  // AI 응답에서 JSON 만 꺼낸다(코드 펜스나 앞뒤 설명이 붙어 와도 처리).
  function parseLoose(text) {
    const s = String(text).trim();
    try { return JSON.parse(s); } catch (_) { /* 아래에서 다시 시도 */ }
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1]);
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error('JSON 을 찾을 수 없음');
  }

  // 어떤 입력이든(데이터베이스 / 패치 / v3) 패치로 바꿔 병합한다.
  function ingest(db, obj) {
    if (looksV3(obj) || Array.isArray(obj)) return merge(db, fromV3(obj));
    return merge(db, obj);
  }

  return { FORMAT, PATCH_FORMAT, VERSION, REL, AXIS_UP, AXIS_DOWN, emptyDB, normalize, index, validate, merge, ingest, fromV3, contextText, promptText, parseLoose, termOfId };
});
