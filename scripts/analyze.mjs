#!/usr/bin/env node
// 계단별 지표를 Prometheus 에서 뽑아 마크다운 표로 출력한다.
//
// 왜 필요한가:
//   k6 요약은 런 전체를 하나로 뭉갠 숫자다. 그걸로는 "몇 RPS 에서 무너졌는지",
//   "무너질 때 무엇이 먼저 포화됐는지"를 알 수 없다.
//   각 계단의 유지구간만 잘라서 앱/풀/DB 지표를 나란히 놓아야 원인 귀속이 된다.
//
// 사용: node scripts/analyze.mjs <breaking-point|generator-sanity|closed-model>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const name = process.argv[2] || 'breaking-point';
const ROUTE =
  name === 'generator-sanity' ? '/_sanity' : '/api/v1/events/:eventId/reservations';

// 유지구간의 앞부분은 큐가 차오르는 중이라 정상 상태가 아니다. 앞 15초를 버린다.
const SKIP_HEAD = Number(process.env.SKIP_HEAD || 15);
const SKIP_TAIL = Number(process.env.SKIP_TAIL || 2);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function q(expr, at) {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  if (body.status !== 'success' || !body.data.result.length) return null;
  const v = Number(body.data.result[0].value[1]);
  return Number.isFinite(v) ? v : null;
}

const fmt = (v, d = 1, scale = 1) => (v === null ? '—' : (v * scale).toFixed(d));

async function analyzeWindow(startEpoch, endEpoch) {
  const w = Math.max(1, endEpoch - startEpoch);
  const at = endEpoch;
  const r = `route="${ROUTE}"`;

  const [
    total, err5xx, err4xx,
    p50, p95, p99,
    inflightMax, poolWaitMax, poolInUseAvg,
    acqP99, txP99,
    cpuAvg, cpuMax, loopP99,
    pgBackends, k6Reqs, k6Dropped,
  ] = await Promise.all([
    q(`sum(increase(http_request_duration_seconds_count{${r}}[${w}s]))`, at),
    q(`sum(increase(http_request_duration_seconds_count{${r},status=~"5.."}[${w}s]))`, at),
    q(`sum(increase(http_request_duration_seconds_count{${r},status=~"4.."}[${w}s]))`, at),
    q(`histogram_quantile(0.50, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`histogram_quantile(0.95, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`max_over_time(http_requests_in_flight[${w}s])`, at),
    q(`max_over_time(db_pool_connections{state="waiting"}[${w}s])`, at),
    q(`avg_over_time(db_pool_connections{state="in_use"}[${w}s])`, at),
    q(`histogram_quantile(0.99, sum by (le) (increase(db_pool_acquire_wait_seconds_bucket[${w}s])))`, at),
    q(`histogram_quantile(0.99, sum by (le) (increase(db_transaction_duration_seconds_bucket[${w}s])))`, at),
    q(`avg_over_time(rate(process_cpu_seconds_total{job=~"app|app_tls"}[10s])[${w}s:5s])`, at),
    q(`max_over_time(rate(process_cpu_seconds_total{job=~"app|app_tls"}[10s])[${w}s:5s])`, at),
    q(`max_over_time(nodejs_eventloop_lag_p99_seconds[${w}s])`, at),
    q(`max_over_time(pg_stat_database_numbackends{datname="lts"}[${w}s])`, at),
    q(`sum(increase(k6_http_reqs_total[${w}s]))`, at),
    q(`sum(increase(k6_dropped_iterations_total[${w}s]))`, at),
  ]);

  return {
    w,
    rps: total === null ? null : total / w,
    errRate: total ? ((err5xx || 0) / total) * 100 : null,
    err5xx, err4xx,
    p50, p95, p99,
    inflightMax, poolWaitMax, poolInUseAvg,
    acqP99, txP99, cpuAvg, cpuMax, loopP99, pgBackends,
    k6Rps: k6Reqs === null ? null : k6Reqs / w,
    k6Dropped,
  };
}

async function main() {
  const meta = readJson(path.join(ROOT, 'results', `${name}.meta.json`));
  const summary = readJson(path.join(ROOT, 'results', `${name}.json`));
  const schedule = summary.schedule;

  const rows = [];
  for (const s of schedule) {
    const from = meta.startEpoch + s.holdStart + SKIP_HEAD;
    const to = meta.startEpoch + s.holdEnd - SKIP_TAIL;
    if (to <= from) continue;
    rows.push({ label: s.rate !== undefined ? `${s.rate} RPS` : `${s.vus} VU`, ...(await analyzeWindow(from, to)) });
  }

  const header = [
    '| 계단 | 실측 RPS | p50 | p95 | p99 | 5xx율 | 4xx수 | in-flight max | 풀 대기 max | 풀 사용 avg | 획득대기 p99 | 트랜잭션 p99 | 앱 CPU avg/max | 루프지연 p99 | PG 백엔드 | k6 드롭 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const body = rows.map((x) =>
    [
      x.label,
      fmt(x.rps, 0),
      `${fmt(x.p50, 1, 1000)}ms`,
      `${fmt(x.p95, 1, 1000)}ms`,
      `${fmt(x.p99, 1, 1000)}ms`,
      `${fmt(x.errRate, 3)}%`,
      fmt(x.err4xx, 0),
      fmt(x.inflightMax, 0),
      fmt(x.poolWaitMax, 0),
      fmt(x.poolInUseAvg, 1),
      `${fmt(x.acqP99, 1, 1000)}ms`,
      `${fmt(x.txP99, 1, 1000)}ms`,
      `${fmt(x.cpuAvg, 2)}/${fmt(x.cpuMax, 2)}`,
      `${fmt(x.loopP99, 1, 1000)}ms`,
      fmt(x.pgBackends, 0),
      fmt(x.k6Dropped, 0),
    ].join(' | '),
  );

  const out = [
    `### ${name} 계단별 측정 (유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외)`,
    '',
    ...header,
    ...body.map((b) => `| ${b} |`),
    '',
    '판독 기준:',
    '- 앱 CPU 가 1.0 에 붙고 루프지연이 커지면 -> 단일 스레드 포화 (앱이 먼저 터짐)',
    '- 풀 대기 max > 0 이고 획득대기 p99 가 커지면 -> 커넥션 풀 고갈 (요청이 DB 앞에서 줄 섬)',
    '- 트랜잭션 p99 만 커지고 획득대기는 작으면 -> DB 자체가 느려짐 (락/디스크/CPU)',
    '- k6 드롭 > 0 이면 -> 도착률 유지 실패. 서버 포화이거나 k6 VU 상한. 앱 CPU 와 같이 봐야 구분됨',
  ].join('\n');

  console.log(out);
  fs.writeFileSync(path.join(ROOT, 'results', `${name}.analysis.md`), `${out}\n`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
