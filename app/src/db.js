import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { dbPoolAcquireWait, registerPoolGauges } from './metrics.js';

// pg 는 bigint(oid 20)를 기본적으로 문자열로 준다. JSON 응답에서 숫자로 다루기 위해 파서를 바꾼다.
// (안전한 정수 범위를 벗어나면 정밀도가 깨지지만 이 실험 규모에서는 문제가 되지 않는다.)
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

// Phase 01 은 "튜닝하지 않은 기준선"이다.
// PG_POOL_MAX 를 주지 않으면 node-postgres 기본값 10 을 그대로 쓴다. 이 값을 만지는 건 Phase 02 의 일이다.
const poolMax = process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : 10;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
});

// 커넥션 획득 대기시간 계측.
// drizzle 이 트랜잭션을 시작할 때 내부적으로 pool.connect() 를 부르므로,
// 여기서 감싸 두면 모든 체크아웃이 자동으로 잡힌다.
const originalConnect = pool.connect.bind(pool);
pool.connect = async function instrumentedConnect(...args) {
  const start = process.hrtime.bigint();
  try {
    return await originalConnect(...args);
  } finally {
    dbPoolAcquireWait.observe(Number(process.hrtime.bigint() - start) / 1e9);
  }
};

registerPoolGauges(pool);

export const db = drizzle(pool, { schema });

export const poolConfig = { max: poolMax };

export async function closeDb() {
  await pool.end();
}
