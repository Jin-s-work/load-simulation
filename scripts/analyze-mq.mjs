#!/usr/bin/env node
// Phase 08 분석기 — 쓰기 경로를 큐로 분리.
//
// 핵심 질문:
//   ① 동기 -> 비동기로 p99 와 최대 RPS 가 얼마나 바뀌나
//   ② 스파이크 때 큐가 얼마나 자라고 언제 빠지나 (버퍼링/평탄화)
//   ③ 워커를 늘리면 어디서 DB 가 다시 병목이 되나
//   ④ 중복 메시지를 멱등성이 막는가
//   ⑤ 202 를 준 뒤 DB 에 못 들어간 건이 있나 (최종 일관성)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/api/v1/events/:eventId/reservations';
const SKIP_HEAD = Number(process.env.SKIP_HEAD || 20);
const SKIP_TAIL = Number(process.env.SKIP_TAIL || 3);

async function q(expr, at) {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`);
    const b = await res.json();
    const v = Number(b.data?.result?.[0]?.value?.[1]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

async function qBy(expr, at, label) {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`);
    const b = await res.json();
    const out = {};
    for (const r of b.data?.result ?? []) out[r.metric[label]] = Number(r.value[1]);
    return out;
  } catch { return {}; }
}

const f = (v, d = 1, s = 1) => (v === null || v === undefined ? '—' : (v * s).toFixed(d));

function csvRows(name, suffix) {
  const p = path.join(ROOT, 'results', `${name}.${suffix}.csv`);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => l.split(',').map(Number)).filter((r) => Number.isFinite(r[0]));
}

function k6Stats(name) {
  const p = path.join(ROOT, 'results', `${name}.log`);
  if (!fs.existsSync(p)) return {};
  const t = fs.readFileSync(p, 'latin1');
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    rps: g(/평균 ([\d.]+) RPS/),
    fail: g(/실패율\s*:\s*([\d.]+)\s*%/),
    p50: g(/med=([\d.]+)ms/),
    p99: g(/p99=([\d.]+)ms/),
    dropped: g(/(\d+) 드롭/),
    soldOut: g(/409 매진\(정상 거절\)\s+(\d+)/),
    noResp: g(/status 0 \(응답 없음\)\s+(\d+)/),
    other: g(/기타\s+(\d+)/),
  };
}

async function measure(name) {
  const metaPath = path.join(ROOT, 'results', `${name}.meta.json`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sumPath = path.join(ROOT, 'results', `${name}.json`);

  let from; let to;
  if (fs.existsSync(sumPath)) {
    const s = JSON.parse(fs.readFileSync(sumPath, 'utf8')).schedule[0];
    from = meta.startEpoch + s.holdStart + SKIP_HEAD;
    to = meta.startEpoch + s.holdEnd - SKIP_TAIL;
  } else {
    from = meta.startEpoch + 30 + SKIP_HEAD;
    to = meta.endEpoch - SKIP_TAIL;
  }
  const w = Math.max(1, to - from);
  const r = `route="${ROUTE}"`;

  const [p99, published, consumed, gateRejects, incons, dlq, e2eP99, procP99, dbTouch] =
    await Promise.all([
      q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, to),
      q(`sum(increase(mq_published_total[${w}s]))`, to),
      qBy(`sum by (outcome) (increase(mq_consumed_total[${w}s]))`, to, 'outcome'),
      q(`sum(increase(stock_gate_rejects_total[${w}s]))`, to),
      q(`sum(increase(async_inconsistency_total[${w}s]))`, to),
      q(`sum(increase(mq_dlq_total[${w}s]))`, to),
      q(`histogram_quantile(0.99, sum by (le) (increase(mq_e2e_latency_seconds_bucket[${w}s])))`, to),
      q(`histogram_quantile(0.99, sum by (le) (increase(mq_process_duration_seconds_bucket[${w}s])))`, to),
      qBy(`sum by (path) (increase(db_touch_total[${w}s]))`, to, 'path'),
    ]);

  // 큐 depth: ts,messages,ready,unacked,dlq
  const mq = csvRows(name, 'mq');
  const depth = mq.map((x) => x[1]).filter(Number.isFinite);

  return {
    name, meta, w, p99,
    published, consumed, gateRejects, incons, dlq, e2eP99, procP99,
    dbWrite: dbTouch.write ?? 0, dbShort: dbTouch.short_circuit ?? 0,
    depthMax: depth.length ? Math.max(...depth) : null,
    depthAvg: depth.length ? depth.reduce((a, b) => a + b, 0) / depth.length : null,
    k6: k6Stats(name),
  };
}

