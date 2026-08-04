import { eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { events, reservations } from './schema.js';
import { dbTransactionDuration } from './metrics.js';

/**
 * Phase 01 기준선: 일부러 순진하게(naive) 구현한다.
 *
 * 트랜잭션 하나 안에서 5번 왕복한다:
 *   1) BEGIN
 *   2) 멱등키 조회
 *   3) SELECT ... FOR UPDATE  (비관적 락)
 *   4) UPDATE events
 *   5) INSERT reservations
 *   6) COMMIT
 *
 * 이건 "잘 짠 코드"가 아니라 "처음 짜면 대개 이렇게 나오는 코드"다.
 * 왕복 횟수만큼 커넥션 점유 시간이 길어지고, 그 점유 시간이 곧 풀 소모율이 된다.
 * 최적화(왕복 줄이기, 원자적 UPDATE, 락 전략 교체)는 Phase 02 이후에 한다.
 */
export async function createReservation({ eventId, userId, quantity, idempotencyKey }) {
  const txStart = process.hrtime.bigint();
  try {
    return await db.transaction(async (tx) => {
      // 1) 멱등성 확인: 같은 키로 이미 만들어진 예약이 있는가
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

      // 2) 재고 행을 잠근다. HOT_RATIO 가 높으면 여기서 요청들이 줄을 선다.
      const [ev] = await tx
        .select({ id: events.id, remaining: events.remaining })
        .from(events)
        .where(eq(events.id, eventId))
        .for('update');

      if (!ev) {
        return { outcome: 'not_found' };
      }

      if (ev.remaining < quantity) {
        return { outcome: 'sold_out', remaining: ev.remaining };
      }

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
  } finally {
    dbTransactionDuration.observe(Number(process.hrtime.bigint() - txStart) / 1e9);
  }
}
