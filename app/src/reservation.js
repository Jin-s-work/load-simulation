import { eq, and, sql } from 'drizzle-orm';
import { db } from './db.js';
import { events, reservations } from './schema.js';
import { dbTransactionDuration, dbSlowQueryDuration, dbTouchTotal } from './metrics.js';
import { cacheGet, cachePut, CACHE_MODE } from './cache.js';

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

// ---------------------------------------------------------------------------
// Phase 07: 캐시 경로
//
// 캐시할 수 있는 것과 없는 것이 명확히 갈린다.
//
//   캐시 가능   이벤트 존재 여부, 메타데이터, **매진 여부**
//   캐시 불가   remaining 의 정확한 값, 재고 차감 자체
//
// 그래서 원칙이 이렇게 선다:
//
//   ★ 캐시는 거절을 빠르게 할 뿐, 허용을 보장하지 않는다.
//
//     캐시가 "매진" 이라 하면 -> 즉시 거절한다. 틀려도 손해가 작고 TTL 이 짧다
//     캐시가 "재고 있음" 이라 하면 -> DB 의 원자적 UPDATE 가 최종 판정한다
//
// 틀리는 방향이 비대칭이라 이렇게 자를 수 있다.
//   "재고 있는데 매진이라 함"  -> 살 수 있는 사람을 거절. 나쁘다. TTL 로 통제
//   "매진인데 재고 있다 함"    -> DB 가 0행 반환 -> 정상 거절. 무해
// ---------------------------------------------------------------------------

const eventKey = (id) => `ev:${id}`;

/** DB 에서 이벤트 상태를 읽는다. 캐시 miss 시의 loader. */
async function loadEventState(eventId) {
  const [ev] = await db
    .select({ id: events.id, remaining: events.remaining, totalSeats: events.totalSeats })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return { exists: false, soldOut: true, remaining: 0 };
  return { exists: true, soldOut: ev.remaining <= 0, remaining: ev.remaining };
}

export async function createReservation(input) {
  const txStart = process.hrtime.bigint();
  try {
    if (CACHE_MODE !== 'off') {
      const key = eventKey(input.eventId);
      const state = await cacheGet(key, () => loadEventState(input.eventId));

      // 캐시가 "없다" 또는 "매진" 이라 하면 DB 를 아예 안 친다.
      // 이 경로가 곧 DB QPS 감소분이다.
      if (state && !state.exists) {
        dbTouchTotal.inc({ path: 'short_circuit' });
        return { outcome: 'not_found', fromCache: true };
      }
      if (state && state.soldOut) {
        dbTouchTotal.inc({ path: 'short_circuit' });
        return { outcome: 'sold_out', remaining: 0, fromCache: true };
      }
    }

    dbTouchTotal.inc({ path: 'write' });
    const result = await (txOptimized ? createOptimized(input) : createNaive(input));

    // DB 가 진실을 알려줬다. 매진이면 캐시에 반영해서 다음 요청부터 짧게 끊는다.
    if (CACHE_MODE !== 'off') {
      if (result.outcome === 'sold_out') {
        await cachePut(eventKey(input.eventId), { exists: true, soldOut: true, remaining: 0 });
      } else if (result.outcome === 'not_found') {
        await cachePut(eventKey(input.eventId), { exists: false, soldOut: true, remaining: 0 });
      }
      // 성공(created)일 때는 캐시를 갱신하지 않는다.
      // remaining 을 캐시에 써 봐야 다음 요청이 오기 전에 이미 틀린 값이 되고,
      // 매 성공마다 캐시를 쓰면 왕복만 늘어난다. TTL 만료를 기다리는 게 낫다.
    }
    return result;
  } finally {
    dbTransactionDuration.observe(Number(process.hrtime.bigint() - txStart) / 1e9);
  }
}