const names = process.argv.slice(2);
const rows = [];
for (const n of names) { const m = await measure(n); if (m) rows.push(m); }

const out = [
  '### Phase 08 메시지 큐 측정',
  '',
  `유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외. 앱 3대 + HAProxy + Redis + PgBouncer.`,
  '',
  '#### 동기 vs 비동기',
  '',
  '| 실험 | 모드 | 워커 | 앱cpus | k6 RPS | k6 p50 | **k6 p99** | 앱 p99 | 실패율 | 409 매진 | 드롭 |',
  '|---|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.map((x) => `| ${[
    x.name,
    x.meta.asyncWrite ? '비동기(202)' : '동기(201)',
    x.meta.workers,
    x.meta.appCpus,
    x.k6.rps ?? '—',
    x.k6.p50 ? `${x.k6.p50}ms` : '—',
    x.k6.p99 ? `${x.k6.p99}ms` : '—',
    `${f(x.p99, 1, 1000)}ms`,
    x.k6.fail ? `${x.k6.fail}%` : '—',
    x.k6.soldOut ?? '—',
    x.k6.dropped ?? '—',
  ].join(' | ')} |`),
  '',
  '#### 큐 동작 — depth · 랙 · 복구',
  '',
  '| 실험 | **발행** | **처리** | 큐 depth avg/max | **복구(drain)** | E2E p99 | 워커 처리 p99 | 최종 예약행 |',
  '|---|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.filter((x) => x.meta.asyncWrite).map((x) => {
    const total = Object.values(x.consumed).reduce((a, b) => a + b, 0);
    return `| ${[
      x.name,
      f(x.published, 0),
      f(total, 0),
      `${f(x.depthAvg, 0)}/${f(x.depthMax, 0)}`,
      `${x.meta.drainSec}s`,
      `${f(x.e2eP99, 2)}s`,
      `${f(x.procP99, 1, 1000)}ms`,
      x.meta.finalReservations,
    ].join(' | ')} |`;
  }),
  '',
  '#### 멱등성 · 정합성',
  '',
  '| 실험 | created | **duplicate** | sold_out | error | **선점 거절** | **202후 DB실패** | DLQ |',
  '|---|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.filter((x) => x.meta.asyncWrite).map((x) => `| ${[
    x.name,
    f(x.consumed.created, 0),
    f(x.consumed.duplicate, 0),
    f(x.consumed.sold_out, 0),
    f(x.consumed.error, 0),
    f(x.gateRejects, 0),
    f(x.incons, 0),
    x.meta.dlqMessages,
  ].join(' | ')} |`),
  '',
  '판독:',
  '- **k6 p99** 가 이 Phase 의 주인공이다. 비동기는 발행만 하고 응답하므로 짧아야 한다.',
  '- **큐 depth** 가 스파이크 때 자랐다가 빠지면 MQ 가 버퍼 역할을 한 것이다.',
  '  **복구(drain)** 는 부하가 끝난 뒤 큐가 비는 데 걸린 시간이다.',
  '- **duplicate** 는 at-least-once 의 중복을 UNIQUE 제약이 막은 건수다. 오류가 아니다.',
  '- **202후 DB실패** 가 0 이 아니면 최종 일관성이 깨진 것이다 —',
  '  사용자는 접수됐다고 들었는데 예약이 없다. Redis 선점과 DB 재고가 어긋난 경우다.',
].join('\n');

console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'phase08-summary.md'), `${out}\n`);
