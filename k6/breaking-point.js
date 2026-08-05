// Phase 01 주 시나리오: open model 로 RPS 를 계단식으로 올려 breaking point 를 찾는다.
//
// ramping-arrival-rate 를 쓰는 이유:
//   VU 기반(closed model)은 서버가 느려지면 부하도 같이 줄어든다. 무너지는 지점을 찾으려는
//   바로 그 순간에 부하가 스스로 물러나서, 느린 구간이 표본에서 빠진다(coordinated omission).
//   arrival-rate 는 도착률을 고정하고, 못 보낸 요청을 dropped_iterations 로 정직하게 드러낸다.
import http from 'k6/http';
import { compactSummary, recordStatus, reservationRequest } from './lib.js';

const STEPS = (__ENV.STEPS || '100,200,400,600,800,1000,1200').split(',').map(Number);
const STEP_HOLD = Number(__ENV.STEP_HOLD || 60);
const STEP_RAMP = Number(__ENV.STEP_RAMP || 5);
const WARMUP_RATE = Number(__ENV.WARMUP_RATE || 50);
const WARMUP_SEC = Number(__ENV.WARMUP_SEC || 60);
const GAP_SEC = 10;
// VU 상한. 도착률을 유지하려면 지연이 늘수록 VU 가 더 필요하다.
// 상한에 걸리면 k6 가 스스로 부하를 줄이므로(= closed model 과 같은 함정),
// SLO(200ms)의 4~5배 지연까지는 버틸 만큼 잡는다. 대신 dropped_iterations 를 항상 같이 본다.
const MAX_VUS = Number(__ENV.MAX_VUS || 900);

const stages = [];
for (const rate of STEPS) {
  stages.push({ target: rate, duration: `${STEP_RAMP}s` });
  stages.push({ target: rate, duration: `${STEP_HOLD}s` });
}

// 409(SOLD_OUT)는 기준선에서 나오면 안 된다(재고를 크게 잡았다).
// 200/201 만 정상으로 보고 나머지는 전부 실패로 집계한다.
http.setResponseCallback(http.expectedStatuses(200, 201));

export const options = {
  discardResponseBodies: true, // 생성기 CPU/메모리를 아낀다. 우리는 상태코드만 본다.
  // Phase 02 에서 이 사다리를 HTTPS 로도 쓴다. 자체서명이라 검증을 건너뛴다.
  insecureSkipTLSVerify: true,
  // NO_REUSE=1 이면 요청마다 새 커넥션 -> 핸드쉐이크 강제
  noConnectionReuse: __ENV.NO_REUSE === '1',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    // 워밍업은 별도 시나리오로 분리하고 phase 태그를 달아 분석에서 제외한다.
    // 첫 요청들은 커넥션 풀이 비어 있고, PG shared_buffers 가 차갑고, V8 이 최적화 전이다.
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RATE,
      timeUnit: '1s',
      duration: `${WARMUP_SEC}s`,
      preAllocatedVUs: 50,
      maxVUs: 200,
      exec: 'reserve',
      tags: { phase: 'warmup' },
      gracefulStop: '5s',
    },
    steps: {
      executor: 'ramping-arrival-rate',
      startTime: `${WARMUP_SEC + GAP_SEC}s`,
      startRate: 0,
      timeUnit: '1s',
      stages,
      preAllocatedVUs: 100,
      maxVUs: MAX_VUS,
      exec: 'reserve',
      tags: { phase: 'steady' },
      gracefulStop: '10s',
    },
  },
  // 목표 SLO. breaking point 테스트라 뒤쪽 계단에서 깨지는 게 정상이며,
  // 임계값 실패로 k6 가 exit 99 를 반환해도 실험 실패가 아니다.
  thresholds: {
    'http_req_duration{phase:steady}': ['p(99)<200'],
    'http_req_failed{phase:steady}': ['rate<0.001'],
  },
};

export function reserve() {
  const { url, body, params } = reservationRequest();
  const res = http.post(url, body, params);
  recordStatus(res);
}

export function handleSummary(data) {
  // 계단별 분석은 Prometheus 시간창으로 한다. 여기서는 오프셋만 남긴다.
  const schedule = [];
  let t = WARMUP_SEC + GAP_SEC;
  for (const rate of STEPS) {
    const holdStart = t + STEP_RAMP;
    schedule.push({ rate, rampStart: t, holdStart, holdEnd: holdStart + STEP_HOLD });
    t = holdStart + STEP_HOLD;
  }

  const out = compactSummary(data, 'breaking-point (open model / ramping-arrival-rate)');
  const plan = [
    '계단 일정 (테스트 시작 기준 초):',
    ...schedule.map(
      (s) => `  ${String(s.rate).padStart(5)} RPS : 유지구간 ${s.holdStart}s ~ ${s.holdEnd}s`,
    ),
    '  * 분석은 각 유지구간의 뒤쪽만 본다. 램프 구간은 정상 상태가 아니다.',
    '',
  ].join('\n');

  // LABEL 로 파일명을 나눈다. 예전엔 항상 breaking-point.json 에 써서
  // 다른 실험 결과와 덮어쓰기/혼동이 났다.
  const label = __ENV.LABEL || 'breaking-point';

  const hs = data.metrics.http_req_tls_handshaking;
  const tlsLine = hs && hs.values.avg > 0
    ? `TLS 핸드쉐이크 avg=${hs.values.avg.toFixed(2)}ms p99=${hs.values['p(99)'].toFixed(2)}ms  <- 핸드쉐이크가 실제로 발생함\n`
    : 'TLS 핸드쉐이크 없음 (평문이거나 커넥션 재사용 중)\n';

  return {
    stdout: out + tlsLine + '\n' + plan,
    [`/results/${label}.json`]: JSON.stringify(
      { schedule, warmupSec: WARMUP_SEC, gapSec: GAP_SEC, metrics: data.metrics },
      null,
      2,
    ),
  };
}
