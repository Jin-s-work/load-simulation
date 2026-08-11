#!/usr/bin/env bash
# Phase 07 실행 래퍼 — 캐시로 DB 부하를 줄인다.
#
# ★ 전제: 재고를 희소하게 만든다(db/reset-scarce.sql).
#   기본 시드는 total_seats 가 1억이라 절대 매진되지 않고, Phase 06 마지막 런에서
#   28,196건이 전부 created 였다. 즉 이 라우트는 100% 쓰기이고 캐시가 걸릴 읽기 경로가 없다.
#   캐시가 실제로 값을 하는 지점은 **매진 이후의 거절**이다.
#
# 앱은 3대로 고정한다(Phase 06 의 6대 구성이 아니라).
# 로컬 캐시의 "앱 N대면 같은 키에 miss 가 N번" 은 3대에서도 충분히 드러나고,
# CPU 를 아껴 Redis 에 줄 수 있다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-cache.sh <실험이름>   (목록은 --list)}"

# ── 기본값 ────────────────────────────────────────────────────────────────
export APP_CPUS=0.8 APP_MEM=512m
export CPU_BURN_MS=0 CPU_BURN_ASYNC=0 ALLOC_KB=0
export MAX_CONCURRENT=0 SHED_INFLIGHT=0 SHED_LOOP_LAG_MS=0 REQUEST_TIMEOUT_MS=0
export CLUSTER_WORKERS=1 UV_THREADPOOL_SIZE=4
export APP1_SLOW_MS=0 APP2_SLOW_MS=0 APP3_SLOW_MS=0
export APP1_DRAIN_WAIT_MS=0 APP2_DRAIN_WAIT_MS=0 APP3_DRAIN_WAIT_MS=0
export LB_ALGO=leastconn
export PG_POOL_MAX=10 PG_ACQUIRE_TIMEOUT_MS=0 PG_IDLE_TIMEOUT_MS=10000
export PG_STATEMENT_TIMEOUT_MS=0 PG_LOCK_TIMEOUT_MS=0 PG_IDLE_TX_TIMEOUT_MS=0
export TX_HOLD_MS=0 SLOW_QUERY=0 TX_OPTIMIZED=1     # Phase 05 의 최적화 경로를 쓴다
export DB_HOST=pgbouncer DB_PORT=6432               # Phase 06 의 프록시를 쓴다
export PGB_POOL_MODE=transaction PGB_DEFAULT_POOL_SIZE=20
export PGB_MAX_CLIENT_CONN=1000 PGB_RESERVE_POOL_SIZE=0 PGB_CPUS=1.0
export REDIS_CPUS=0.5 REDIS_MAXMEMORY=128mb

export CACHE_MODE=off CACHE_TTL_MS=3000 CACHE_TTL_JITTER=0 SINGLEFLIGHT=0

RATE=600; DURATION=90s; KEY_DIST=uniform; HOT_RATIO=0
TARGET="http://haproxy:8000"
KILL_REDIS_AT=0
FLUSH_AT=0          # >0 이면 그 초에 캐시를 통째로 비운다 (동시 만료 강제)

case "$EXP" in
  --list)
    cat <<'EOF'
  [기준선 — 캐시 없음]
  base-uniform      균등 분포
  base-zipf         Zipf 분포 (s=1.1, 상위10키가 48%)

  [캐시 3종 × 분포 2종]
  local-uniform     로컬 캐시만
  local-zipf        로컬 캐시만        <- 앱 3대에서 miss 가 3번 나는지
  redis-uniform     Redis 만
  redis-zipf        Redis 만           <- miss 는 한 번
  tiered-uniform    로컬 + Redis 2단
  tiered-zipf       로컬 + Redis 2단

  [stampede]
  stampede          TTL 지터 0 + singleflight 없음  <- 동시 만료 폭주
  fix-jitter        TTL 지터 0.3
  fix-singleflight  singleflight 켬
  fix-both          지터 + singleflight

  [장애]
  redis-kill        부하 중 55초에 Redis 를 죽인다  <- fallback 확인

  [stampede — 동시 만료 강제]
  flush-none        55초에 FLUSHALL. 보호 없음   <- 진짜 stampede
  flush-sf          55초에 FLUSHALL + singleflight
