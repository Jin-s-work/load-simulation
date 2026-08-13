import fs from 'node:fs';
import cluster from 'node:cluster';
import http from 'node:http';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { createReservation } from './reservation.js';
import { closeDb, poolConfig, pool, classifyDbError } from './db.js';
import { initCache, closeCache, cacheStats } from './cache.js';
import { initQueue, closeQueue, queueStats } from './queue.js';
import {
  registry, httpRequestDuration, httpRequestsInFlight, reservationOutcomes, overloadMetrics,
} from './metrics.js';
import {
  burnCpu, allocateGarbage, shouldShed, withTimeout, calibrateCpuBurn,
  startLoopLagProbe, stopLoopLagProbe, currentLoopLagMs, overloadConfig,
} from './overload.js';

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

// ---------------------------------------------------------------------------
// Phase 03 실험용 손잡이
// ---------------------------------------------------------------------------

// 어느 인스턴스가 처리했는지 구분한다. LB 가 실제로 분배하고 있는지 확인하는 근거가 된다.
const INSTANCE_ID = process.env.INSTANCE_ID ?? 'app';

// 인위적 지연 주입. 실험 (d) 에서 3대 중 1대만 느리게 만든다.
// setTimeout 이라 이벤트 루프를 막지 않는다 = "느린 백엔드"를 흉내낼 뿐 CPU 를 태우지 않는다.
const SLOW_MS = Number(process.env.SLOW_MS ?? 0);

// readiness. graceful shutdown 실험에서 "LB 에게 먼저 빠지겠다고 알리는" 스위치.
let ready = true;

// 종료 절차에서 LB 가 헬스체크로 감지할 때까지 기다릴 시간.
// 이걸 0 으로 두면 readiness 를 내려도 LB 가 모르는 채로 프로세스가 죽는다 = 죽은 구간 발생.
const DRAIN_WAIT_MS = Number(process.env.DRAIN_WAIT_MS ?? 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

let inFlight = 0;

app.addHook('onRequest', async (req) => {
  req.startTime = process.hrtime.bigint();
  inFlight += 1;
  httpRequestsInFlight.inc();
});

app.addHook('onResponse', async (req, reply) => {
  inFlight -= 1;
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

  // ── Phase 04 보호 장치: 받을지 말지를 "일을 시작하기 전에" 판단한다 ──────────
  // 여기가 핵심이다. 이미 DB 트랜잭션을 연 뒤에 거절하면 자원을 쓰고도 실패한 것이 된다.
  const shed = shouldShed(inFlight);
  if (shed) {
    overloadMetrics.shedTotal.inc({ reason: shed.reason });
    reservationOutcomes.inc({ outcome: 'shed' });
    return reply
      .code(503)
      .header('Retry-After', '1')
      .send({ error: 'OVERLOADED', reason: shed.reason, detail: shed.detail });
  }

  try {
    // 실험 (d): 이 인스턴스만 느리게 만든다. CPU 를 태우지 않는 순수 지연이다.
    if (SLOW_MS > 0) await sleep(SLOW_MS);

    // 실험 (a): CPU 를 태운다. 동기면 이벤트 루프가 이 시간 동안 멈춘다.
    const burn = burnCpu();
    if (burn) await burn;

    // 실험 (b): 큰 객체를 만들어 GC 를 압박한다.
    allocateGarbage();

    const result = await withTimeout(
      createReservation({ eventId, userId, quantity, idempotencyKey }),
    );
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

      // Phase 08: 큐에 접수됐을 뿐 아직 확정이 아니다.
      // 201(Created) 이 아니라 202(Accepted) 로 답해야 의미가 맞는다.
      case 'accepted':
        return reply.code(202).send({
          status: 'ACCEPTED',
          idempotencyKey,
          note: 'queued for processing',
        });
      default:
        return reply.code(500).send({ error: 'UNKNOWN_OUTCOME' });
    }
  } catch (err) {
    if (err.code === 'REQUEST_TIMEOUT') {
      overloadMetrics.timeoutTotal.inc();
      reservationOutcomes.inc({ outcome: 'timeout' });
      return reply.code(504).send({ error: 'TIMEOUT' });
    }
    // Phase 05: DB 쪽 실패는 원인별로 나눈다.
    // 전부 500 으로 뭉뚱그리면 k6 출력만 보고 "커넥션이 없었나 / 쿼리가 느렸나 /
    // 락을 못 잡았나" 를 구분할 수 없다. 이 구분이 이번 Phase 의 핵심 증거다.
    const reason = classifyDbError(err);
    reservationOutcomes.inc({ outcome: `error_${reason}` });
    process.stderr.write(`reservation_error ${reason} ${err.code ?? ''} ${err.message}\n`);

    // 커넥션을 못 얻었거나 서버측 타임아웃에 걸린 것은 "일시적 과부하" 다.
    // 클라이언트가 재시도를 판단할 수 있도록 503 + Retry-After 로 답한다.
    const transient = [
      'too_many_clients', 'pool_acquire_timeout',
      'statement_timeout', 'lock_timeout', 'idle_in_tx_timeout', 'deadlock',
      // Phase 06 에서 빠져 있던 것. 프록시/DB 가 사라진 상황도 일시적 장애다.
      'upstream_unreachable', 'mq_unavailable',
    ].includes(reason);
    if (transient) {
      return reply.code(503).header('Retry-After', '1')
        .send({ error: 'DB_UNAVAILABLE', reason });
    }
    return reply.code(500).send({ error: 'INTERNAL', code: err.code ?? null });
  }
});

