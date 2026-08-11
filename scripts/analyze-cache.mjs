#!/usr/bin/env node
// Phase 07 분석기 — 캐시.
//
// 핵심 질문 두 개:
//   ① 캐시가 DB 접촉을 얼마나 줄였나  (캐시의 존재 이유)
//   ② 로컬 캐시는 앱 N대에서 정말 hit ratio 가 낮은가  (로컬 vs Redis 의 갈림길)

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
    if (!res.ok) return null;
    const b = await res.json();
    if (b.status !== 'success' || !b.data.result.length) return null;
    const v = Number(b.data.result[0].value[1]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** 라벨별로 나눠 받는다 (hit/miss 처럼 한 번에 여러 시계열이 오는 경우). */
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
const pct = (a, b) => (a == null || b == null || a + b === 0 ? '—' : `${((a / (a + b)) * 100).toFixed(1)}%`);

function csvRows(name, suffix, from, to) {
  const p = path.join(ROOT, 'results', `${name}.${suffix}.csv`);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1).map((l) => l.split(',').map(Number))
    .filter((r) => r[0] >= from && r[0] <= to);
}

function k6Stats(name) {
  const p = path.join(ROOT, 'results', `${name}.log`);
  if (!fs.existsSync(p)) return {};
  const t = fs.readFileSync(p, 'latin1').replace(/ /g, '');
  const grab = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    rps: grab(/평균 ([\d.]+) RPS/),
    fail: grab(/실패율\s*:\s*([\d.]+)/),
    p50: grab(/med=([\d.]+)ms/),
    p99: grab(/p99=([\d.]+)ms/),
    noResp: grab(/status 0 \(응답 없음\)\s+(\d+)/),
    e503: grab(/503 Unavailable\s+(\d+)/),
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

  const [touch, loads, p99, redisP99, cacheErr, localLk, redisLk] = await Promise.all([
    qBy(`sum by (path) (increase(db_touch_total[${w}s]))`, to, 'path'),
    qBy(`sum by (kind) (increase(cache_loads_total[${w}s]))`, to, 'kind'),
    q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, to),
    q(`histogram_quantile(0.99, sum by (le) (increase(redis_op_duration_seconds_bucket[${w}s])))`, to),
    q(`sum(increase(cache_errors_total[${w}s]))`, to),
    qBy(`sum by (result) (increase(cache_lookups_total{layer="local"}[${w}s]))`, to, 'result'),
    qBy(`sum by (result) (increase(cache_lookups_total{layer="redis"}[${w}s]))`, to, 'result'),
  ]);

  // Redis 자신이 센 keyspace hit/miss. 앱 지표와 교차 검증한다.
  const rr = csvRows(name, 'redis', from, to);
  const redisSelf = rr.length >= 2
    ? { hits: rr[rr.length - 1][1] - rr[0][1], misses: rr[rr.length - 1][2] - rr[0][2] }
    : null;

  const st = csvRows(name, 'stock', from, to);

  return {
    name, meta, w,
    dbWrite: touch.write ?? 0,
    dbShort: touch.short_circuit ?? 0,
    loadDb: loads.db ?? 0,
    loadShared: loads.shared ?? 0,
    p99,
    redisP99,
    cacheErr,
    localHit: localLk.hit, localMiss: localLk.miss,
    redisHit: redisLk.hit, redisMiss: redisLk.miss,
    redisSelf,
    soldOutMax: st.length ? Math.max(...st.map((x) => x[1])) : null,
    k6: k6Stats(name),
  };
}

const names = process.argv.slice(2);
const rows = [];
for (const n of names) { const m = await measure(n); if (m) rows.push(m); }

const base = rows.find((x) => x.name === 'base-zipf') || rows.find((x) => x.name === 'base-uniform');

const out = [
  '### Phase 07 캐시 측정',
  '',
  `유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외. 앱 3대 + HAProxy + PgBouncer, 재고 희소(총 29,000석).`,
  '',
  '#### DB 부하 감소 — 캐시의 존재 이유',
  '',
  '| 실험 | 캐시 | 분포 | **DB 접촉** | **캐시가 끊은 요청** | DB 접촉 비율 | 매진 이벤트 max |',
  '|---|:--|:--|--:|--:|--:|--:|',
  ...rows.map((x) => {
    const total = x.dbWrite + x.dbShort;
    const ratio = total > 0 ? (x.dbWrite / total) * 100 : null;
    return `| ${[
      x.name,
      x.meta.cacheMode,
      x.meta.keyDist,
      f(x.dbWrite, 0),
      f(x.dbShort, 0),
      ratio === null ? '—' : `${ratio.toFixed(1)}%`,
      f(x.soldOutMax, 0),
    ].join(' | ')} |`;
  }),
  '',
  '#### hit ratio — 로컬 vs Redis',
  '',
  '| 실험 | **로컬 hit** | 로컬 hit/miss | **Redis hit** | Redis hit/miss | Redis 자체 집계 | DB 로딩 | singleflight 공유 |',
  '|---|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.filter((x) => x.meta.cacheMode !== 'off').map((x) => `| ${[
    x.name,
    pct(x.localHit, x.localMiss),
    `${f(x.localHit, 0)}/${f(x.localMiss, 0)}`,
    pct(x.redisHit, x.redisMiss),
    `${f(x.redisHit, 0)}/${f(x.redisMiss, 0)}`,
    x.redisSelf ? pct(x.redisSelf.hits, x.redisSelf.misses) : '—',
    f(x.loadDb, 0),
    f(x.loadShared, 0),
  ].join(' | ')} |`),
  '',
  '#### 처리량·지연',
  '',
  '| 실험 | k6 RPS | k6 p50 | k6 p99 | 앱 p99 | Redis p99 | 실패율(=409 포함) | 무응답 | 캐시오류 |',
  '|---|--:|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.map((x) => `| ${[
    x.name,
    x.k6.rps ?? '—',
    x.k6.p50 ? `${x.k6.p50}ms` : '—',
    x.k6.p99 ? `${x.k6.p99}ms` : '—',
    `${f(x.p99, 1, 1000)}ms`,
    `${f(x.redisP99, 2, 1000)}ms`,
    x.k6.fail ? `${x.k6.fail}%` : '—',
    x.k6.noResp ?? '—',
    f(x.cacheErr, 0),
  ].join(' | ')} |`),
  '',
  '판독:',
  '- **DB 접촉** 이 이 Phase 의 주인공이다. 캐시가 끊은 요청(short_circuit)은 DB 를 아예 안 친다.',
  '- **로컬 hit ratio 가 Redis 보다 낮으면** 그게 "앱 N대면 같은 키에 miss 가 N번" 의 증거다.',
  '- **실패율에는 409 SOLD_OUT 이 포함**돼 있다. k6 는 2xx 가 아니면 실패로 세는데,',
  '  매진 거절은 정상 동작이다. 진짜 실패는 "무응답/503" 열을 봐야 한다.',
  '- **singleflight 공유** 가 크면 그만큼의 동시 miss 를 하나로 합친 것이다.',
  base ? `- 기준선(${base.name}) DB 접촉: ${base.dbWrite.toFixed(0)}회` : '',
].filter(Boolean).join('\n');

console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'phase07-summary.md'), `${out}\n`);
