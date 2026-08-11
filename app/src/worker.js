import http from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import { db, closeDb } from './db.js';
import { events, reservations } from './schema.js';
import {
  registry, mqConsumed, mqDlq, mqProcessDuration, mqE2eLatency, asyncInconsistency,
} from './metrics.js';
import { initQueue, closeQueue, QUEUE, DLQ, MQ_MAX_RETRY } from './queue.js';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const WORKER_ID = process.env.WORKER_ID || 'worker';
const PREFETCH = num(process.env.MQ_PREFETCH, 20);
const METRICS_PORT = num(process.env.WORKER_METRICS_PORT, 3100);

/**
 * 메시지 하나를 처리한다.
 *
 * ★ 멱등성이 이 함수의 핵심이다.
 *   at-least-once 이므로 같은 메시지가 두 번 올 수 있다.
 *   INSERT 는 reservations_idempotency_key_uidx(UNIQUE)가 막아주지만,
 *   **재고 차감은 UNIQUE 가 못 막는다** — 두 번 실행되면 두 번 깎인다.
 *
 *   그래서 차감과 INSERT 를 **한 트랜잭션에 묶는다.**
 *   중복이면 INSERT 가 제약 위반으로 터지고, 트랜잭션이 통째로 롤백되어
 *   차감도 함께 되돌아간다. 이게 멱등성이 성립하는 이유다.
 */
async function handle(payload) {
  const { eventId, userId, quantity, idempotencyKey } = payload;

  return db.transaction(async (tx) => {
    // 조건부 원자 UPDATE. Phase 05 에서 만든 최적화 경로와 같다.
    // Redis 게이트가 이미 선점했더라도 **DB 가 최종 권위**다.
    const updated = await tx
      .update(events)
      .set({
        remaining: sql`${events.remaining} - ${quantity}`,
        version: sql`${events.version} + 1`,
      })
      .where(and(eq(events.id, eventId), sql`${events.remaining} >= ${quantity}`))
      .returning({ remaining: events.remaining });

    if (updated.length === 0) {
      // Redis 는 통과시켰는데 DB 에는 재고가 없다.
      // = 202 를 줬는데 예약이 안 되는 상태. 최종 일관성이 깨진 지점이다.
      const [ev] = await tx.select({ remaining: events.remaining })
        .from(events).where(eq(events.id, eventId)).limit(1);
      return { outcome: ev ? 'sold_out' : 'not_found' };
    }

    await tx.insert(reservations)
      .values({ eventId, userId, quantity, idempotencyKey })
      .returning({ id: reservations.id });

    return { outcome: 'created', remaining: updated[0].remaining };
  });
}

async function main() {
  const { ch } = await initQueue({ consumer: true });

  // prefetch 는 "한 워커가 동시에 붙잡을 메시지 수" 다.
  // 무제한이면 워커 하나가 큐를 통째로 빨아들여 다른 워커가 굶는다.
  await ch.prefetch(PREFETCH);

  process.stdout.write(`worker ${WORKER_ID} consuming ${QUEUE} prefetch=${PREFETCH}\n`);

  await ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    const t0 = process.hrtime.bigint();
    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch {
      // 파싱조차 안 되는 메시지는 재시도해도 의미가 없다. 바로 DLQ 로.
      mqDlq.inc(); mqConsumed.inc({ outcome: 'error' });
      ch.nack(msg, false, false);
      return;
    }

    try {
      const r = await handle(payload);
      mqConsumed.inc({ outcome: r.outcome });
      if (r.outcome === 'sold_out' || r.outcome === 'not_found') {
        // Redis 게이트를 통과했는데 DB 가 거절했다. 세어 둔다.
        asyncInconsistency.inc({ reason: r.outcome });
      }
      if (payload.publishedAt) {
        mqE2eLatency.observe((Date.now() - payload.publishedAt) / 1000);
      }
      ch.ack(msg);
    } catch (err) {
      // UNIQUE 위반 = 이미 처리된 메시지. at-least-once 의 중복이다.
      // 이건 실패가 아니라 **정상 동작**이므로 ack 한다. 재시도하면 영원히 반복된다.
      if (err?.code === '23505') {
        mqConsumed.inc({ outcome: 'duplicate' });
        ch.ack(msg);
        return;
      }

      // 그 외 실패는 제한된 횟수만 재시도하고 DLQ 로 보낸다.
      // 무한 재큐하면 독약 메시지 하나가 큐 전체를 막는다.
      const deaths = msg.properties.headers?.['x-death']?.[0]?.count ?? 0;
      mqConsumed.inc({ outcome: 'error' });
      if (deaths >= MQ_MAX_RETRY) {
        mqDlq.inc();
        ch.nack(msg, false, false);      // requeue=false -> DLQ 로 간다
      } else {
        ch.nack(msg, false, false);      // x-dead-letter 설정이 재시도/DLQ 를 처리
      }
      process.stderr.write(`worker_error ${err.code ?? ''} ${err.message}\n`);
    } finally {
      mqProcessDuration.observe(Number(process.hrtime.bigint() - t0) / 1e9);
    }
  }, { noAck: false });

  // 지표 노출. 앱과 포트가 겹치지 않게 별도 포트를 쓴다.
  http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    } else if (req.url === '/healthz') {
      res.end(JSON.stringify({ ok: true, worker: WORKER_ID }));
    } else { res.statusCode = 404; res.end(); }
  }).listen(METRICS_PORT, '0.0.0.0');
}

main().catch((err) => {
  process.stderr.write(`worker_fatal ${err.message}\n`);
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await closeQueue();
    await closeDb();
    process.exit(0);
  });
}

export { DLQ };
