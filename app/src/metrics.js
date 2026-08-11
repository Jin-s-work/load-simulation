import client from 'prom-client';

export const registry = new client.Registry();

// nodejs_eventloop_lag_*, process_cpu_*, nodejs_gc_* 등을 포함한다.
// 이벤트루프 지연을 10ms 해상도로 샘플링한다 (기본 10ms).
client.collectDefaultMetrics({
  register: registry,
  eventLoopMonitoringPrecision: 10,
});

// 클러스터 모드에서 프라이머리가 워커 지표를 모을 때 "어느 레지스트리를 보고할지" 알려준다.
// 우리는 기본 전역 레지스트리가 아니라 커스텀 레지스트리를 쓰므로 이 줄이 없으면
// 프라이머리가 빈 지표를 모으게 된다.
client.AggregatorRegistry.setRegistries(registry);

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

// Phase 05: 커넥션 획득이 "실패"한 횟수. 대기시간만 재면 (a) 가 안 보인다.
// max_connections 초과는 대기가 아니라 즉시 거부라서 히스토그램에 거의 안 잡힌다.
export const dbPoolAcquireError = new client.Counter({
  name: 'db_pool_acquire_error_total',
  help: '커넥션 획득 실패 수',
  labelNames: ['reason'],  // too_many_clients | pool_acquire_timeout | statement_timeout | lock_timeout | ...
  registers: [registry],
});

export const dbTransactionDuration = new client.Histogram({
  name: 'db_transaction_duration_seconds',
  help: 'BEGIN~COMMIT 구간 소요 시간 (= 커넥션 점유 시간)',
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

// Phase 05 (f): 인덱스 없는 조회에 걸린 시간.
// 트랜잭션 전체 시간과 따로 재야 "느린 쿼리가 점유 시간의 몇 %인지" 를 말할 수 있다.
export const dbSlowQueryDuration = new client.Histogram({
  name: 'db_slow_query_duration_seconds',
  help: '인덱스 없는 조회 소요 시간 (Phase 05 (f))',
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Phase 07: 캐시 지표
// ---------------------------------------------------------------------------
export const cacheLookups = new client.Counter({
  name: 'cache_lookups_total',
  help: '캐시 조회 수 (계층별 hit/miss)',
  labelNames: ['layer', 'result'],   // local|redis × hit|miss
  registers: [registry],
});

// kind=db      실제로 DB 를 친 로딩
// kind=shared  singleflight 로 남의 로딩에 올라탄 요청
// 둘의 비율이 곧 singleflight 의 효과다.
export const cacheLoads = new client.Counter({
  name: 'cache_loads_total',
  help: '캐시 미스 후 원본 로딩',
  labelNames: ['kind'],
  registers: [registry],
});

export const cacheErrors = new client.Counter({
  name: 'cache_errors_total',
  help: '캐시 계층 오류 (요청은 죽이지 않고 miss 로 강등한다)',
  labelNames: ['op'],
  registers: [registry],
});

export const redisOpDuration = new client.Histogram({
  name: 'redis_op_duration_seconds',
  help: 'Redis GET 소요 시간',
  buckets: [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [registry],
});

// DB 를 실제로 친 예약 요청 수. 캐시의 존재 이유가 이 숫자를 줄이는 것이다.
export const dbTouchTotal = new client.Counter({
  name: 'db_touch_total',
  help: '예약 처리 중 DB 를 실제로 친 횟수',
  labelNames: ['path'],   // write | read_miss | short_circuit(=DB 안 침)
  registers: [registry],
});

export const reservationOutcomes = new client.Counter({
  name: 'reservation_outcomes_total',
  help: '예약 라우트의 결과 분포',
  labelNames: ['outcome'],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Phase 04: 과부하 지표
// ---------------------------------------------------------------------------
export const overloadMetrics = {
  // 이벤트 루프 지연을 100ms 주기로 직접 잰 값.
  // prom-client 의 nodejs_eventloop_lag_* 는 저부하에서 12~22ms 의 노이즈 바닥이 있어
  // Phase 01 에서 판별력이 없다고 판단했다. 이건 그 대안이다.
  loopLagGauge: new client.Gauge({
    name: 'app_event_loop_lag_ms',
    help: 'setInterval 예약 시각 대비 실제 실행 시각의 차이 (ms)',
    registers: [registry],
  }),

  // 거절한 요청 수. 이유별로 나눈다.
  shedTotal: new client.Counter({
    name: 'app_shed_total',
    help: '과부하로 즉시 거절한 요청 수',
    labelNames: ['reason'],   // bulkhead | queue_length | loop_lag
    registers: [registry],
  }),

  // 타임아웃으로 포기한 요청 수
  timeoutTotal: new client.Counter({
    name: 'app_request_timeout_total',
    help: '타임아웃으로 응답을 포기한 요청 수',
    registers: [registry],
  }),

  // 힙 사용량은 collectDefaultMetrics 가 nodejs_heap_size_used_bytes 로 이미 준다.
  // GC 일시정지도 nodejs_gc_duration_seconds 로 이미 온다. 중복 정의하지 않는다.
};

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
