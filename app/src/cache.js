import { createClient } from 'redis';
import { cacheLookups, cacheLoads, cacheErrors, redisOpDuration } from './metrics.js';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// ── 손잡이 ────────────────────────────────────────────────────────────────
//   off     캐시 없음 (기준선)
//   local   프로세스 메모리만.        앱 N대면 같은 키에 miss 가 N번 난다
//   redis   공유 캐시만.              miss 는 한 번이지만 매번 네트워크 왕복
//   tiered  local -> redis -> DB.     대부분 로컬에서 끝나되 공유 이득도 챙긴다
export const CACHE_MODE = process.env.CACHE_MODE || 'off';

const TTL_MS = num(process.env.CACHE_TTL_MS, 3000);
// 0 이면 모든 키가 같은 시각에 만료된다 = stampede 를 만드는 조건.
// 0.3 이면 TTL 의 ±30% 로 흩어진다.
const TTL_JITTER = num(process.env.CACHE_TTL_JITTER, 0);
const SINGLEFLIGHT = process.env.SINGLEFLIGHT === '1';
const LOCAL_MAX = num(process.env.CACHE_LOCAL_MAX, 5000);

const useLocal = CACHE_MODE === 'local' || CACHE_MODE === 'tiered';
const useRedis = CACHE_MODE === 'redis' || CACHE_MODE === 'tiered';

/** TTL 에 지터를 섞는다. 같이 넣은 키가 같이 만료되는 것을 막는다. */
function ttlWithJitter() {
  if (TTL_JITTER <= 0) return TTL_MS;
  const delta = TTL_MS * TTL_JITTER;
  return Math.round(TTL_MS - delta + Math.random() * 2 * delta);
}

// ── 로컬 캐시 ─────────────────────────────────────────────────────────────
// Map 은 삽입 순서를 유지하므로, 상한을 넘으면 가장 오래된 것부터 지운다(대략 FIFO).
// 정확한 LRU 가 필요할 만큼 키가 많지 않다(이벤트 1000개).
const local = new Map();

function localGet(key) {
  const e = local.get(key);
  if (!e) return undefined;
  if (e.expires <= Date.now()) { local.delete(key); return undefined; }
  return e.value;
}

function localSet(key, value) {
  if (local.size >= LOCAL_MAX) {
    const oldest = local.keys().next().value;
    if (oldest !== undefined) local.delete(oldest);
  }
  local.set(key, { value, expires: Date.now() + ttlWithJitter() });
}

function localDel(key) { local.delete(key); }

// ── Redis ─────────────────────────────────────────────────────────────────
let redis = null;
export let redisReady = false;

export async function initCache() {
  if (!useRedis) return;
  redis = createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
      // 재연결을 무한정 빠르게 시도하면 Redis 가 죽었을 때 앱이 CPU 를 태운다.
      reconnectStrategy: (retries) => Math.min(200 * 2 ** retries, 5000),
      connectTimeout: 500,
    },
  });
  // ★ 이 핸들러가 없으면 Redis 가 죽는 순간 unhandled error 로 프로세스가 죽는다.
  //   Phase 07 의 fallback 실험이 "앱이 같이 죽는다" 로 끝나버린다.
  redis.on('error', () => { redisReady = false; cacheErrors.inc({ op: 'connection' }); });
  redis.on('ready', () => { redisReady = true; });
  redis.on('end', () => { redisReady = false; });
  try {
    await redis.connect();
    redisReady = true;
  } catch {
    redisReady = false;
  }
}

async function redisGet(key) {
  if (!redis || !redisReady) return undefined;
  const t = process.hrtime.bigint();
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    cacheErrors.inc({ op: 'get' });
    return undefined;          // ★ Redis 실패는 miss 로 강등한다. 요청을 죽이지 않는다.
  } finally {
    redisOpDuration.observe(Number(process.hrtime.bigint() - t) / 1e9);
  }
}

async function redisSet(key, value) {
  if (!redis || !redisReady) return;
  try {
    await redis.set(key, JSON.stringify(value), { PX: ttlWithJitter() });
  } catch { cacheErrors.inc({ op: 'set' }); }
}

