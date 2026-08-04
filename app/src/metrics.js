import client from 'prom-client';

export const registry = new client.Registry();

// nodejs_eventloop_lag_*, process_cpu_*, nodejs_gc_* 등을 포함한다.
// 이벤트루프 지연을 10ms 해상도로 샘플링한다 (기본 10ms).
client.collectDefaultMetrics({
  register: registry,
  eventLoopMonitoringPrecision: 10,
});

// 지연 버킷은 SLO(p99 < 200ms) 주변을 촘촘하게 잡는다.
// 버킷이 성기면 histogram_quantile 이 p99 를 크게 왜곡한다.
const LATENCY_BUCKETS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.075,
  0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10,
];

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP 요청 처리 시간 (앱 내부 기준)',
  labelNames: ['route', 'method', 'status'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: '현재 앱이 동시에 처리 중인 요청 수',
  registers: [registry],
});

export const dbPoolAcquireWait = new client.Histogram({
  name: 'db_pool_acquire_wait_seconds',
  help: 'pool.connect() 가 커넥션을 넘겨줄 때까지 걸린 시간 (풀 포화의 1차 신호)',
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const dbTransactionDuration = new client.Histogram({
  name: 'db_transaction_duration_seconds',
  help: 'BEGIN~COMMIT 구간 소요 시간 (= 커넥션 점유 시간)',
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const reservationOutcomes = new client.Counter({
  name: 'reservation_outcomes_total',
  help: '예약 라우트의 결과 분포',
  labelNames: ['outcome'],
  registers: [registry],
});

// pool 의 내부 카운터는 스크레이프 시점에 읽는다.
// waiting > 0 이면 "요청이 DB 가 아니라 풀 앞에서 줄 서 있다"는 뜻이다.
export function registerPoolGauges(pool) {
  new client.Gauge({
    name: 'db_pool_connections',
    help: 'node-postgres 풀 상태 (total = idle + in-use)',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
      this.set({ state: 'in_use' }, pool.totalCount - pool.idleCount);
    },
  });
}
