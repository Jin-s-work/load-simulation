// Phase 09 최종 검증 시나리오.
//
// 세 가지를 각각 다른 것을 보려고 만든다.
//   soak     1000 RPS 를 10분. 처리량이 아니라 **시간에 따른 열화**를 본다(메모리 누수).
//   spike    0 -> 2000 RPS 계단. 탄력성.
//   fault    1000 RPS 유지 중 앱 1대를 죽인다. 장애 내성.
//
// 기존 lb-test.js 는 90초 단발이라 이 셋을 담을 수 없어 따로 만들었다.
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { reservationRequest, compactSummary } from './lib.js';

const MODE = __ENV.MODE || 'soak';
const RATE = Number(__ENV.RATE || 1000);
const LABEL = __ENV.LABEL || MODE;

const served = {};
for (let i = 1; i <= 6; i += 1) served[`app${i}`] = new Counter(`served_app${i}`);
served.unknown = new Counter('served_unknown');

const errs = {
  noResponse: new Counter('err_no_response'),
  e502: new Counter('err_502_bad_gateway'),
  e503: new Counter('err_503_unavailable'),
  e504: new Counter('err_504_timeout'),
  soldOut: new Counter('err_409_sold_out'),   // 정상 거절
  other: new Counter('err_other'),
};
const okTrend = new Trend('ok_duration', true);

// 202 는 성공이다. Phase 08 에서 이걸 빼먹어 실패율 100% 로 오집계했었다.
http.setResponseCallback(http.expectedStatuses(200, 201, 202));

const WARMUP_SEC = Number(__ENV.WARMUP_SEC || 30);

function scenarios() {
  if (MODE === 'soak') {
    // 10분 유지. 워밍업을 길게 잡아 JIT/커넥션/캐시가 자리를 잡은 뒤부터 재도록 한다.
    return {
      soak: {
        executor: 'constant-arrival-rate',
        rate: RATE, timeUnit: '1s',
        duration: `${Number(__ENV.SOAK_MIN || 10)}m`,
        preAllocatedVUs: 600, maxVUs: 3000,
        exec: 'reserve', tags: { phase: 'soak' }, gracefulStop: '15s',
      },
    };
  }
  if (MODE === 'spike') {
    // 0 -> 2000 계단. ramping 이 아니라 계단으로 올려야 "순간 유입" 이 된다.
    return {
      spike: {
        executor: 'ramping-arrival-rate',
        startRate: 0, timeUnit: '1s',
        preAllocatedVUs: 800, maxVUs: 4000,
        stages: [
          { target: 0, duration: '20s' },      // 바닥
          { target: 2000, duration: '1s' },    // ★ 순간 상승
          { target: 2000, duration: '60s' },   // 유지
          { target: 0, duration: '1s' },       // 순간 하강
          { target: 0, duration: '40s' },      // 회복 관찰
        ],
        exec: 'reserve', tags: { phase: 'spike' }, gracefulStop: '15s',
      },
    };
  }
  // fault: 1000 RPS 를 유지하는 동안 밖에서 앱 1대를 죽인다.
  return {
    fault: {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s',
      duration: `${Number(__ENV.FAULT_SEC || 180)}s`,
      preAllocatedVUs: 600, maxVUs: 3000,
      exec: 'reserve', tags: { phase: 'fault' }, gracefulStop: '15s',
    },
  };
}

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // url 을 빼지 않으면 이벤트 1000개 × 지표마다 시계열이 생겨 Prometheus 가 죽는다.
  // Phase 07 에서 실제로 OOM 났다(시계열 154만).
  systemTags: ['proto', 'status', 'method', 'scenario', 'name', 'group', 'check', 'error_code'],
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 100, timeUnit: '1s', duration: `${WARMUP_SEC}s`,
      preAllocatedVUs: 100, maxVUs: 400,
      exec: 'reserve', tags: { phase: 'warmup' }, gracefulStop: '5s',
    },
    ...Object.fromEntries(Object.entries(scenarios()).map(([k, v]) => [
      k, { ...v, startTime: `${WARMUP_SEC + 5}s` },
    ])),
  },
};

export function reserve() {
  const { url, body, params } = reservationRequest();
  const res = http.post(url, body, params);

  const who = res.headers['X-Served-By'];
  (served[who] ?? served.unknown).add(1);

  const s = res.status;
  if (s === 200 || s === 201 || s === 202) okTrend.add(res.timings.duration);
  else if (s === 0) errs.noResponse.add(1);
  else if (s === 502) errs.e502.add(1);
  else if (s === 503) errs.e503.add(1);
  else if (s === 504) errs.e504.add(1);
  else if (s === 409) errs.soldOut.add(1);
  else errs.other.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const c = (n) => (m[n] ? m[n].values.count : 0);
  const inst = [1, 2, 3, 4, 5, 6].map((i) => c(`served_app${i}`));
  const su = c('served_unknown');
  const stot = inst.reduce((a, b) => a + b, 0) + su || 1;
  const pct = (v) => `${((v / stot) * 100).toFixed(1)}%`;

  const extra = [
    '인스턴스별 분배:',
    ...inst.map((v, i) => (v > 0 ? `  app${i + 1} ${String(v).padStart(8)}  (${pct(v)})` : ''))
      .filter(Boolean),
    su ? `  미상 ${String(su).padStart(8)}  (${pct(su)})` : '',
    '',
    '에러 분해:',
    `  status 0 (응답 없음)  ${c('err_no_response')}`,
    `  502 Bad Gateway       ${c('err_502_bad_gateway')}`,
    `  503 Unavailable       ${c('err_503_unavailable')}`,
    `  504 Gateway Timeout   ${c('err_504_timeout')}`,
    `  409 매진(정상 거절)   ${c('err_409_sold_out')}`,
    `  기타                  ${c('err_other')}`,
  ].filter(Boolean).join('\n');

  return {
    stdout: `${compactSummary(data, LABEL)}\n${extra}\n`,
    [`/results/${LABEL}.json`]: JSON.stringify({
      label: LABEL, mode: MODE, rate: RATE,
      served: Object.fromEntries([...inst.map((v, i) => [`app${i + 1}`, v]), ['unknown', su]]),
    }, null, 2),
  };
}