// ---------------------------------------------------------------------------
// 비즈니스 라우트가 아닌 것들 (계측/검증 전용, docs/conventions.md 의 "라우트 1개" 규칙 예외)
// ---------------------------------------------------------------------------

// 생성기 상한 + 앱 단독 상한 측정용. DB 를 타지 않는다.
// 이 라우트로 목표 RPS 의 3~5배가 안 나오면 그 실험은 서버가 아니라 k6 를 잰 것이다.
app.get('/_sanity', async () => ({ ok: true, ts: Date.now() }));

// LB 가 보는 헬스체크.
// 의도적으로 DB 를 확인하지 않는다. DB 를 확인하면 DB 가 잠깐 느려질 때
// 3대가 "동시에" unhealthy 가 되어 전멸한다(상관 실패). 근거는 docs/labs/03 참고.
// ready 가 false 면 503 을 돌려 LB 가 스스로 빼도록 한다.
app.get('/healthz', async (req, reply) => {
  if (!ready) {
    return reply.code(503).send({ ok: false, instance: INSTANCE_ID, reason: 'draining' });
  }
  return { ok: true, instance: INSTANCE_ID, slowMs: SLOW_MS };
});

// 의존성까지 확인하는 엔드포인트. **LB 판정에 쓰지 않는다.** 사람이 보는 용도다.
app.get('/health/deep', async (req, reply) => {
  try {
    const t0 = process.hrtime.bigint();
    await pool.query('SELECT 1');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: true, instance: INSTANCE_ID, db: { ok: true, latencyMs: Number(ms.toFixed(2)) } };
  } catch (err) {
    return reply.code(503).send({ ok: false, instance: INSTANCE_ID, db: { ok: false, error: err.code ?? err.message } });
  }
});

app.get('/debug/info', async (req) => ({
  ok: true,
  instance: INSTANCE_ID,
  ready,
  poolMax: poolConfig.max,
  tlsMode,
  inFlight,
  loopLagMs: currentLoopLagMs(),
  overload: overloadConfig,
  pid: process.pid,
  // req.socket.getCipher() 는 TLS 커넥션에서만 존재한다.
  // 실제로 어떤 버전/암호가 협상됐는지 실행 중에 확인할 수 있어야 한다.
  tls: req.socket.getCipher
    ? { ...req.socket.getCipher(), protocol: req.socket.getProtocol?.() }
    : null,
}));

// 실험 (e) 비교용: readiness 를 손으로 내렸다 올린다.
// 실서비스에 이런 라우트를 열어두면 안 된다. 실험 전용이다.
app.post('/debug/ready/:state', async (req) => {
  ready = req.params.state === 'on';
  return { ok: true, instance: INSTANCE_ID, ready };
});

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', registry.contentType);
  return registry.metrics();
});

const port = Number(process.env.PORT ?? 3000);

// backlog = accept 대기줄 길이. 커널의 somaxconn 과 둘 중 작은 값이 적용된다.
// 실험 (c): 이걸 좁히고 앱이 바쁘게 만들면 커널이 새 연결을 조용히 버린다(ListenOverflows).
const backlog = Number(process.env.APP_BACKLOG ?? 511);

