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
// Phase 06 에서 앱이 6대까지 늘어난다. 3대까지만 세면 app4~6 이 전부
// unknown 으로 잡혀 "미상 100%" 라는 잘못된 그림이 나온다.
const served = {
  app1: new Counter('served_app1'),
  app2: new Counter('served_app2'),
  app3: new Counter('served_app3'),
  app4: new Counter('served_app4'),
  app5: new Counter('served_app5'),
  app6: new Counter('served_app6'),
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
  // ★ url 을 시스템 태그에서 뺀다.
  //   k6 는 기본으로 요청 URL 을 라벨로 붙이는데, 이벤트가 1000개라
  //   지표 하나당 수만 개의 시계열이 만들어진다(실측: url 라벨 값 1,001개,
  //   지표당 41,443 시계열, 총 154만). remote-write 로 그게 그대로 Prometheus 에 간다.
  //   Phase 07 에서 이것 때문에 Prometheus 가 OOM 으로 죽었다(exit 137).
  //   name 은 lib.js 에서 'reservation' 으로 고정했으므로 라우트 구분은 유지된다.
  systemTags: ['proto', 'status', 'method', 'scenario', 'name', 'group', 'check', 'error_code'],
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

  const inst = [1, 2, 3, 4, 5, 6].map((i) => c(`served_app${i}`));
  const su = c('served_unknown');
  const stot = inst.reduce((a, b) => a + b, 0) + su || 1;
  const pct = (v) => `${((v / stot) * 100).toFixed(1)}%`;

  const extra = [
    '인스턴스별 분배:',
    // 안 뜬 인스턴스(0건)는 출력하지 않는다. 3대 구성에서 app4~6 이 0 으로
    // 줄줄이 나오면 표가 지저분해지고 "죽은 서버"처럼 오해된다.
    ...inst.map((v, i) => (v > 0 ? `  app${i + 1} ${String(v).padStart(7)}  (${pct(v)})` : ''))
      .filter(Boolean),
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
        served: Object.fromEntries([...inst.map((v, i) => [`app${i + 1}`, v]), ['unknown', su]]),
        metrics: data.metrics,
      },
      null,
      2,
    ),
  };
}
