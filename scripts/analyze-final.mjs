#!/usr/bin/env node
// Phase 09 분석기 — 최종 검증 3종.
//
//   soak   시간에 따른 열화(메모리 누수)를 본다. 처리량이 아니다.
//   spike  0 -> 2000 RPS 에서 큐가 흡수하고 언제 회복하는가
//   fault  앱 1대가 죽었을 때 실패가 몇 초 동안 몇 건 나는가

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/api/v1/events/:eventId/reservations';

const q = async (expr, at) => {
  try {
    const u = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}${at ? `&time=${at}` : ''}`;
    const b = await (await fetch(u)).json();
    const v = Number(b.data?.result?.[0]?.value?.[1]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
};

const f = (v, d = 1, s = 1) => (v === null || v === undefined ? '—' : (v * s).toFixed(d));

function csv(name, suffix) {
  const p = path.join(ROOT, 'results', `${name}.${suffix}.csv`);
  if (!fs.existsSync(p)) return [];
  const L = fs.readFileSync(p, 'utf8').trim().split('\n');
  if (L.length < 2) return [];
  return L.slice(1).map((l) => l.split(',')).filter((r) => Number.isFinite(Number(r[0])));
}

function k6(name) {
  const p = path.join(ROOT, 'results', `${name}.log`);
  if (!fs.existsSync(p)) return {};
  // ★ utf8. latin1 로 읽으면 한글이 깨져 정규식이 전부 안 맞는다 (Phase 08 에서 겪음).
  const t = fs.readFileSync(p, 'utf8');
  const g = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    reqs: g(/요청 수\s*:\s*(\d+)/),
    rps: g(/평균 ([\d.]+) RPS/),
    fail: g(/실패율\s*:\s*([\d.]+)\s*%/),
    p50: g(/med=([\d.]+)ms/),
    p95: g(/p95=([\d.]+)ms/),
    p99: g(/p99=([\d.]+)ms/),
    max: g(/max=([\d.]+)ms/),
    dropped: g(/(\d+) 드롭/),
    soldOut: g(/409 매진\(정상 거절\)\s+(\d+)/),
    noResp: g(/status 0 \(응답 없음\)\s+(\d+)/),
    e502: g(/502 Bad Gateway\s+(\d+)/),
    e503: g(/503 Unavailable\s+(\d+)/),
    e504: g(/504 Gateway Timeout\s+(\d+)/),
    other: g(/기타\s+(\d+)/),
  };
}

/** 선형회귀 기울기. 메모리가 시간에 따라 우상향하는지 보려는 것. */
function slopePerMin(rows, col) {
  const pts = rows.map((r) => [Number(r[0]), Number(r[col])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 5) return null;
  const t0 = pts[0][0];
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + (x - t0), 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxy = pts.reduce((a, [x, y]) => a + (x - t0) * y, 0);
  const sxx = pts.reduce((a, [x]) => a + (x - t0) ** 2, 0);
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  return ((n * sxy - sx * sy) / d) * 60;   // 분당 변화량
}

async function measure(name) {
  const mp = path.join(ROOT, 'results', `${name}.meta.json`);
  if (!fs.existsSync(mp)) return null;
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const w = Math.max(1, meta.endEpoch - meta.startEpoch);
  const at = meta.endEpoch;
  const r = `route="${ROUTE}"`;

  const [p99, inc, dlq, gate] = await Promise.all([
    q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`sum(increase(async_inconsistency_total[${w}s]))`, at),
    q(`sum(increase(mq_dlq_total[${w}s]))`, at),
    q(`sum(increase(stock_gate_rejects_total[${w}s]))`, at),
  ]);

  const mem = csv(name, 'mem');       // ts,app_heap_mb,worker_heap_mb,pg_rssanon_mb
  const mq = csv(name, 'mq');         // ts,messages,ready,unacked,dlq
  const depth = mq.map((x) => Number(x[1])).filter(Number.isFinite);

  const firstLast = (col) => {
    const v = mem.map((x) => Number(x[col])).filter(Number.isFinite);
    return v.length ? [v[0], v[v.length - 1], Math.max(...v)] : [null, null, null];
  };

  return {
    name, meta, w, p99, inc, dlq, gate,
    depthMax: depth.length ? Math.max(...depth) : null,
    depthAvg: depth.length ? depth.reduce((a, b) => a + b, 0) / depth.length : null,
    appHeap: firstLast(1), workerHeap: firstLast(2), pgMem: firstLast(3),
    appSlope: slopePerMin(mem, 1), workerSlope: slopePerMin(mem, 2), pgSlope: slopePerMin(mem, 3),
    k6: k6(name),
  };
}

const rows = [];
for (const n of process.argv.slice(2)) { const m = await measure(n); if (m) rows.push(m); }

const out = [
  '### Phase 09 최종 검증',
  '',
  '구성: 앱 3대(cpus 2.0) + HAProxy(least-conn) + Redis 캐시 + 재고 선점게이트',
  '+ RabbitMQ + 워커 4대 + PgBouncer(transaction) + Postgres 16.',
  '',
  '#### 시나리오별 결과',
  '',
  '| 시나리오 | 요청 수 | k6 RPS | p50 | p95 | **p99** | max | 드롭 | 409 매진 | **진짜 실패** |',
  '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.map((x) => {
    const real = ['noResp', 'e502', 'e503', 'e504', 'other']
      .reduce((a, k) => a + Number(x.k6[k] ?? 0), 0);
    return `| ${[
      x.name, x.k6.reqs ?? '—', x.k6.rps ?? '—',
      x.k6.p50 ? `${x.k6.p50}ms` : '—',
      x.k6.p95 ? `${x.k6.p95}ms` : '—',
      x.k6.p99 ? `${x.k6.p99}ms` : '—',
      x.k6.max ? `${x.k6.max}ms` : '—',
      x.k6.dropped ?? '—', x.k6.soldOut ?? '—',
      `**${real}**`,
    ].join(' | ')} |`;
  }),
  '',
  '> **진짜 실패** = 무응답 + 502 + 503 + 504 + 기타. 409 매진은 정상 거절이므로 뺀다.',
  '',
  '#### 메모리 추이 (누수 확인)',
  '',
  '| 시나리오 | 앱 힙 시작→끝(max) | **앱 기울기** | 워커 힙 시작→끝(max) | **워커 기울기** | PG 사적 시작→끝 |',
  '|---|--:|--:|--:|--:|--:|',
  ...rows.map((x) => `| ${[
    x.name,
    `${f(x.appHeap[0], 1)}→${f(x.appHeap[1], 1)} (${f(x.appHeap[2], 1)})MB`,
    `${x.appSlope === null ? '—' : `${x.appSlope >= 0 ? '+' : ''}${x.appSlope.toFixed(2)}MB/분`}`,
    `${f(x.workerHeap[0], 1)}→${f(x.workerHeap[1], 1)} (${f(x.workerHeap[2], 1)})MB`,
    `${x.workerSlope === null ? '—' : `${x.workerSlope >= 0 ? '+' : ''}${x.workerSlope.toFixed(2)}MB/분`}`,
    `${f(x.pgMem[0], 0)}→${f(x.pgMem[1], 0)}MB`,
  ].join(' | ')} |`),
  '',
  '#### 큐 · 정합성',
  '',
  '| 시나리오 | 큐 depth avg/max | 복구(drain) | 선점 거절 | **202후 DB실패** | DLQ | 최종 예약행 |',
  '|---|--:|--:|--:|--:|--:|--:|',
  ...rows.map((x) => `| ${[
    x.name,
    `${f(x.depthAvg, 0)}/${f(x.depthMax, 0)}`,
    `${x.meta.drainSec}s`,
    f(x.gate, 0),
    `**${f(x.inc, 0)}**`,
    x.meta.dlqMessages,
    x.meta.finalReservations,
  ].join(' | ')} |`),
  '',
  '판독:',
  '- **앱 기울기** 가 0 근처면 누수가 없다. 계속 우상향하면 10분으로는 못 잡는 누수가 있을 수 있다.',
  '- **진짜 실패** 가 0 이면 SLO 의 에러율 조건을 만족한다.',
  '- **202후 DB실패** 는 최종 일관성이 깨진 건수다. 0 이어야 한다.',
].join('\n');

console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'phase09-summary.md'), `${out}\n`);
