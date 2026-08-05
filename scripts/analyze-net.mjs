#!/usr/bin/env node
// Phase 03: 네트워크 상태 캡처(net.csv)를 읽어 실험별로 요약한다.
//
// 이 표가 "무엇이 먼저 반응했는가"에 대한 답이다.
//   tw_ephem 급증        -> 임시 포트 고갈 경로
//   ListenOverflows 증가 -> accept 큐 넘침 (커널이 연결을 조용히 버림)
//   AttemptFails 증가    -> 연결 시도 자체가 실패
//
// 사용: node scripts/analyze-net.mjs <실험이름> [...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLS = ['epoch', 'inuse', 'orphan', 'tw', 'alloc', 'estab',
  'actOpen', 'pasOpen', 'fail', 'lisOvf', 'lisDrop', 'twListen', 'twEphem'];

function read(file) {
  const p = path.join(ROOT, 'results', file);
  if (!fs.existsSync(p)) return null;
  const rows = fs.readFileSync(p, 'utf8').trim().split('\n').slice(1)
    .map((l) => l.split(',').map(Number))
    .filter((r) => r.length >= 11 && Number.isFinite(r[0]))
    .map((r) => (r.length >= COLS.length ? r : [...r, 0, 0]));  // 구버전 12열 캡처 호환
  return rows.length ? rows : null;
}

function summarize(rows) {
  const i = (n) => COLS.indexOf(n);
  const max = (n) => Math.max(...rows.map((r) => r[i(n)]));
  const delta = (n) => rows[rows.length - 1][i(n)] - rows[0][i(n)];
  return {
    samples: rows.length,
    twMax: max('tw'),
    twListenMax: max('twListen'),
    twEphemMax: max('twEphem'),
    inuseMax: max('inuse'),
    actOpen: delta('actOpen'),
    pasOpen: delta('pasOpen'),
    fails: delta('fail'),
    lisOvf: delta('lisOvf'),
    lisDrop: delta('lisDrop'),
  };
}

const names = process.argv.slice(2);
const lines = [
  '| 실험 | 대상 | TIME_WAIT max (총/리슨/임시) | TCP inuse max | 연결 (LB=시도/app=수락) | **연결실패** | **ListenOverflows** | ListenDrops |',
  '|---|---|---|---|---|---|---|---|',
];

for (const name of names) {
  for (const [label, file] of [['HAProxy', `${name}.net.csv`], ['app1', `${name}.app.net.csv`]]) {
    const rows = read(file);
    if (!rows) { lines.push(`| ${name} | ${label} | (캡처 없음 — 컨테이너 미기동) | | | | | |`); continue; }
    const s = summarize(rows);
    lines.push(`| ${name} | ${label} | ${s.twMax} / ${s.twListenMax} / **${s.twEphemMax}** | ${s.inuseMax} | ${label === 'app1' ? s.pasOpen : s.actOpen} | **${s.fails}** | **${s.lisOvf}** | ${s.lisDrop} |`);
  }
}

const out = lines.join('\n');
console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'net-summary.md'), `${out}\n`);