EOF
    exit 0 ;;

  base-uniform)   KEY_DIST=uniform ;;
  base-zipf)      KEY_DIST=zipf ;;

  local-uniform)  export CACHE_MODE=local;  KEY_DIST=uniform ;;
  local-zipf)     export CACHE_MODE=local;  KEY_DIST=zipf ;;
  redis-uniform)  export CACHE_MODE=redis;  KEY_DIST=uniform ;;
  redis-zipf)     export CACHE_MODE=redis;  KEY_DIST=zipf ;;
  tiered-uniform) export CACHE_MODE=tiered; KEY_DIST=uniform ;;
  tiered-zipf)    export CACHE_MODE=tiered; KEY_DIST=zipf ;;

  # stampede: TTL 을 짧게 + 지터 0 으로 두면 같이 넣은 키가 같이 만료된다.
  # Zipf 라 핫키에 요청이 몰려 있어 만료 순간 그 키로 폭주가 생긴다.
  stampede)         export CACHE_MODE=redis CACHE_TTL_MS=1000 CACHE_TTL_JITTER=0 SINGLEFLIGHT=0; KEY_DIST=zipf ;;
  fix-jitter)       export CACHE_MODE=redis CACHE_TTL_MS=1000 CACHE_TTL_JITTER=0.3 SINGLEFLIGHT=0; KEY_DIST=zipf ;;
  fix-singleflight) export CACHE_MODE=redis CACHE_TTL_MS=1000 CACHE_TTL_JITTER=0 SINGLEFLIGHT=1; KEY_DIST=zipf ;;
  fix-both)         export CACHE_MODE=redis CACHE_TTL_MS=1000 CACHE_TTL_JITTER=0.3 SINGLEFLIGHT=1; KEY_DIST=zipf ;;

  redis-kill)       export CACHE_MODE=tiered SINGLEFLIGHT=1; KEY_DIST=zipf; KILL_REDIS_AT=55 ;;

  # TTL 만료를 기다리는 방식은 stampede 를 못 만든다.
  # 키마다 삽입 시각이 달라 만료가 자연히 흩어지기 때문이다(실측: DB 로딩 최대/평균 1.05배).
  # 동시 만료를 강제하려면 캐시를 한꺼번에 비워야 한다.
  flush-none)       export CACHE_MODE=redis CACHE_TTL_MS=30000 SINGLEFLIGHT=0; KEY_DIST=zipf; FLUSH_AT=55 ;;
  flush-sf)         export CACHE_MODE=redis CACHE_TTL_MS=30000 SINGLEFLIGHT=1; KEY_DIST=zipf; FLUSH_AT=55 ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-cache.sh --list)"; exit 1 ;;
esac

mkdir -p results
find ./db ./k6 ./prometheus ./app ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true
PSQL=(docker compose exec -T postgres psql -q -U lts -d lts)

echo "==> 실험: ${EXP}"
echo "    캐시: ${CACHE_MODE}  ttl=${CACHE_TTL_MS}ms jitter=${CACHE_TTL_JITTER} singleflight=${SINGLEFLIGHT}"
echo "    분포: ${KEY_DIST}   부하 ${RATE} RPS / ${DURATION}"
[ "$KILL_REDIS_AT" -gt 0 ] && echo "    ★ 부하 시작 ${KILL_REDIS_AT}초에 Redis 를 죽인다"
[ "$FLUSH_AT" -gt 0 ] && echo "    ★ 부하 시작 ${FLUSH_AT}초에 FLUSHALL (동시 만료 강제)"

echo "==> Redis · PgBouncer 기동"
docker compose up -d --force-recreate --no-deps redis pgbouncer >/dev/null 2>&1
for _ in $(seq 1 30); do
  docker compose exec -T redis redis-cli ping >/dev/null 2>&1 && break; sleep 1
done
docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1 || true

echo "==> 앱 3대 · LB 재기동"
docker rm -f lts-app4 lts-app5 lts-app6 >/dev/null 2>&1 || true
docker compose up -d --build --force-recreate --no-deps app1 app2 app3 haproxy >/dev/null 2>&1

