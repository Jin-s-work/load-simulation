// Phase 03: 로드밸런서 실험용 고정 부하 스크립트.
//
// Phase 02 의 tls-fixed.js 와 같은 뼈대지만 두 가지가 다르다:
//   1) X-Served-By 헤더로 어느 인스턴스가 처리했는지 센다 -> 분배가 실제로 되는지 확인
//   2) 에러를 종류별로 나눈다 -> LB 계층은 5xx 뿐 아니라 "응답 자체가 없음"으로도 실패한다
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, compactSummary, reservationRequest } from './lib.js';

const RATE = Number(__ENV.RATE || 900);
const DURATION = __ENV.DURATION || '90s';
const WARMUP_RATE = Number(__ENV.WARMUP_RATE || 100);
const WARMUP_SEC = Number(__ENV.WARMUP_SEC || 20);
const GAP_SEC = 5;
const NO_REUSE = __ENV.NO_REUSE === '1';
const LABEL = __ENV.LABEL || 'lb-test';

// 인스턴스별 처리 건수. LB 알고리즘의 효과가 여기서 그대로 드러난다.
const served = {
  app1: new Counter('served_app1'),
  app2: new Counter('served_app2'),
  app3: new Counter('served_app3'),
  unknown: new Counter('served_unknown'),
};

// LB 계층의 실패는 종류가 다양하다. 뭉뚱그리면 원인을 못 찾는다.
const errs = {
  noResponse: new Counter('err_no_response'),   // status 0: 커넥션 자체가 안 됨
  e502: new Counter('err_502_bad_gateway'),     // LB 는 살아있는데 백엔드가 응답 못 함
  e503: new Counter('err_503_unavailable'),     // 보낼 백엔드가 없음 / 큐 초과
  e504: new Counter('err_504_timeout'),         // 백엔드가 시간 안에 응답 못 함
  other: new Counter('err_other'),
};

const okTrend = new Trend('ok_duration', true);

http.setResponseCallback(http.expectedStatuses(200, 201));

export const options = {
  discardResponseBodies: true,   // 바디는 버려도 헤더는 남는다
  noConnectionReuse: NO_REUSE,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RATE,
      timeUnit: '1s',
      duration: `${WARMUP_SEC}s`,
      preAllocatedVUs: 100,
      maxVUs: 400,
      exec: 'reserve',
      tags: { phase: 'warmup' },
      gracefulStop: '3s',
    },
    steady: {
      executor: 'constant-arrival-rate',
      startTime: `${WARMUP_SEC + GAP_SEC}s`,
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: Number(__ENV.MAX_VUS || 1200),
      exec: 'reserve',
      tags: { phase: 'steady' },
      gracefulStop: '10s',
    },
  },
};

export function reserve() {
  const { url, body, params } = reservationRequest();
  const res = http.post(url, body, params);

  const who = res.headers['X-Served-By'];
  (served[who] ?? served.unknown).add(1);

  const s = res.status;
  if (s === 200 || s === 201) {
    okTrend.add(res.timings.duration);
  } else if (s === 0) errs.noResponse.add(1);
  else if (s === 502) errs.e502.add(1);
  else if (s === 503) errs.e503.add(1);
  else if (s === 504) errs.e504.add(1);
  else errs.other.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const c = (n) => (m[n] ? m[n].values.count : 0);

  const s1 = c('served_app1'); const s2 = c('served_app2');
  const s3 = c('served_app3'); const su = c('served_unknown');
  const stot = s1 + s2 + s3 + su || 1;
  const pct = (v) => `${((v / stot) * 100).toFixed(1)}%`;

  const extra = [
    '인스턴스별 분배:',
    `  app1 ${String(s1).padStart(7)}  (${pct(s1)})`,
    `  app2 ${String(s2).padStart(7)}  (${pct(s2)})`,
    `  app3 ${String(s3).padStart(7)}  (${pct(s3)})`,
    su ? `  미상 ${String(su).padStart(7)}  (${pct(su)})  <- 헤더 없음 = LB 가 응답을 못 만든 요청` : '',
    '',
    '에러 분해:',
    `  status 0 (응답 없음)  ${c('err_no_response')}`,
    `  502 Bad Gateway       ${c('err_502_bad_gateway')}`,
    `  503 Unavailable       ${c('err_503_unavailable')}`,
    `  504 Gateway Timeout   ${c('err_504_timeout')}`,
    `  기타                  ${c('err_other')}`,
    '',
    `대상: ${BASE_URL} · 고정 ${RATE} RPS / ${DURATION} · 커넥션재사용 ${NO_REUSE ? '끔' : '켬'}`,
    '',
  ].filter(Boolean).join('\n');

  return {
    stdout: compactSummary(data, LABEL) + extra,
    [`/results/${LABEL}.json`]: JSON.stringify(
      {
        label: LABEL,
        schedule: [{ rate: RATE, holdStart: WARMUP_SEC + GAP_SEC, holdEnd: WARMUP_SEC + GAP_SEC + parseInt(DURATION, 10) }],
        served: { app1: s1, app2: s2, app3: s3, unknown: su },
        metrics: data.metrics,
      },
      null,
      2,
    ),
  };
}
