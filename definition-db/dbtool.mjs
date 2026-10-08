#!/usr/bin/env node
// 정의 데이터베이스 명령줄 도구 — AI 에이전트(Claude Code 등)가 직접 읽고 쓰기 위한 진입점.
//
//   node dbtool.mjs validate <db.json>
//   node dbtool.mjs merge    <db.json> <patch.json...> [--dry]   패치 병합 후 db.json 덮어쓰기 (오류 있으면 중단)
//   node dbtool.mjs context  <db.json> <피정의항|정의항id> [--up N] [--down N]
//   node dbtool.mjs prompt   <db.json> [자료.txt]                AI 에게 줄 작성 지침 + 현재 색인 출력
//   node dbtool.mjs migrate  <bionote-v3.json...>               v3 개념 파일 → 패치 JSON 출력
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const DefDB = createRequire(import.meta.url)('./core.js');
const [cmd, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else args.push(rest[i]);
}
const readJSON = (p) => DefDB.parseLoose(readFileSync(p, 'utf8'));
const loadDB = (p) => (existsSync(p) ? DefDB.normalize(readJSON(p)) : DefDB.emptyDB());
const printIssues = ({ errors, warnings }) => {
  for (const e of errors) console.log(`오류  ${e.where}: ${e.msg}`);
  for (const w of warnings) console.log(`경고  ${w.where}: ${w.msg}`);
  console.log(`— 오류 ${errors.length}, 경고 ${warnings.length}`);
};
const die = (m) => { console.error(m); process.exit(1); };

switch (cmd) {
  case 'validate': {
    if (!args[0]) die('사용법: validate <db.json>');
    const r = DefDB.validate(loadDB(args[0]));
    printIssues(r);
    process.exit(r.errors.length ? 1 : 0);
  }
  case 'merge': {
    if (args.length < 2) die('사용법: merge <db.json> <patch.json...> [--dry]');
    let db = loadDB(args[0]);
    for (const p of args.slice(1)) {
      const { db: next, report } = DefDB.ingest(db, readJSON(p));
      console.log(`${p}: 추가 ${report.added.length}, 수정 ${report.updated.length}, 삭제 ${report.removed.length}`);
      for (const [a, b] of Object.entries(report.idmap)) console.log(`  ${a} → ${b}`);
      for (const m of report.problems) console.log('  문제: ' + m);
      db = next;
    }
    const r = DefDB.validate(db);
    printIssues(r);
    if (r.errors.length) die('오류가 있어 저장하지 않았습니다.');
    if (flags.dry) console.log('(--dry: 저장하지 않음)');
    else { writeFileSync(args[0], JSON.stringify(db, null, 2) + '\n'); console.log('저장: ' + args[0]); }
    break;
  }
  case 'context': {
    if (args.length < 2) die('사용법: context <db.json> <피정의항|정의항id> [--up N] [--down N]');
    console.log(DefDB.contextText(loadDB(args[0]), args[1], { up: +(flags.up || 4), down: +(flags.down || 1) }));
    break;
  }
  case 'prompt': {
    if (!args[0]) die('사용법: prompt <db.json> [자료.txt]');
    console.log(DefDB.promptText(loadDB(args[0]), { material: args[1] ? readFileSync(args[1], 'utf8') : '' }));
    break;
  }
  case 'migrate': {
    if (!args.length) die('사용법: migrate <bionote-v3.json...>');
    console.log(JSON.stringify(DefDB.fromV3(args.map(readJSON)), null, 2));
    break;
  }
  default:
    die('명령: validate | merge | context | prompt | migrate  (파일 맨 위 주석 참고)');
}
