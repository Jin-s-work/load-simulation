// k6 스크립트 공용 헬퍼.
import { Counter } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL || 'http://app:3000';
export const EVENT_COUNT = Number(__ENV.EVENT_COUNT || 1000);

// HOT_RATIO: 부하가 특정 이벤트 하나에 몰리는 비율.
// Phase 01 기준선은 0 (무경합). 락 경합을 켜고 싶으면 0.9 처럼 올린다.
export const HOT_RATIO = Number(__ENV.HOT_RATIO || 0);
export const HOT_EVENT_ID = Number(__ENV.HOT_EVENT_ID || 1);

const RUN_ID = (__ENV.RUN_ID || Date.now().toString(16)).slice(-8).padStart(8, '0');

let seq = 0;

function hex(n, len) {
  return Math.floor(Math.abs(n)).toString(16).slice(-len).padStart(len, '0');
}

/**
 * 이터레이션마다 유일한 멱등키를 만든다.
 * 키가 겹치면 서버가 idempotent_replay 로 응답해서, 우리가 재려던 "쓰기 경로"가 아니라
 * "조회 경로"를 재게 된다. 기준선이 실제보다 좋게 나오는 함정이다.
 *
 * (__VU, seq) 조합은 런 전체에서 유일하다. VU 마다 독립된 JS 런타임이라 seq 가 VU 별로 증가한다.
 */
export function nextIdempotencyKey() {
  seq += 1;
  return [
    RUN_ID,
    hex(__VU, 4),
    hex(seq >> 16, 4),
    hex(seq, 4),
    hex(Date.now(), 12),
  ].join('-');
}

// Phase 07: 트래픽 패턴을 고른다.
//   uniform  1..EVENT_COUNT 균등. 캐시 히트율이 가장 낮게 나오는 조건
//   hot      HOT_RATIO 만큼 한 키에 몰림 (Phase 01~06 이 쓰던 방식)
//   zipf     현실적인 편중. 상위 소수가 대부분의 트래픽을 가져간다
export const KEY_DIST = __ENV.KEY_DIST || (HOT_RATIO > 0 ? 'hot' : 'uniform');
export const ZIPF_S = Number(__ENV.ZIPF_S || 1.1);   // 클수록 편중이 심하다

/**
 * Zipf 분포 샘플러.
 *
 * P(k) ∝ 1/k^s 이다. 매 요청마다 1000개 확률을 계산하면 느리므로,
 * 누적분포(CDF)를 기동 시 한 번만 만들어 두고 이진 탐색으로 뽑는다.
 * (k6 는 VU 마다 독립 런타임이라 이 테이블이 VU 수만큼 생기지만,
 *  1000개 실수 배열이라 무시할 만하다.)
 */
const zipfCdf = (() => {
  if (KEY_DIST !== 'zipf') return null;
  const w = new Array(EVENT_COUNT);
  let sum = 0;
  for (let i = 0; i < EVENT_COUNT; i += 1) {
    sum += 1 / ((i + 1) ** ZIPF_S);
    w[i] = sum;
  }
  for (let i = 0; i < EVENT_COUNT; i += 1) w[i] /= sum;  // 정규화
  return w;
})();