// Phase 04: 이벤트 루프 지연을 100ms 주기로 직접 측정 시작.
// load shedding 판단에 쓰이므로 요청 처리보다 먼저 켜야 한다.
startLoopLagProbe();
const burnIters = calibrateCpuBurn();

// 클러스터 모드일 때만: 이 워커 전용 지표 포트를 연다.
// 포트 3000 은 워커들이 공유하므로 그쪽으로 긁으면 아무 워커나 걸린다.
let workerMetricsServer = null;
if (cluster.isWorker) {
  const wPort = 3010 + cluster.worker.id;
  workerMetricsServer = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': registry.contentType });
    res.end(await registry.metrics());
  });
  workerMetricsServer.listen(wPort, '0.0.0.0', () => {
    process.stdout.write(`worker ${cluster.worker.id} metrics on ${wPort}\n`);
  });
}

// Redis 연결을 먼저 세운 뒤 listen 한다.
// 순서를 반대로 하면 기동 직후 몇 초간 캐시가 없는 상태로 요청을 받아
// 워밍업 구간 지표가 오염된다.
//
// ★ 실패해도 계속 진행한다. Redis 가 없다고 앱이 못 뜨면
//   "캐시 장애 시 fallback" 실험 자체가 성립하지 않는다.
await initCache().catch((err) => {
  process.stderr.write(`cache_init_failed ${err.message}\n`);
});

// Phase 08: 비동기 경로일 때만 큐에 붙는다.
// 동기 경로에서 불필요한 연결을 만들지 않는다.
if (process.env.ASYNC_WRITE === '1') {
  await initQueue().catch((err) => {
    process.stderr.write(`mq_init_failed ${err.message}\n`);
  });
}

app.listen({ port, host: '0.0.0.0', backlog })
  .then(() => process.stdout.write(
    `app listening on ${port} scheme=${tlsMode === 'off' ? 'http' : 'https'} `
    + `tlsMode=${tlsMode} poolMax=${poolConfig.max} pid=${process.pid} `
    + `cpuBurn=${overloadConfig.cpuBurnMs}ms(${burnIters}iter/ms,${overloadConfig.cpuBurnAsync ? 'async' : 'sync'}) `
    + `alloc=${overloadConfig.allocKb}KB shed(inflight=${overloadConfig.shedInflight},lag=${overloadConfig.shedLoopLagMs}ms) `
    + `timeout=${overloadConfig.requestTimeoutMs}ms `
    + `cache=${cacheStats().mode}(ttl=${cacheStats().ttlMs}ms,jitter=${cacheStats().jitter},sf=${cacheStats().singleflight ? 1 : 0},redis=${cacheStats().redisReady ? 'up' : 'down'}) `
    + `async=${process.env.ASYNC_WRITE === '1' ? 1 : 0}(mq=${queueStats().ready ? 'up' : 'down'},gate=${process.env.STOCK_GATE === '1' ? 1 : 0})\n`,
  ))
  .catch((err) => {
    process.stderr.write(`listen_failed ${err.message}\n`);
    process.exit(1);
  });

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// 순서가 전부다. 프로세스를 먼저 죽이고 LB 가 나중에 아는 게 아니라,
// LB 가 먼저 빼고 그 다음에 죽어야 한다.
//
//   1) readiness 를 내린다        -> 헬스체크가 503 을 받기 시작
//   2) LB 가 감지할 때까지 기다린다 -> ★ 이걸 빼면 1)이 아무 의미가 없다
//   3) 새 커넥션 수락 중단 + 처리 중인 요청 완료 대기 (app.close)
//   4) 자원 정리
//
// DRAIN_WAIT_MS=0 이면 2)가 없는 상태 = 죽은 구간이 그대로 발생한다.
// 실험 (e) 에서 0 과 (interval x fall) 이상을 비교한다.
// ---------------------------------------------------------------------------
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    ready = false;
    process.stdout.write(`shutdown: readiness=false, draining ${DRAIN_WAIT_MS}ms\n`);
    if (DRAIN_WAIT_MS > 0) await sleep(DRAIN_WAIT_MS);

    stopLoopLagProbe();
    workerMetricsServer?.close();
    await app.close();
    await closeQueue();
    await closeCache();
    await closeDb();
    process.stdout.write('shutdown: complete\n');
    process.exit(0);
  });
}
