import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import {
  dbPoolAcquireWait, dbPoolAcquireError, registerPoolGauges,
} from './metrics.js';

// pg 는 bigint(oid 20)를 기본적으로 문자열로 준다. JSON 응답에서 숫자로 다루기 위해 파서를 바꾼다.
// (안전한 정수 범위를 벗어나면 정밀도가 깨지지만 이 실험 규모에서는 문제가 되지 않는다.)
//
// 참고: 이건 Node 쪽 파싱이라 서버 세션 상태가 아니다.
// Phase 06 에서 PgBouncer transaction 모드를 써도 영향을 받지 않는다.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// ---------------------------------------------------------------------------
// Phase 05: 풀 파라미터 네 개를 전부 손잡이로 뺀다.
//
// 각각이 막는 문제가 다르다:
//   max              DB 를 보호한다. 없으면 앱이 커넥션을 무한정 열어 DB 가 먼저 죽는다.
//   connectionTimeout 앱을 보호한다. 풀이 꽉 찼을 때 무한정 기다리지 않게 한다.
//   idleTimeout      자원을 회수한다. 부하가 빠진 뒤 커넥션을 붙잡고 있지 않게 한다.
//   maxLifetime      시간이 지나며 누적되는 문제를 끊는다(백엔드 메모리 증가, 페일오버 후 좀비).
//
// ★ max 는 "앱 인스턴스 하나 기준"이다. DB 가 받는 건 (인스턴스 수 × max) 다.
//   앱 3대에 max=40 이면 120 이고, Postgres 기본 max_connections=100 을 넘긴다.
// ---------------------------------------------------------------------------
const poolMax = num(process.env.PG_POOL_MAX, 10);
const acquireTimeoutMs = num(process.env.PG_ACQUIRE_TIMEOUT_MS, 0);   // 0 = 무한 대기
const idleTimeoutMs = num(process.env.PG_IDLE_TIMEOUT_MS, 10000);
const maxLifetimeSec = num(process.env.PG_MAX_LIFETIME_SEC, 0);       // 0 = 무제한

// ---------------------------------------------------------------------------
// 서버측 타임아웃. Postgres 기본값은 셋 다 0(무제한)이다.
//
// PGOPTIONS 로 넘기면 커넥션이 만들어질 때 서버가 세션에 적용한다.
// pool.on('connect') 에서 SET 을 날리는 방법도 있지만 커넥션마다 왕복이 한 번 더 든다.
//
//   statement_timeout                    쿼리가 영원히 도는 것을 막는다
//   lock_timeout                         락을 영원히 기다리는 것을 막는다
//   idle_in_transaction_session_timeout  BEGIN 해놓고 방치된 세션을 끊는다
// ---------------------------------------------------------------------------
const stmtTimeoutMs = num(process.env.PG_STATEMENT_TIMEOUT_MS, 0);
const lockTimeoutMs = num(process.env.PG_LOCK_TIMEOUT_MS, 0);
const idleTxTimeoutMs = num(process.env.PG_IDLE_TX_TIMEOUT_MS, 0);

const serverOptions = [
  stmtTimeoutMs > 0 ? `-c statement_timeout=${stmtTimeoutMs}` : '',
  lockTimeoutMs > 0 ? `-c lock_timeout=${lockTimeoutMs}` : '',
  idleTxTimeoutMs > 0 ? `-c idle_in_transaction_session_timeout=${idleTxTimeoutMs}` : '',
].filter(Boolean).join(' ');

const poolConfigRaw = {
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: idleTimeoutMs,
};
// 0 을 그대로 넘기면 pg 가 "즉시 포기"로 해석하는 값이 있어, 켤 때만 넣는다.
if (acquireTimeoutMs > 0) poolConfigRaw.connectionTimeoutMillis = acquireTimeoutMs;
if (maxLifetimeSec > 0) poolConfigRaw.maxLifetimeSeconds = maxLifetimeSec;
if (serverOptions) poolConfigRaw.options = serverOptions;

export const pool = new pg.Pool(poolConfigRaw);

// 풀이 백그라운드에서 커넥션을 잃었을 때 프로세스가 죽지 않게 한다.
// Phase 05 (a) 에서 max_connections 초과가 나면 여기로 온다.
pool.on('error', (err) => {
  dbPoolAcquireError.inc({ reason: classifyDbError(err) });
});

export function classifyDbError(err) {
  const code = err?.code;
  const msg = String(err?.message || '');
  if (code === '53300' || /too many clients/i.test(msg)) return 'too_many_clients';
  if (code === '57014' || /statement timeout/i.test(msg)) return 'statement_timeout';
  if (code === '55P03' || /lock timeout/i.test(msg)) return 'lock_timeout';
  if (code === '25P03' || /idle-in-transaction/i.test(msg)) return 'idle_in_tx_timeout';
  if (/timeout exceeded when trying to connect/i.test(msg)) return 'pool_acquire_timeout';
  if (code === '40P01') return 'deadlock';
  return code ? `pg_${code}` : 'other';
}

// 커넥션 획득 대기시간 계측.
// drizzle 이 트랜잭션을 시작할 때 내부적으로 pool.connect() 를 부르므로,
// 여기서 감싸 두면 모든 체크아웃이 자동으로 잡힌다.
//
// 실패도 반드시 센다. (a) 는 "획득 자체가 실패"하는 실험이라
// 성공한 획득만 재면 아무 일도 없는 것처럼 보인다.
const originalConnect = pool.connect.bind(pool);
pool.connect = async function instrumentedConnect(...args) {
  const start = process.hrtime.bigint();
  try {
    const c = await originalConnect(...args);
    dbPoolAcquireWait.observe(Number(process.hrtime.bigint() - start) / 1e9);
    return c;
  } catch (err) {
    dbPoolAcquireWait.observe(Number(process.hrtime.bigint() - start) / 1e9);
    dbPoolAcquireError.inc({ reason: classifyDbError(err) });
    throw err;
  }
};

registerPoolGauges(pool);

export const db = drizzle(pool, { schema });

export const poolConfig = {
  max: poolMax,
  acquireTimeoutMs,
  idleTimeoutMs,
  maxLifetimeSec,
  statementTimeoutMs: stmtTimeoutMs,
  lockTimeoutMs,
  idleTxTimeoutMs,
};

export async function closeDb() {
  await pool.end();
}
