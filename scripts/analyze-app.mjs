#!/usr/bin/env node
// Phase 04 분석기.
//
// 보고 싶은 것:
//   - 이벤트 루프 지연과 p99 의 상관 (실험 a)
//   - GC 일시정지와 p99 꼬리의 관계 (실험 b)
//   - 리틀의 법칙 계산값 vs 실측 in-flight (실험 c/d)
//   - 거절(shed)/타임아웃 카운터 (개선 실험)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/api/v1/events/:eventId/reservations';
const SKIP_HEAD = Number(process.env.SKIP_HEAD || 20);
const SKIP_TAIL = Number(process.env.SKIP_TAIL || 3);

// 앱 지표 선택자.
// 단일 프로세스: job="app" (포트 3000)
// 클러스터:     job="app_worker" (워커별 포트 3011+)
// ★ 둘 다 합치면 안 된다. 클러스터일 때 3000 스크레이프는 아무 워커 하나를 잡으므로
//   app_worker 와 겹쳐 이중 계산된다. 실제로 CPU 가 상한 1.0 을 넘는 1.62 로 나왔었다.
const appSelector = (workers) => (workers > 1 ? 'job="app_worker"' : 'job="app"');

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

const f = (v, d = 1, s = 1) => (v === null || v === undefined ? '—' : (v * s).toFixed(d));

async function measure(name) {
  const metaPath = path.join(ROOT, 'results', `${name}.meta.json`);
  const sumPath = path.join(ROOT, 'results', `${name}.json`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(sumPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
  const s = sum.schedule[0];
  const from = meta.startEpoch + s.holdStart + SKIP_HEAD;
  const to = meta.startEpoch + s.holdEnd - SKIP_TAIL;
  const w = Math.max(1, to - from);
  const at = to;
  const r = `route="${ROUTE}"`;
  const APP = appSelector(meta.workers ?? 1);

  const [ok, p50, p99, inflightMax, inflightAvg, lagAvg, lagMax,
    gcSum, heapMax, cpuAvg, shed, timeouts] = await Promise.all([
    q(`sum(increase(http_request_duration_seconds_count{${r},status=~"2.."}[${w}s]))`, at),
    q(`histogram_quantile(0.50, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`max_over_time(sum(http_requests_in_flight{${APP}})[${w}s:1s])`, at),
    q(`avg_over_time(sum(http_requests_in_flight{${APP}})[${w}s:1s])`, at),
    q(`avg_over_time(sum(app_event_loop_lag_ms{${APP}})[${w}s:1s])`, at),
    q(`max_over_time(sum(app_event_loop_lag_ms{${APP}})[${w}s:1s])`, at),
    // GC 에 쓴 총 시간(초). 구간 길이로 나누면 "1초 중 몇 초를 GC 에 썼나" 가 된다.
    q(`sum(increase(nodejs_gc_duration_seconds_sum{${APP}}[${w}s]))`, at),
    q(`max_over_time(sum(nodejs_heap_size_used_bytes{${APP}})[${w}s:2s])`, at),
    q(`avg_over_time(sum(rate(process_cpu_seconds_total{${APP}}[15s]))[${w}s:5s])`, at),
    q(`sum(increase(app_shed_total{${APP}}[${w}s]))`, at),
    q(`sum(increase(app_request_timeout_total{${APP}}[${w}s]))`, at),
  ]);

  const okRps = ok === null ? null : ok / w;
  // 리틀의 법칙: L = λ × W  (λ=성공 처리율, W=평균 체류시간)
  // 실측 in-flight 와 비교하면 "큐에 얼마나 쌓였는지"가 드러난다.
  const littleL = okRps !== null && p50 !== null ? okRps * p50 : null;

  return {
    name, meta, w, okRps, p50, p99,
    inflightMax, inflightAvg, lagAvg, lagMax,
    gcRatio: gcSum === null ? null : gcSum / w,
    heapMax, cpuAvg, shed, timeouts, littleL,
  };
}

const names = process.argv.slice(2);
const rows = [];
for (const n of names) { const m = await measure(n); if (m) rows.push(m); }

const out = [
  '### Phase 04 앱서버 한계 측정',
  '',
  `유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외.`,
  '',
  '| 실험 | 주입 | **성공 RPS** | p50 | p99 | **루프지연 avg/max** | **GC 점유율** | 힙 max | 앱 CPU | in-flight avg/max | **리틀 L 계산** | 거절 | 타임아웃 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((x) => [
    x.name,
    `cpu${x.meta.cpuBurnMs}ms${x.meta.cpuBurnAsync ? '(async)' : ''} alloc${x.meta.allocKb}KB w${x.meta.workers}`,
    f(x.okRps, 1),
    `${f(x.p50, 0, 1000)}ms`,
    `${f(x.p99, 0, 1000)}ms`,
    `${f(x.lagAvg, 0)}/${f(x.lagMax, 0)}ms`,
    `${f(x.gcRatio, 1, 100)}%`,
    `${f(x.heapMax, 0, 1 / 1048576)}MB`,
    f(x.cpuAvg, 2),
    `${f(x.inflightAvg, 0)}/${f(x.inflightMax, 0)}`,
    f(x.littleL, 0),
    f(x.shed, 0),
    f(x.timeouts, 0),
  ].join(' | ')).map((b) => `| ${b} |`),
  '',
  '판독:',
  '- **성공 RPS** 는 2xx 만 센다. 거절(503)은 처리량이 아니다.',
  '- **GC 점유율** = 1초 중 GC 에 쓴 시간 비율. 이게 높으면 그만큼 요청을 못 처리한다.',
  '- **리틀 L** = 성공RPS × p50. 실측 in-flight 와 비교한다.',
  '  in-flight 가 계산값보다 훨씬 크면 그 차이가 곧 "대기만 하고 있는 요청" 이다.',
].join('\n');

console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'phase04-summary.md'), `${out}\n`);
