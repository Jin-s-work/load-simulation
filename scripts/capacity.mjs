#!/usr/bin/env node
// Phase 09 용량 산정 — 리틀의 법칙으로 계층별 필요 수를 계산하고 실측과 비교한다.
//
//   L = λ × W
//     L 시스템 안에 동시에 있는 요청 수 (= 필요한 동시 처리 단위)
//     λ 초당 도착 수
//     W 요청 하나의 평균 체류 시간
//
// 각 계층의 W 는 앞선 Phase 에서 실측한 값을 쓴다. 추측하지 않는다.

const TARGET_RPS = Number(process.env.TARGET_RPS || 1000);
const TARGET_P99_MS = Number(process.env.TARGET_P99_MS || 200);

// ── 앞선 Phase 에서 실측한 서비스 시간 ──────────────────────────────────
// 출처를 반드시 함께 적는다. 근거 없는 숫자를 산정에 넣지 않는다.
const M = {
  appCpuPerReq: {
    // Phase 01: 요청당 앱 CPU 515µs (천장 2000 RPS 의 근거)
    value: 0.000515, unit: 's', src: 'Phase 01 — 요청당 CPU 515µs',
  },
  dbTxP50: {
    // Phase 05: 트랜잭션 p50 1.9ms (최적화 경로)
    value: 0.0019, unit: 's', src: 'Phase 05 — 트랜잭션 p50 1.9ms',
  },
  workerProcP99: {
    // Phase 08: 워커 처리 p99. 4대 기준 44.9ms(max-async)
    value: 0.0449, unit: 's', src: 'Phase 08 max-async — 워커 처리 p99 44.9ms',
  },
  cacheHitRatio: {
    // Phase 07: Redis + Zipf 에서 81.5%. 캐시가 끊어내는 비율
    value: 0.815, unit: '', src: 'Phase 07 redis-zipf — hit ratio 81.5%',
  },
  dbTouchRatio: {
    // Phase 07: 캐시 적용 후 DB 접촉 비율 28.8%
    value: 0.288, unit: '', src: 'Phase 07 redis-zipf — DB 접촉 28.8%',
  },
  memPerConnMb: {
    // Phase 05: 사적메모리 ≈ 10MB + 3.1MB × 커넥션수
    value: 3.1, unit: 'MB', src: 'Phase 05 (d) — 커넥션당 사적메모리 3.1MB',
  },
};

const rows = [];
const add = (layer, formula, need, actual, note) =>
  rows.push({ layer, formula, need, actual, note });

// ── 1) 앱 인스턴스 ────────────────────────────────────────────────────────
// 앱은 단일 스레드다. 코어 하나가 낼 수 있는 처리량 = 1 / 요청당CPU
const appRpsPerCore = 1 / M.appCpuPerReq.value;
const appCoresNeeded = TARGET_RPS / appRpsPerCore;
add('앱 (CPU)',
  `${TARGET_RPS} ÷ (1 ÷ ${M.appCpuPerReq.value}s) = ${appCoresNeeded.toFixed(2)} 코어`,
  `${appCoresNeeded.toFixed(2)} 코어 (앱 1대면 충분)`,
  '앱 3대 × cpus 2.0 = 6.0 코어 상한',
  'Phase 01 의 515µs 는 캐시·큐 없는 동기 경로 값이다. 실제로는 더 든다');

// ── 2) 앱 동시 처리 (리틀의 법칙) ─────────────────────────────────────────
// W 는 목표 p99 가 아니라 평균 체류시간을 써야 하지만,
// 안전하게 목표 p99 를 상한으로 잡아 최악을 본다.
const appConcurrency = TARGET_RPS * (TARGET_P99_MS / 1000);
add('앱 (동시성)',
  `L = ${TARGET_RPS} × ${TARGET_P99_MS / 1000}s = ${appConcurrency.toFixed(0)}`,
  `${appConcurrency.toFixed(0)} 개 동시 요청 (최악 가정)`,
  '측정값은 아래 표 참고',
  '평균 체류시간으로 계산하면 훨씬 작다. 이건 p99 를 상한으로 본 최악치');

// ── 3) DB 커넥션 ──────────────────────────────────────────────────────────
// 캐시가 끊어내고 남은 요청만 DB 로 간다.
const dbRps = TARGET_RPS * M.dbTouchRatio.value;
const dbConnNeeded = dbRps * M.dbTxP50.value;
add('DB 커넥션',
  `(${TARGET_RPS} × ${M.dbTouchRatio.value}) × ${M.dbTxP50.value}s = ${dbConnNeeded.toFixed(2)}`,
  `${dbConnNeeded.toFixed(2)} 개`,
  'PgBouncer default_pool_size 20 (실측 DB 커넥션 22)',
  '계산값의 30배를 열어 뒀다. 여유가 크다는 뜻이지 낭비는 아니다 — 버스트 대비');

// ── 4) 워커 ───────────────────────────────────────────────────────────────
// 큐로 가는 것은 "쓰기" 뿐이다. 캐시가 끊은 것은 큐에 안 간다.
const queueRps = TARGET_RPS * M.dbTouchRatio.value;
const workerConcurrency = queueRps * M.workerProcP99.value;
const workersNeeded = workerConcurrency / 20;  // prefetch 20
add('워커',
  `(${TARGET_RPS} × ${M.dbTouchRatio.value}) × ${M.workerProcP99.value}s = ${workerConcurrency.toFixed(1)} 동시`,
  `${workerConcurrency.toFixed(1)} 동시 → prefetch 20 이면 ${Math.max(1, Math.ceil(workersNeeded))}대`,
  '워커 4대 (prefetch 20 = 동시 80)',
  'p99 로 계산한 최악치. 평균으로는 더 적다');

// ── 5) DB 메모리 ──────────────────────────────────────────────────────────
const dbConnActual = 22;
const memNeeded = 10 + M.memPerConnMb.value * dbConnActual;
add('DB 메모리',
  `10MB + ${M.memPerConnMb.value}MB × ${dbConnActual} = ${memNeeded.toFixed(0)}MB`,
  `${memNeeded.toFixed(0)}MB (사적)`,
  'Phase 06 실측 79MB',
  'Phase 05 회귀식이 Phase 06 에서 오차 2% 로 재현됐다');

const out = [
  '### Phase 09 용량 산정 — 리틀의 법칙',
  '',
  `목표: **${TARGET_RPS} RPS · p99 < ${TARGET_P99_MS}ms**`,
  '',
  '```',
  'L = λ × W',
  '  L  동시에 시스템 안에 있는 요청 수 (= 필요한 동시 처리 단위)',
  '  λ  초당 도착 수',
  '  W  요청 하나의 평균 체류 시간',
  '```',
  '',
  '#### 입력값 (전부 앞선 Phase 의 실측치)',
  '',
  '| 값 | 크기 | 출처 |',
  '|---|--:|---|',
  ...Object.values(M).map((m) => `| ${m.src.split('—')[1].trim()} | ${m.value}${m.unit} | ${m.src.split('—')[0].trim()} |`),
  '',
  '#### 계층별 산정 vs 실제 구성',
  '',
  '| 계층 | 계산 | **필요** | 실제 구성 | 비고 |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.layer} | \`${r.formula}\` | **${r.need}** | ${r.actual} | ${r.note} |`),
  '',
];

console.log(out.join('\n'));