function pickZipf() {
  const r = Math.random();
  let lo = 0; let hi = EVENT_COUNT - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (zipfCdf[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo + 1;   // 이벤트 id 는 1부터
}

export function pickEventId() {
  if (KEY_DIST === 'zipf') return pickZipf();
  if (HOT_RATIO > 0 && Math.random() < HOT_RATIO) return HOT_EVENT_ID;
  return 1 + Math.floor(Math.random() * EVENT_COUNT);
}

// 상태코드 분포를 요약에 남기기 위한 카운터.
// k6 는 기본적으로 상태코드별 집계를 요약에 넣어주지 않는다.
export const statusCounters = {
  200: new Counter('status_200_replay'),
  201: new Counter('status_201_created'),
  409: new Counter('status_409_sold_out'),
  '4xx': new Counter('status_4xx_other'),
  '5xx': new Counter('status_5xx'),
  0: new Counter('status_0_no_response'),
};

export function recordStatus(res) {
  const s = res.status;
  if (s === 200) statusCounters[200].add(1);
  else if (s === 201) statusCounters[201].add(1);
  else if (s === 409) statusCounters[409].add(1);
  else if (s === 0) statusCounters[0].add(1);
  else if (s >= 500) statusCounters['5xx'].add(1);
  else statusCounters['4xx'].add(1);
}

export function reservationRequest() {
  return {
    url: `${BASE_URL}/api/v1/events/${pickEventId()}/reservations`,
    body: JSON.stringify({
      userId: 1 + Math.floor(Math.random() * 1000000),
      quantity: 1,
    }),
    params: {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': nextIdempotencyKey(),
      },
      // ★ name 태그를 고정한다.
      //   이걸 안 주면 k6 는 **URL 전체를 name 라벨로 쓴다.** 이벤트가 1000개라
      //   지표 하나당 시계열이 1000개씩 생기고, remote-write 로 Prometheus 에 밀려간다.
      //   Phase 07 에서 실제로 이것 때문에 Prometheus 가 OOM 으로 죽었다(exit 137).
      //   Phase 02 에서 cAdvisor 가 같은 이유로 Prometheus 를 죽인 것과 같은 종류의 사고다.
      tags: { name: 'reservation' },
    },
  };
}

/** k6 기본 요약 대신 lab 문서에 그대로 붙일 수 있는 형태로 출력한다. */
export function compactSummary(data, title) {
  const m = data.metrics;
  const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : 'n/a');
  const trend = (name) => {
    const t = m[name];
    if (!t) return `${name}: (없음)`;
    return [
      `  avg=${num(t.values.avg)}ms`,
      `med=${num(t.values.med)}ms`,
      `p90=${num(t.values['p(90)'])}ms`,
      `p95=${num(t.values['p(95)'])}ms`,
      `p99=${num(t.values['p(99)'])}ms`,
      `max=${num(t.values.max)}ms`,
    ].join(' ');
  };

  const iterations = m.iterations ? m.iterations.values.count : 0;
  const dropped = m.dropped_iterations ? m.dropped_iterations.values.count : 0;
  const failRate = m.http_req_failed ? m.http_req_failed.values.rate * 100 : 0;
  const reqs = m.http_reqs ? m.http_reqs.values.count : 0;
  const rps = m.http_reqs ? m.http_reqs.values.rate : 0;

  const lines = [
    '',
    `================ ${title} ================`,
    `요청 수        : ${reqs}  (평균 ${num(rps)} RPS)`,
    `이터레이션     : ${iterations} 완료 / ${dropped} 드롭  <-- 드롭 > 0 이면 도착률 유지 실패`,
    `실패율         : ${num(failRate, 3)} %`,
    `VU 최대        : ${m.vus_max ? m.vus_max.values.max : 'n/a'}`,
    '',
    '지연 (전체 구간, 워밍업 포함):',
    trend('http_req_duration'),
    '',
    '지연 분해:',
    `  connecting=${num(m.http_req_connecting?.values.avg)}ms` +
      ` sending=${num(m.http_req_sending?.values.avg)}ms` +
      ` waiting=${num(m.http_req_waiting?.values.avg)}ms` +
      ` receiving=${num(m.http_req_receiving?.values.avg)}ms`,
    '  ^ waiting 이 지배해야 정상. connecting/sending 이 크면 클라이언트/네트워크가 병목.',
    '',
    '상태코드별:',
    ...Object.keys(m)
      .filter((k) => k.startsWith('status_'))
      .map((k) => `  ${k.replace('status_', '')}: ${m[k].values.count}`),
    '='.repeat(40 + title.length),
    '',
  ];
  return lines.join('\n');
}
