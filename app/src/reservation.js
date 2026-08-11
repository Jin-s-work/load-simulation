import { eq, and, sql } from 'drizzle-orm';
import { db } from './db.js';
import { events, reservations } from './schema.js';
import { dbTransactionDuration, dbSlowQueryDuration } from './metrics.js';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// ── Phase 05 손잡이 ────────────────────────────────────────────────────────
// TX_HOLD_MS   트랜잭션 안에서 일부러 머무는 시간.
//              락을 쥔 채로 아무것도 안 하는 상태 = idle in transaction 을 만든다.
// SLOW_QUERY   인덱스 없는 조회를 트랜잭션 안에 하나 추가한다.
//              reservations 를 200만 행으로 채워두면 순차 스캔이 실제로 느리다.
// TX_OPTIMIZED 개선 경로. 왕복 5회를 2회로 줄인다.
const txHoldMs = num(process.env.TX_HOLD_MS, 0);
const slowQuery = process.env.SLOW_QUERY === '1';
const txOptimized = process.env.TX_OPTIMIZED === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 인덱스 없는 조회.
 *
 * reservations 에는 (id) PK 와 (idempotency_key) UNIQUE 만 있다.
 * event_id 는 외래키지만 **Postgres 는 FK 를 만들어도 인덱스를 자동 생성하지 않는다.**
 * 그래서 이 쿼리는 순차 스캔이 된다.
 *
 * 이게 실무에서 가장 흔한 사고 패턴이다 — 개발 DB 에선 데이터가 적어 멀쩡하다가
 * 운영에서 행이 쌓이면 터진다. 그리고 인덱스 하나로 고쳐진다.
 */
async function alreadyReservedByUser(tx, eventId, userId) {
  const t = process.hrtime.bigint();
  try {
    const rows = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(and(eq(reservations.eventId, eventId), eq(reservations.userId, userId)))
      .limit(1);
    return rows.length > 0;
  } finally {
    dbSlowQueryDuration.observe(Number(process.hrtime.bigint() - t) / 1e9);
  }
}

/**
 * Phase 01 기준선: 일부러 순진하게(naive) 구현한다.
 *
 * 트랜잭션 하나 안에서 5번 왕복한다:
 *   BEGIN -> 멱등키 조회 -> SELECT FOR UPDATE -> UPDATE -> INSERT -> COMMIT
 *
 * 왕복 횟수만큼 커넥션 점유 시간이 길어지고, 그 점유 시간이 곧 풀 소모율이 된다.
 * Phase 05 가 그걸 실제로 재는 자리다.
 */
async function createNaive({ eventId, userId, quantity, idempotencyKey }) {
  return db.transaction(async (tx) => {
    // 1) 멱등성 확인
    const existing = await tx
      .select({ id: reservations.id, quantity: reservations.quantity })
      .from(reservations)
      .where(eq(reservations.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existing.length > 0) {
      const [ev] = await tx
        .select({ remaining: events.remaining })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      return {
        outcome: 'idempotent_replay',
        reservationId: existing[0].id,
        remaining: ev ? ev.remaining : null,
      };
    }

    // (f) 느린 쿼리를 트랜잭션 안에 끼워 넣는다.
    //     이 쿼리가 도는 동안 커넥션은 반납되지 않는다.
    if (slowQuery) await alreadyReservedByUser(tx, eventId, userId);

    // 2) 재고 행을 잠근다. HOT_RATIO 가 높으면 여기서 요청들이 줄을 선다.
    const [ev] = await tx
      .select({ id: events.id, remaining: events.remaining })
      .from(events)
      .where(eq(events.id, eventId))
      .for('update');

    if (!ev) return { outcome: 'not_found' };

    // (e) 락을 쥔 채로 머문다. 이 구간이 곧 idle in transaction 이다.
    //     VACUUM 도 막고, 같은 행을 노리는 모든 요청을 세운다.
    if (txHoldMs > 0) await sleep(txHoldMs);

    if (ev.remaining < quantity) return { outcome: 'sold_out', remaining: ev.remaining };

    // 3) 재고 차감
    await tx
      .update(events)
      .set({
        remaining: sql`${events.remaining} - ${quantity}`,
        version: sql`${events.version} + 1`,
      })
      .where(eq(events.id, eventId));

    // 4) 예약 생성
    const [created] = await tx
      .insert(reservations)
      .values({ eventId, userId, quantity, idempotencyKey })
      .returning({ id: reservations.id });

    return {
      outcome: 'created',
      reservationId: created.id,
      remaining: ev.remaining - quantity,
    };
  });
}

/**
 * 개선: 트랜잭션 범위 축소.
 *
 * 두 가지를 바꾼다.
 *
 *  ① 멱등키 조회를 트랜잭션 **밖**으로 뺀다.
 *     읽기 전용이고 인덱스가 있어 빠르다. 트랜잭션 안에 둘 이유가 없다.
 *     (중복 삽입은 UNIQUE 제약이 최종 방어선이라 정확성은 유지된다.)
 *
 *  ② SELECT FOR UPDATE + UPDATE 를 **조건부 원자 UPDATE 하나**로 합친다.
 *
 *       UPDATE events SET remaining = remaining - $1
 *       WHERE id = $2 AND remaining >= $1
 *       RETURNING remaining
 *
 *     락을 따로 잡을 필요가 없다. UPDATE 자체가 행을 잠근다.
 *     "재고가 모자라면 0행이 갱신된다" 로 품절 판정도 같이 된다.
 *
 * 결과: 트랜잭션 안 왕복 5회 -> 2회. 커넥션 점유 시간이 그만큼 짧아진다.
 */
async function createOptimized({ eventId, userId, quantity, idempotencyKey }) {
  const existing = await db
    .select({ id: reservations.id, quantity: reservations.quantity })
    .from(reservations)
    .where(eq(reservations.idempotencyKey, idempotencyKey))
    .limit(1);

  if (existing.length > 0) {
    const [ev] = await db
      .select({ remaining: events.remaining })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    return {
      outcome: 'idempotent_replay',
      reservationId: existing[0].id,
      remaining: ev ? ev.remaining : null,
    };
  }

  return db.transaction(async (tx) => {
    if (slowQuery) await alreadyReservedByUser(tx, eventId, userId);

    const updated = await tx
      .update(events)
      .set({
        remaining: sql`${events.remaining} - ${quantity}`,
        version: sql`${events.version} + 1`,
      })
      .where(and(eq(events.id, eventId), sql`${events.remaining} >= ${quantity}`))
      .returning({ remaining: events.remaining });

    if (updated.length === 0) {
      // 이벤트가 없거나 재고가 모자라거나. 둘을 구분하려면 한 번 더 읽어야 하는데,
      // 실패 경로라 흔치 않으므로 여기서만 추가 왕복을 낸다.
      const [ev] = await tx
        .select({ remaining: events.remaining })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      return ev ? { outcome: 'sold_out', remaining: ev.remaining } : { outcome: 'not_found' };
    }

    if (txHoldMs > 0) await sleep(txHoldMs);

    const [created] = await tx
      .insert(reservations)
      .values({ eventId, userId, quantity, idempotencyKey })
      .returning({ id: reservations.id });

    return {
      outcome: 'created',
      reservationId: created.id,
      remaining: updated[0].remaining,
    };
  });
}

export async function createReservation(input) {
  const txStart = process.hrtime.bigint();
  try {
    return await (txOptimized ? createOptimized(input) : createNaive(input));
  } finally {
    dbTransactionDuration.observe(Number(process.hrtime.bigint() - txStart) / 1e9);
  }
}
