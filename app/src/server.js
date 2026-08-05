import fs from 'node:fs';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { createReservation } from './reservation.js';
import { closeDb, poolConfig } from './db.js';
import {
  registry, httpRequestDuration, httpRequestsInFlight, reservationOutcomes,
} from './metrics.js';

// Phase 02: 앱이 직접 TLS 를 종료할지 결정한다.
//   off   -> 평문 HTTP (Phase 01 기준선)
//   ecdsa -> HTTPS, ECDSA P-256 인증서
//   rsa   -> HTTPS, RSA 2048 인증서
//
// 한 번의 실행에는 한 가지 모드만 쓴다. 두 프로토콜을 동시에 열면
// CPU 사용량이 누구 것인지 구분이 안 되기 때문이다.
const tlsMode = process.env.TLS_MODE ?? 'off';

const serverOptions = { logger: false, disableRequestLogging: true };

if (tlsMode !== 'off') {
  const certDir = process.env.CERT_DIR ?? '/certs';
  serverOptions.https = {
    key: fs.readFileSync(`${certDir}/${tlsMode}-key.pem`),
    cert: fs.readFileSync(`${certDir}/${tlsMode}-cert.pem`),
    // 버전을 고정할 수 있게 열어둔다. 기본은 1.2~1.3 협상.
    minVersion: process.env.TLS_MIN_VERSION || 'TLSv1.2',
    maxVersion: process.env.TLS_MAX_VERSION || 'TLSv1.3',
  };

  // 세션 재개(session ticket)를 기본으로 끈다.
  // 켜져 있으면 두 번째 핸드쉐이크부터 비싼 서명 연산을 건너뛰어서,
  // 우리가 재려는 "전체 핸드쉐이크 비용"이 희석된다.
  // 재개의 효과 자체를 재고 싶을 때 TLS_RESUMPTION=on 으로 켠다.
  if ((process.env.TLS_RESUMPTION ?? 'off') === 'off') {
    serverOptions.https.secureOptions = crypto.constants.SSL_OP_NO_TICKET;
  }
}

const app = Fastify(serverOptions);

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

app.get('/healthz', async (req) => ({
  ok: true,
  poolMax: poolConfig.max,
  tlsMode,
  // req.socket.getCipher() 는 TLS 커넥션에서만 존재한다.
  // 실제로 어떤 버전/암호가 협상됐는지 실행 중에 확인할 수 있어야 한다.
  tls: req.socket.getCipher
    ? { ...req.socket.getCipher(), protocol: req.socket.getProtocol?.() }
    : null,
}));

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: '0.0.0.0' })
  .then(() => process.stdout.write(
    `app listening on ${port} scheme=${tlsMode === 'off' ? 'http' : 'https'} `
    + `tlsMode=${tlsMode} poolMax=${poolConfig.max}\n`,
  ))
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
