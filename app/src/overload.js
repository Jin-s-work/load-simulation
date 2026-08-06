// Phase 04: 앱서버의 물리적 한계를 만들고, 그 한계에 대응하는 장치들.
//
// 두 종류가 섞여 있다. 헷갈리지 않게 구분해 둔다.
//   [부하 주입]  CPU_BURN_MS, ALLOC_KB   -> 일부러 자원을 태운다 (실험용)
//   [보호 장치]  MAX_CONCURRENT, SHED_*  -> 과부하에서 살아남는다 (개선용)

import crypto from 'node:crypto';
import { overloadMetrics } from './metrics.js';

// ---------------------------------------------------------------------------
// [부하 주입] (a) CPU: 이벤트 루프를 막는 동기 연산
// ---------------------------------------------------------------------------
// pbkdf2Sync 를 쓰는 이유: 순수 계산이고, 반복 횟수로 시간을 정밀하게 조절할 수 있고,
// 무엇보다 **동기 함수라 이벤트 루프를 실제로 막는다.**
// 비동기 버전(pbkdf2)을 쓰면 libuv 스레드풀에서 돌아 루프를 막지 않는다.
// 그 차이 자체가 실험 (c) 의 주제이므로 둘 다 쓸 수 있게 해 둔다.
const CPU_BURN_MS = Number(process.env.CPU_BURN_MS ?? 0);
const CPU_BURN_ASYNC = process.env.CPU_BURN_ASYNC === '1';

// 이 환경에서 pbkdf2 1회가 대략 몇 ms 인지 기동 시 한 번 재서 반복 횟수를 정한다.
// 하드코딩하면 다른 기계에서 전혀 다른 부하가 된다.
let iterationsPerMs = 0;
export function calibrateCpuBurn() {
  if (CPU_BURN_MS <= 0) return 0;
  const PROBE = 20000;
  const t0 = process.hrtime.bigint();
  crypto.pbkdf2Sync('probe', 'salt', PROBE, 32, 'sha256');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  iterationsPerMs = Math.max(1, Math.round(PROBE / ms));
  return iterationsPerMs;
}

export function burnCpu() {
  if (CPU_BURN_MS <= 0) return undefined;
  const iters = iterationsPerMs * CPU_BURN_MS;

  if (CPU_BURN_ASYNC) {
    // libuv 스레드풀에서 실행된다 -> 메인 스레드(이벤트 루프)는 막히지 않는다.
    // 대신 UV_THREADPOOL_SIZE 개수만큼만 동시에 돌 수 있다.
    return new Promise((resolve, reject) => {
      crypto.pbkdf2('x', 'salt', iters, 32, 'sha256', (err) => (err ? reject(err) : resolve()));
    });
  }
  // 메인 스레드에서 실행된다 -> 이 시간 동안 서버 전체가 멈춘다.
  crypto.pbkdf2Sync('x', 'salt', iters, 32, 'sha256');
  return undefined;
}

// ---------------------------------------------------------------------------
// [부하 주입] (b) 메모리: 요청당 많은 객체를 만들어 GC 를 압박한다
// ---------------------------------------------------------------------------
// 처음엔 큰 문자열('x'.repeat(...))을 썼는데 **전혀 압박이 생기지 않았다.**
// 컨테이너 안에서 직접 재 본 결과:
//     문자열 1MB x 200개 -> heap 3.6MB -> 4.3MB   (거의 안 늘어남)
//     객체 2만개 x 200배열 -> heap 3.6MB -> 197MB (제대로 늘어남)
// 큰 문자열은 V8 의 large object space 로 가고 단일 문자 반복은 최적화되기도 한다.
// GC 를 실제로 괴롭히는 것은 **작은 객체가 아주 많은 경우**다. young generation 을
// 계속 채워서 scavenge 를 유발하고, 살아남은 것들이 old space 로 승격되며 major GC 를 부른다.
//
// 주의: 객체 할당은 CPU 도 쓴다. (b) 는 메모리만 순수하게 분리하지 못한다. lab 문서에 기록한다.
const ALLOC_KB = Number(process.env.ALLOC_KB ?? 0);
// 만든 객체를 잠깐 붙잡아 둬야 GC 가 바로 회수하지 못한다. 붙잡는 개수.
const ALLOC_HOLD = Number(process.env.ALLOC_HOLD ?? 200);
const holder = [];

// 실측: 객체 하나가 대략 50바이트였다 (20000개 ≈ 1MB).
const BYTES_PER_OBJECT = 50;