for _ in $(seq 1 45); do
  curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 && break; sleep 1
done
if curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1; then
  echo "    healthz OK"
  docker logs lts-app1 2>&1 | grep -a "cache=" | tail -1 | sed 's/^/    /'
else
  echo "    !! 기동 실패"; docker logs lts-app1 --tail 12 2>&1 | sed 's/^/    /'
fi

echo "==> DB 초기화 (재고 희소화)"
"${PSQL[@]}" < db/reset-scarce.sql 2>&1 | grep -aE "총재고|[0-9]+ \| [0-9]+" | tail -2 | sed 's/^/    /'
sleep 2

# ── 샘플러 ────────────────────────────────────────────────────────────────
rm -f "results/${EXP}.stats.csv" "results/${EXP}.redis.csv" "results/${EXP}.stock.csv"

( while true; do t=$(date +%s)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
    | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"
  sleep 2; done ) & STATPID=$!

# Redis 내부. keyspace hit/miss 는 Redis 자신이 세는 값이라
# 앱이 세는 지표와 교차 검증이 된다.
echo "ts,keyspace_hits,keyspace_misses,connected_clients,used_memory_kb,evicted_keys" > "results/${EXP}.redis.csv"
( while true; do
  t=$(date +%s)
  r=$(docker compose exec -T redis redis-cli INFO 2>/dev/null | tr -d '\r' \
    | awk -F: '/^keyspace_hits:/{h=$2} /^keyspace_misses:/{m=$2} /^connected_clients:/{c=$2}
               /^used_memory:/{u=int($2/1024)} /^evicted_keys:/{e=$2}
               END{if(h!="")print h","m","c","u","e}')
  [ -n "$r" ] && echo "${t},${r}" >> "results/${EXP}.redis.csv"
  sleep 2
done ) & REDISPID=$!

# 매진 진행 상황. 캐시가 걸릴 대상이 실제로 생기는지 확인하는 용도다.
echo "ts,sold_out_events,remaining_total" > "results/${EXP}.stock.csv"
( while true; do
  t=$(date +%s)
  r=$(docker compose exec -T postgres psql -tA -U lts -d lts -F',' -c \
    "select count(*) filter (where remaining<=0), coalesce(sum(remaining),0) from events" 2>/dev/null | tr -d ' ')
  [ -n "$r" ] && echo "${t},${r}" >> "results/${EXP}.stock.csv"
  sleep 2
done ) & STOCKPID=$!

trap 'kill "$STATPID" "$REDISPID" "$STOCKPID" ${KILLPID:-} ${FLUSHPID:-} 2>/dev/null || true' EXIT

FLUSHPID=""
if [ "$FLUSH_AT" -gt 0 ]; then
  ( sleep "$FLUSH_AT"; echo "    ★ FLUSHALL"; docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1 || true ) & FLUSHPID=$!
fi

KILLPID=""
if [ "$KILL_REDIS_AT" -gt 0 ]; then
  ( sleep "$KILL_REDIS_AT"; echo "    ★ Redis kill"; docker kill lts-redis >/dev/null 2>&1 || true ) & KILLPID=$!
fi

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" -e BASE_URL="$TARGET" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e LABEL="$EXP" \
  -e KEY_DIST="$KEY_DIST" -e HOT_RATIO="$HOT_RATIO" \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  /scripts/lb-test.js 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)
kill "$STATPID" "$REDISPID" "$STOCKPID" ${KILLPID:-} ${FLUSHPID:-} 2>/dev/null || true
trap - EXIT

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}",
  "phase": 7,
  "rate": ${RATE},
  "keyDist": "${KEY_DIST}",
  "apps": 3,
  "cacheMode": "${CACHE_MODE}",
  "cacheTtlMs": ${CACHE_TTL_MS},
  "cacheTtlJitter": ${CACHE_TTL_JITTER},
  "singleflight": ${SINGLEFLIGHT},
  "killRedisAt": ${KILL_REDIS_AT},
  "flushAt": ${FLUSH_AT},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})"
