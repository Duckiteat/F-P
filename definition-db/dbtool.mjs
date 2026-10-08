#!/usr/bin/env node
// 정의 데이터베이스 명령줄 도구 — AI 에이전트(Claude Code 등)가 직접 읽고 쓰기 위한 진입점.
// 기본 저장소는 data/db.json 이다. 다른 파일을 쓰려면 --db <경로>.
//
//   node dbtool.mjs status                                 저장소 요약
//   node dbtool.mjs validate
//   node dbtool.mjs merge    <patch.json...> [--dry]       검사 후 병합, 적용한 패치는 data/patches/ 에 기록
//   node dbtool.mjs context  <피정의항|정의항id> [--up N] [--down N]
//   node dbtool.mjs mechanism <step:N | 경로 피정의항 | 경로 정의항id> [--up N] [--down N]   기전 사슬 따라가기
//   node dbtool.mjs prompt   [자료.txt]                     AI 에게 줄 작성 지침 + 현재 색인 출력
//   node dbtool.mjs migrate  <bionote-v3.json...>           v3 개념 파일 → 패치 JSON 출력
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DefDB = createRequire(import.meta.url)('./core.js');
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else args.push(rest[i]);
}
const DB_PATH = flags.db || join(HERE, 'data', 'db.json');
const PATCH_DIR = join(dirname(DB_PATH), 'patches');
const readJSON = (p) => DefDB.parseLoose(readFileSync(p, 'utf8'));
const loadDB = () => (existsSync(DB_PATH) ? DefDB.normalize(readJSON(DB_PATH)) : DefDB.emptyDB());
const printIssues = ({ errors, warnings }) => {
  for (const e of errors) console.log(`오류  ${e.where}: ${e.msg}`);
  for (const w of warnings) console.log(`경고  ${w.where}: ${w.msg}`);
  console.log(`— 오류 ${errors.length}, 경고 ${warnings.length}`);
};
const die = (m) => { console.error(m); process.exit(1); };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

switch (cmd) {
  case 'status': {
    const db = loadDB(), terms = Object.values(db.terms);
    const defs = terms.reduce((n, t) => n + t.definientia.length, 0);
    const links = terms.reduce((n, t) => n + t.definientia.reduce((m, d) => m + d.links.length, 0), 0);
    const r = DefDB.validate(db);
    console.log(`저장소 ${relative(process.cwd(), DB_PATH) || DB_PATH}: 피정의항 ${terms.length}, 정의항 ${defs}, 연결 ${links}, 기전 단계 ${Object.keys(db.steps).length}, 오류 ${r.errors.length}, 경고 ${r.warnings.length}`);
    break;
  }
  case 'validate': {
    const r = DefDB.validate(loadDB());
    printIssues(r);
    process.exit(r.errors.length ? 1 : 0);
  }
  case 'merge': {
    if (!args.length) die('사용법: merge <patch.json...> [--dry]');
    let db = loadDB();
    const applied = [];
    for (const p of args) {
      const patch = readJSON(p);
      const { db: next, report } = DefDB.ingest(db, patch);
      console.log(`${p}: 추가 ${report.added.length}, 수정 ${report.updated.length}, 삭제 ${report.removed.length}`);
      for (const [a, b] of Object.entries(report.idmap)) console.log(`  ${a} → ${b}`);
      for (const m of report.problems) console.log('  문제: ' + m);
      applied.push({ name: basename(p), patch, report: { added: report.added, updated: report.updated, removed: report.removed } });
      db = next;
    }
    const r = DefDB.validate(db);
    printIssues(r);
    if (r.errors.length) die('오류가 있어 저장하지 않았습니다.');
    if (flags.dry) { console.log('(--dry: 저장하지 않음)'); break; }
    mkdirSync(PATCH_DIR, { recursive: true });
    for (const a of applied) {
      const out = join(PATCH_DIR, `${stamp()}-${a.name}`);
      writeFileSync(out, JSON.stringify({ applied_at: new Date().toISOString(), result: a.report, ...a.patch }, null, 2) + '\n');
      console.log('기록: ' + relative(process.cwd(), out));
    }
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
    console.log('저장: ' + relative(process.cwd(), DB_PATH));
    break;
  }
  case 'context': {
    if (!args[0]) die('사용법: context <피정의항|정의항id> [--up N] [--down N]');
    console.log(DefDB.contextText(loadDB(), args[0], { up: +(flags.up || 4), down: +(flags.down || 1) }));
    break;
  }
  case 'mechanism': {
    if (!args[0]) die('사용법: mechanism <step:N | 경로 피정의항 | 경로 정의항id> [--up N] [--down N]');
    console.log(DefDB.mechanismText(loadDB(), args[0], { up: +(flags.up || 3), down: +(flags.down || 3) }));
    break;
  }
  case 'prompt': {
    console.log(DefDB.promptText(loadDB(), { material: args[0] ? readFileSync(args[0], 'utf8') : '' }));
    break;
  }
  case 'migrate': {
    if (!args.length) die('사용법: migrate <bionote-v3.json...>');
    console.log(JSON.stringify(DefDB.fromV3(args.map(readJSON)), null, 2));
    break;
  }
  default:
    die('명령: status | validate | merge | context | mechanism | prompt | migrate  (파일 맨 위 주석 참고, 저장소 기본값 data/db.json)');
}