export function allocateGarbage() {
  if (ALLOC_KB <= 0) return;
  const count = Math.max(1, Math.floor((ALLOC_KB * 1024) / BYTES_PER_OBJECT));
  const arr = new Array(count);
  for (let i = 0; i < count; i += 1) arr[i] = { k: i, v: i * 2, ref: null };
  holder.push(arr);
  while (holder.length > ALLOC_HOLD) holder.shift();
}

// ---------------------------------------------------------------------------
// [보호 장치] bulkhead — 동시에 처리하는 요청 수를 제한한다
// ---------------------------------------------------------------------------
// "격벽"이라는 뜻이다. 배에 격벽이 있으면 한 구역이 침수돼도 배 전체가 가라앉지 않는다.
// 여기서는 "동시에 N개까지만 처리한다"로, 초과분은 아래 load shedding 이 처리한다.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 0);

// ---------------------------------------------------------------------------
// [보호 장치] load shedding — 큐가 길면 즉시 503 을 반환한다
// ---------------------------------------------------------------------------
// 핵심은 "빨리" 다. 느리게 실패하면 자원을 쓰고도 실패하는 최악이 된다.
// 판단 근거를 두 가지 둔다:
//   1) in-flight 개수      -> 지금 얼마나 밀려 있나 (직접적)
//   2) 이벤트 루프 지연     -> 스레드가 얼마나 막혀 있나 (근본적)
const SHED_INFLIGHT = Number(process.env.SHED_INFLIGHT ?? 0);
const SHED_LOOP_LAG_MS = Number(process.env.SHED_LOOP_LAG_MS ?? 0);

// 이벤트 루프 지연을 싸게 측정한다.
// prom-client 의 히스토그램은 스크레이프 시점에만 읽히므로 요청마다 보기엔 부적합하다.
// setInterval 로 예약한 시각과 실제 실행 시각의 차이가 곧 루프가 막힌 시간이다.
let loopLagMs = 0;
const LAG_INTERVAL_MS = 100;
let lagTimer = null;

export function startLoopLagProbe() {
  let expected = Date.now() + LAG_INTERVAL_MS;
  lagTimer = setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - expected);
    expected = now + LAG_INTERVAL_MS;
    overloadMetrics.loopLagGauge.set(loopLagMs);
  }, LAG_INTERVAL_MS);
  lagTimer.unref?.();
}

export function stopLoopLagProbe() {
  if (lagTimer) clearInterval(lagTimer);
}

export function currentLoopLagMs() {
  return loopLagMs;
}

/**
 * 이 요청을 지금 받아도 되는지 판단한다.
 * 받으면 안 되면 이유를 돌려주고, 호출부는 즉시 503 을 반환한다.
 *
 * @param {number} inFlight 현재 처리 중인 요청 수
 * @returns {null | {reason: string, detail: string}}
 */
export function shouldShed(inFlight) {
  if (MAX_CONCURRENT > 0 && inFlight > MAX_CONCURRENT) {
    return { reason: 'bulkhead', detail: `inFlight=${inFlight} > ${MAX_CONCURRENT}` };
  }
  if (SHED_INFLIGHT > 0 && inFlight > SHED_INFLIGHT) {
    return { reason: 'queue_length', detail: `inFlight=${inFlight} > ${SHED_INFLIGHT}` };
  }
  if (SHED_LOOP_LAG_MS > 0 && loopLagMs > SHED_LOOP_LAG_MS) {
    return { reason: 'loop_lag', detail: `lag=${loopLagMs}ms > ${SHED_LOOP_LAG_MS}ms` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// [보호 장치] 타임아웃 — 정해진 시간 안에 못 끝내면 포기한다
// ---------------------------------------------------------------------------
// 주의: 이건 "응답을 포기"할 뿐 실제 작업을 중단시키지는 못한다.
// 이미 시작한 DB 트랜잭션은 계속 돈다. 그래서 타임아웃만으로는 부족하고,
// 애초에 받지 않는 load shedding 과 같이 써야 한다. 이 한계를 lab 문서에 기록한다.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 0);

export function withTimeout(promise) {
  if (REQUEST_TIMEOUT_MS <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        const e = new Error('REQUEST_TIMEOUT');
        e.code = 'REQUEST_TIMEOUT';
        reject(e);
      }, REQUEST_TIMEOUT_MS);
      t.unref?.();
    }),
  ]);
}

export const overloadConfig = {
  cpuBurnMs: CPU_BURN_MS,
  cpuBurnAsync: CPU_BURN_ASYNC,
  allocKb: ALLOC_KB,
  allocHold: ALLOC_HOLD,
  maxConcurrent: MAX_CONCURRENT,
  shedInflight: SHED_INFLIGHT,
  shedLoopLagMs: SHED_LOOP_LAG_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? '(기본 4)',
};