async function redisDel(key) {
  if (!redis || !redisReady) return;
  try { await redis.del(key); } catch { cacheErrors.inc({ op: 'del' }); }
}

// ── singleflight ──────────────────────────────────────────────────────────
// 같은 키에 대한 동시 miss 를 하나로 합친다.
//
// Node 는 단일 스레드라 락이 필요 없다. 진행 중인 Promise 를 Map 에 담아 두고
// 뒤따라온 요청이 같은 Promise 를 await 하면 그만이다.
//
// ★ 한계: 프로세스 안에서만 유효하다. 앱 6대면 여전히 6번 DB 로 간다.
//   전역으로 하려면 Redis 락이 필요하고, 그건 또 다른 왕복 비용이다.
const inflight = new Map();

function singleflight(key, fn) {
  if (!SINGLEFLIGHT) return fn();
  const running = inflight.get(key);
  if (running) {
    cacheLoads.inc({ kind: 'shared' });   // 남의 로딩에 올라탔다
    return running;
  }
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── 공개 API ──────────────────────────────────────────────────────────────

/**
 * 캐시를 거쳐 값을 읽는다. 없으면 loader 로 채운다 (cache-aside).
 *
 * write-through / write-behind 를 쓰지 않는 이유:
 *   재고 차감은 `UPDATE ... WHERE remaining >= ?` 라는 조건부 원자 연산이다.
 *   write-through 는 이 원자성을 캐시 계층에서 재현해야 하고,
 *   write-behind 는 돈이 걸린 재고에서 유실 가능성을 받아들이는 것이다.
 *   이 라우트의 성격이 cache-aside 를 강제한다.
 */
export async function cacheGet(key, loader) {
  if (CACHE_MODE === 'off') {
    cacheLoads.inc({ kind: 'db' });
    return loader();
  }

  if (useLocal) {
    const v = localGet(key);
    if (v !== undefined) { cacheLookups.inc({ layer: 'local', result: 'hit' }); return v; }
    cacheLookups.inc({ layer: 'local', result: 'miss' });
  }

  return singleflight(key, async () => {
    // singleflight 를 통과한 뒤 로컬을 다시 본다.
    // 앞선 요청이 방금 채웠을 수 있다.
    if (useLocal) {
      const again = localGet(key);
      if (again !== undefined) return again;
    }

    if (useRedis) {
      const v = await redisGet(key);
      if (v !== undefined) {
        cacheLookups.inc({ layer: 'redis', result: 'hit' });
        if (useLocal) localSet(key, v);
        return v;
      }
      cacheLookups.inc({ layer: 'redis', result: 'miss' });
    }

    cacheLoads.inc({ kind: 'db' });
    const fresh = await loader();
    if (fresh !== undefined && fresh !== null) {
      if (useLocal) localSet(key, fresh);
      if (useRedis) await redisSet(key, fresh);
    }
    return fresh;
  });
}

/** 캐시에 직접 넣는다 (DB 가 진실을 알려준 직후 등). */
export async function cachePut(key, value) {
  if (CACHE_MODE === 'off') return;
  if (useLocal) localSet(key, value);
  if (useRedis) await redisSet(key, value);
}

/**
 * 무효화.
 *
 * ★ 로컬 계층은 **다른 인스턴스에 전파되지 않는다.** 자기 프로세스만 지운다.
 *   앱 N대면 나머지 N-1대는 TTL 이 끝날 때까지 옛 값을 본다.
 *   이게 로컬 캐시의 근본 한계이고, TTL 을 짧게 잡아야 하는 이유다.
 */
export async function cacheInvalidate(key) {
  if (CACHE_MODE === 'off') return;
  if (useLocal) localDel(key);
  if (useRedis) await redisDel(key);
}

export function cacheStats() {
  return {
    mode: CACHE_MODE,
    ttlMs: TTL_MS,
    jitter: TTL_JITTER,
    singleflight: SINGLEFLIGHT,
    localSize: local.size,
    redisReady,
  };
}

export async function closeCache() {
  if (redis) { try { await redis.quit(); } catch { /* 종료 중 실패는 무시 */ } }
}
