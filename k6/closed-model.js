// 대조군: 같은 서버에 closed model(ramping-vus)로 부하를 준다.
//
// 이 스크립트의 목적은 서버를 재는 게 아니라 **측정 방법이 결과를 어떻게 바꾸는지**를 보는 것이다.
// breaking-point.js 와 나란히 놓고 비교한다.
//
// 예상되는 차이 (실측으로 확인할 것):
//   - VU 를 아무리 올려도 RPS 가 어느 지점에서 더 이상 안 오른다. RPS 는 입력이 아니라
//     VU/응답시간의 결과값이기 때문이다.
//   - 서버가 느려질수록 부하가 자동으로 줄어드는 탓에, 도착률을 고정했을 때보다
//     지연 분포가 낙관적으로 나올 수 있다(coordinated omission).
import http from 'k6/http';
import { compactSummary, recordStatus, reservationRequest } from './lib.js';

const VU_STEPS = (__ENV.VU_STEPS || '25,50,100,200,400,800').split(',').map(Number);
const STEP_HOLD = Number(__ENV.STEP_HOLD || 60);
const STEP_RAMP = Number(__ENV.STEP_RAMP || 5);

const stages = [];
for (const vus of VU_STEPS) {
  stages.push({ target: vus, duration: `${STEP_RAMP}s` });
  stages.push({ target: vus, duration: `${STEP_HOLD}s` });
}
stages.push({ target: 0, duration: '5s' });

http.setResponseCallback(http.expectedStatuses(200, 201));

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    warmup: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      exec: 'reserve',
      tags: { phase: 'warmup' },
      gracefulStop: '5s',
    },
    steps: {
      executor: 'ramping-vus',
      startTime: '70s',
      startVUs: 0,
      stages,
      exec: 'reserve',
      tags: { phase: 'steady' },
      gracefulRampDown: '5s',
    },
  },
};

export function reserve() {
  const { url, body, params } = reservationRequest();
  const res = http.post(url, body, params);
  recordStatus(res);
}

export function handleSummary(data) {
  const schedule = [];
  let t = 70;
  for (const vus of VU_STEPS) {
    const holdStart = t + STEP_RAMP;
    schedule.push({ vus, holdStart, holdEnd: holdStart + STEP_HOLD });
    t = holdStart + STEP_HOLD;
  }
  return {
    stdout:
      compactSummary(data, 'closed-model 대조군 (ramping-vus)') +
      [
        '계단 일정 (테스트 시작 기준 초):',
        ...schedule.map(
          (s) => `  ${String(s.vus).padStart(4)} VU : 유지구간 ${s.holdStart}s ~ ${s.holdEnd}s`,
        ),
        '  * VU 는 동시성이지 RPS 가 아니다. 실제 RPS 는 Prometheus 에서 확인한다.',
        '',
      ].join('\n'),
    '/results/closed-model.json': JSON.stringify({ schedule, metrics: data.metrics }, null, 2),
  };
}
