// 측정 전에 반드시 먼저 돌리는 스크립트.
//
// 목적 두 가지:
//   1) k6(부하 생성기)가 목표 RPS 의 3~5배를 만들 수 있는지 증명한다.
//      못 만들면 이후 모든 숫자는 서버가 아니라 k6 를 잰 것이다.
//   2) DB 를 타지 않는 라우트로 앱 단독(단일 프로세스) 처리량 천장을 잰다.
//
// 한계: k6 와 앱이 같은 VM 안에 있으므로 CPU 를 나눠 쓴다.
// 여기서 무너지면 "k6 한계"인지 "앱 한계"인지 이 스크립트만으로는 구분되지 않는다.
// 반드시 컨테이너별 CPU(docker stats / process_cpu_seconds_total)와 함께 판단한다.
import http from 'k6/http';
import { BASE_URL, compactSummary, recordStatus } from './lib.js';

const STEPS = (__ENV.STEPS || '500,1000,2000,3000,4000,5000').split(',').map(Number);
const STEP_HOLD = Number(__ENV.STEP_HOLD || 20);
const STEP_RAMP = Number(__ENV.STEP_RAMP || 3);
const MAX_VUS = Number(__ENV.MAX_VUS || 600);

const stages = [];
for (const rate of STEPS) {
  stages.push({ target: rate, duration: `${STEP_RAMP}s` });
  stages.push({ target: rate, duration: `${STEP_HOLD}s` });
}

http.setResponseCallback(http.expectedStatuses(200));

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '15s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      exec: 'ping',
      tags: { phase: 'warmup' },
      gracefulStop: '3s',
    },
    steps: {
      executor: 'ramping-arrival-rate',
      startTime: '20s',
      startRate: 0,
      timeUnit: '1s',
      stages,
      preAllocatedVUs: 100,
      maxVUs: MAX_VUS,
      exec: 'ping',
      tags: { phase: 'steady' },
      gracefulStop: '5s',
    },
  },
};

export function ping() {
  const res = http.get(`${BASE_URL}/_sanity`);
  recordStatus(res);
}

export function handleSummary(data) {
  const schedule = [];
  let t = 20;
  for (const rate of STEPS) {
    const holdStart = t + STEP_RAMP;
    schedule.push({ rate, holdStart, holdEnd: holdStart + STEP_HOLD });
    t = holdStart + STEP_HOLD;
  }
  return {
    stdout:
      compactSummary(data, 'generator-sanity (DB 미사용 라우트)') +
      [
        '계단 일정 (테스트 시작 기준 초):',
        ...schedule.map(
          (s) => `  ${String(s.rate).padStart(5)} RPS : 유지구간 ${s.holdStart}s ~ ${s.holdEnd}s`,
        ),
        '',
      ].join('\n'),
    '/results/generator-sanity.json': JSON.stringify(
      { schedule, metrics: data.metrics },
      null,
      2,
    ),
  };
}
