// Phase 02: 고정 부하로 "요청 하나당 서버 CPU 비용"을 잰다.
//
// 왜 계단(breaking point)이 아니라 고정 부하인가:
//   구성이 5가지라 매번 사다리를 타면 한 시간이 넘고, 무엇보다 포화 구간에서는
//   요청이 큐에 쌓여서 "요청당 CPU"를 깨끗하게 잴 수 없다.
//   Phase 01 에서 "CPU 예산 ÷ 요청당 CPU = 처리량 천장" 모델이 실측과 맞는 것을
//   확인했으므로(518µs -> 예측 1930, 실측 2000), 여기서는 천장보다 한참 낮은 고정 부하로
//   요청당 CPU 만 정확히 재고 천장은 그 모델로 환산한다. 환산값은 마지막에 사다리 1회로 검증한다.
//
// BASE_URL 로 대상만 바꿔가며 같은 스크립트를 재사용한다:
//   http://app:3000      평문 직결
//   https://app:3000     앱이 직접 TLS 종료
//   http://nginx:8080    프록시 홉만 (TLS 없음)
//   https://nginx:8443   프록시가 TLS 종료
import http from 'k6/http';
import { compactSummary, recordStatus, reservationRequest } from './lib.js';

const RATE = Number(__ENV.RATE || 300);
const DURATION = __ENV.DURATION || '90s';
const WARMUP_RATE = Number(__ENV.WARMUP_RATE || 50);
const WARMUP_SEC = Number(__ENV.WARMUP_SEC || 30);
const GAP_SEC = 10;

// NO_REUSE=1 이면 keep-alive 를 끈다 -> 요청마다 TCP+TLS 핸드쉐이크를 새로 한다.
// 이 스위치 하나가 이번 Phase 의 핵심 변수다.
const NO_REUSE = __ENV.NO_REUSE === '1';

http.setResponseCallback(http.expectedStatuses(200, 201));

export const options = {
  discardResponseBodies: true,
  // 자체서명 인증서라 검증을 건너뛴다.
  // 실제 서비스라면 절대 하면 안 되는 설정이고, 실험용이라 쓰는 것이다.
  insecureSkipTLSVerify: true,
  noConnectionReuse: NO_REUSE,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RATE,
      timeUnit: '1s',
      duration: `${WARMUP_SEC}s`,
      preAllocatedVUs: 50,
      maxVUs: 300,
      exec: 'reserve',
      tags: { phase: 'warmup' },
      gracefulStop: '5s',
    },
    steady: {
      executor: 'constant-arrival-rate',
      startTime: `${WARMUP_SEC + GAP_SEC}s`,
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // 핸드쉐이크를 강제하면 요청 하나가 오래 걸리므로 VU 가 더 필요하다.
      preAllocatedVUs: 200,
      maxVUs: Number(__ENV.MAX_VUS || 900),
      exec: 'reserve',
      tags: { phase: 'steady' },
      gracefulStop: '10s',
    },
  },
};

export function reserve() {
  const { url, body, params } = reservationRequest();
  const res = http.post(url, body, params);
  recordStatus(res);
}

export function handleSummary(data) {
  const m = data.metrics;
  const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : 'n/a');
  const hs = m.http_req_tls_handshaking;
  const conn = m.http_req_connecting;

  const label = __ENV.LABEL || 'tls-fixed';

  const extra = [
    'TLS / 커넥션 비용 분해:',
    hs
      ? `  TLS 핸드쉐이크  avg=${n(hs.values.avg)}ms p95=${n(hs.values['p(95)'])}ms `
        + `p99=${n(hs.values['p(99)'])}ms max=${n(hs.values.max)}ms`
      : '  TLS 핸드쉐이크  (없음 = 평문이거나 커넥션 재사용)',
    conn
      ? `  TCP 연결        avg=${n(conn.values.avg)}ms p95=${n(conn.values['p(95)'])}ms`
      : '  TCP 연결        (없음)',
    `  커넥션 재사용   ${NO_REUSE ? '끔 (요청마다 새 핸드쉐이크)' : '켬 (핸드쉐이크 거의 없음)'}`,
    `  대상            ${__ENV.BASE_URL || 'http://app:3000'}`,
    `  고정 도착률     ${RATE} RPS / ${DURATION}`,
    '',
    '  * 핸드쉐이크 시간은 "서버 CPU 비용"이 아니라 "클라이언트가 기다린 시간"이다.',
    '    서버 CPU 는 Prometheus 의 process_cpu_seconds_total 로 따로 본다.',
    '',
  ].join('\n');

  return {
    stdout: compactSummary(data, `${label} (${NO_REUSE ? 'no-reuse' : 'keep-alive'})`) + extra,
    [`/results/${label}.json`]: JSON.stringify(
      {
        schedule: [{ rate: RATE, holdStart: WARMUP_SEC + GAP_SEC, holdEnd: WARMUP_SEC + GAP_SEC + parseInt(DURATION, 10) }],
        label,
        baseUrl: __ENV.BASE_URL,
        noReuse: NO_REUSE,
        metrics: data.metrics,
      },
      null,
      2,
    ),
  };
}
