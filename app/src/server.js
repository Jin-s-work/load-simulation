import Fastify from 'fastify';
import { createReservation } from './reservation.js';
import { closeDb, poolConfig } from './db.js';
import {
  registry, httpRequestDuration, httpRequestsInFlight, reservationOutcomes,
} from './metrics.js';

// 요청당 로그를 남기면 Docker json-file 드라이버가 먼저 병목이 된다.
// 그러면 우리가 재려던 것(앱/DB 한계) 대신 로깅 처리량을 재게 된다.
// 기준선에서는 요청 로그를 끄고, 이 결정을 lab 문서에 기록한다.
const app = Fastify({ logger: false, disableRequestLogging: true });

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

app.addHook('onRequest', async (req) => {
  req.startTime = process.hrtime.bigint();
  httpRequestsInFlight.inc();
});

app.addHook('onResponse', async (req, reply) => {
  httpRequestsInFlight.dec();
  const seconds = Number(process.hrtime.bigint() - req.startTime) / 1e9;
  httpRequestDuration.observe(
    {
      route: req.routeOptions?.url ?? 'unknown',
      method: req.method,
      status: String(reply.statusCode),
    },
    seconds,
  );
});

// ---------------------------------------------------------------------------
// 유일한 비즈니스 라우트
// ---------------------------------------------------------------------------
app.post('/api/v1/events/:eventId/reservations', async (req, reply) => {
  const eventId = Number(req.params.eventId);
  const { userId, quantity } = req.body ?? {};
  const idempotencyKey = req.headers['idempotency-key'];

  if (!Number.isInteger(eventId) || eventId <= 0) {
    reservationOutcomes.inc({ outcome: 'bad_request' });
    return reply.code(400).send({ error: 'INVALID_EVENT_ID' });
  }
  if (!Number.isInteger(userId) || !Number.isInteger(quantity) || quantity <= 0) {
    reservationOutcomes.inc({ outcome: 'bad_request' });
    return reply.code(400).send({ error: 'INVALID_BODY' });
  }
  if (!idempotencyKey || !UUID_RE.test(idempotencyKey)) {
    reservationOutcomes.inc({ outcome: 'bad_request' });
    return reply.code(400).send({ error: 'INVALID_IDEMPOTENCY_KEY' });
  }

  try {
    const result = await createReservation({ eventId, userId, quantity, idempotencyKey });
    reservationOutcomes.inc({ outcome: result.outcome });

    switch (result.outcome) {
      case 'created':
        return reply.code(201).send({
          reservationId: result.reservationId,
          remaining: result.remaining,
          servedFrom: 'db', // Phase 06 에서 캐시가 붙으면 여기가 갈린다
        });
      case 'idempotent_replay':
        return reply.code(200).send({
          reservationId: result.reservationId,
          remaining: result.remaining,
          servedFrom: 'db',
          replay: true,
        });
      case 'sold_out':
        return reply.code(409).send({ error: 'SOLD_OUT', remaining: result.remaining });
      case 'not_found':
        return reply.code(404).send({ error: 'EVENT_NOT_FOUND' });
      default:
        return reply.code(500).send({ error: 'UNKNOWN_OUTCOME' });
    }
  } catch (err) {
    reservationOutcomes.inc({ outcome: 'error' });
    // 부하 중 에러 원인을 잃지 않도록 에러만 로그로 남긴다 (정상 경로는 로그 없음).
    process.stderr.write(`reservation_error ${err.code ?? ''} ${err.message}\n`);
    return reply.code(500).send({ error: 'INTERNAL', code: err.code ?? null });
  }
});

// ---------------------------------------------------------------------------
// 비즈니스 라우트가 아닌 것들 (계측/검증 전용, CLAUDE.md 의 "라우트 1개" 규칙 예외)
// ---------------------------------------------------------------------------

// 생성기 상한 + 앱 단독 상한 측정용. DB 를 타지 않는다.
// 이 라우트로 목표 RPS 의 3~5배가 안 나오면 그 실험은 서버가 아니라 k6 를 잰 것이다.
app.get('/_sanity', async () => ({ ok: true, ts: Date.now() }));

app.get('/healthz', async () => ({ ok: true, poolMax: poolConfig.max }));

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: '0.0.0.0' })
  .then(() => process.stdout.write(`app listening on ${port} (pool max=${poolConfig.max})\n`))
  .catch((err) => {
    process.stderr.write(`listen_failed ${err.message}\n`);
    process.exit(1);
  });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
