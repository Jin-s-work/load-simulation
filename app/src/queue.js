import amqp from 'amqplib';
import { mqPublished, mqPublishErrors } from './metrics.js';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const MQ_URL = process.env.MQ_URL || 'amqp://lts:lts@rabbitmq:5672';
export const QUEUE = process.env.MQ_QUEUE || 'reservations';
export const DLQ = `${QUEUE}.dlq`;
export const MQ_MAX_RETRY = num(process.env.MQ_MAX_RETRY, 3);

// 발행 확인(publisher confirm)을 쓸지.
// 끄면 발행이 빨라지지만 브로커가 못 받아도 앱은 모른다 — 유실 가능.
// 켜면 브로커가 받았음을 확인할 때까지 기다린다.
export const MQ_CONFIRM = process.env.MQ_CONFIRM !== '0';

let conn = null;
let ch = null;
export let mqReady = false;

/**
 * 큐 토폴로지를 세운다.
 *
 * DLQ 를 만드는 이유:
 *   처리에 실패한 메시지를 그냥 재큐하면 **독약 메시지 하나가 큐 전체를 막는다.**
 *   실패 -> 재큐 -> 다시 실패의 무한 루프다.
 *   Phase 04 의 "타임아웃만으로는 최악" 과 같은 구조 — 포기할 줄 알아야 한다.
 *
 * quorum 이 아니라 classic 큐를 쓴다. 단일 브로커라 복제 이득이 없고,
 * classic 이 가볍다(이 VM 은 이미 빡빡하다).
 */
async function declareTopology(channel) {
  await channel.assertQueue(DLQ, { durable: true });
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      // 재시도 한도를 넘긴 메시지가 갈 곳
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': DLQ,
    },
  });
}

export async function initQueue({ consumer = false } = {}) {
  conn = await amqp.connect(MQ_URL);
  // ★ 핸들러가 없으면 브로커가 죽는 순간 unhandled error 로 프로세스가 같이 죽는다.
  conn.on('error', () => { mqReady = false; });
  conn.on('close', () => { mqReady = false; });

  ch = consumer || !MQ_CONFIRM
    ? await conn.createChannel()
    : await conn.createConfirmChannel();

  ch.on('error', () => { mqReady = false; });
  await declareTopology(ch);
  mqReady = true;
  return { conn, ch };
}

/**
 * 발행. 실패하면 예외를 던진다 — 호출부가 사용자에게 알려야 한다.
 *
 * 여기서 실패를 삼키면 "202 를 줬는데 큐에 없는" 최악의 상태가 된다.
 * 캐시(Phase 07)는 실패를 miss 로 강등해도 되지만, 큐는 그러면 안 된다.
 * 캐시는 최적화지만 큐는 **유일한 처리 경로**이기 때문이다.
 */
export async function publish(payload) {
  if (!ch || !mqReady) {
    mqPublishErrors.inc({ reason: 'not_ready' });
    throw Object.assign(new Error('mq not ready'), { code: 'MQ_NOT_READY' });
  }
  const body = Buffer.from(JSON.stringify(payload));
  try {
    if (MQ_CONFIRM) {
      await new Promise((resolve, reject) => {
        ch.sendToQueue(QUEUE, body, { persistent: true, messageId: payload.idempotencyKey },
          (err) => (err ? reject(err) : resolve()));
      });
    } else {
      ch.sendToQueue(QUEUE, body, { persistent: true, messageId: payload.idempotencyKey });
    }
    mqPublished.inc();
  } catch (err) {
    mqPublishErrors.inc({ reason: 'send_failed' });
    throw err;
  }
}

export function queueStats() {
  return { url: MQ_URL, queue: QUEUE, ready: mqReady, confirm: MQ_CONFIRM };
}

export async function closeQueue() {
  try { if (ch) await ch.close(); } catch { /* 종료 중 실패는 무시 */ }
  try { if (conn) await conn.close(); } catch { /* 종료 중 실패는 무시 */ }
}
