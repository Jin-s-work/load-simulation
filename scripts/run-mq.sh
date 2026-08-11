#!/usr/bin/env bash
# Phase 08 실행 래퍼 — 쓰기 경로를 큐로 분리한다.
#
# 판정은 동기(Redis DECR 선점), 반영은 비동기(큐 -> 워커 -> DB).
# 그래야 "매진인데 202 주고 나중에 취소 통보" 를 피할 수 있다.
#
# ★ CPU 배분: Phase 06~07 은 총 앱 CPU 2.4 로 고정했지만,
#   이 Phase 는 "큐로 분리하면 천장이 올라가는가" 를 재야 하므로
#   max-* 실험에서만 제약을 푼다. 그 런은 이전 Phase 와 직접 비교할 수 없다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-mq.sh <실험이름>   (목록은 --list)}"

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
export TX_HOLD_MS=0 SLOW_QUERY=0 TX_OPTIMIZED=1
export DB_HOST=pgbouncer DB_PORT=6432
export PGB_POOL_MODE=transaction PGB_DEFAULT_POOL_SIZE=20 PGB_MAX_CLIENT_CONN=1000
export PGB_RESERVE_POOL_SIZE=0 PGB_CPUS=1.0
export REDIS_CPUS=0.5 REDIS_MAXMEMORY=128mb
export CACHE_MODE=redis CACHE_TTL_MS=3000 CACHE_TTL_JITTER=0.3 SINGLEFLIGHT=0
export ASYNC_WRITE=0 STOCK_GATE=0 MQ_CONFIRM=1 MQ_MAX_RETRY=3
export MQ_CPUS=1.0 WORKER_CPUS=0.4 MQ_PREFETCH=20

RATE=600; DURATION=90s; KEY_DIST=zipf
TARGET="http://haproxy:8000"
WORKERS=0            # 0 = 워커 없음(동기 모드)
SPIKE=0              # 1 = 3000 RPS 스파이크 시나리오
DUP_INJECT=0         # 1 = 중복 메시지 강제 주입

case "$EXP" in
  --list)
    cat <<'EOF'
  [동기 vs 비동기 — 총 앱 CPU 2.4 고정]
  sync-base        동기 (Phase 07 구성 그대로)
  async-w1         비동기 + 워커 1
  async-w2         비동기 + 워커 2
  async-w4         비동기 + 워커 4

  [최대 RPS — CPU 제약 해제. 이전 Phase 와 비교 불가]
  max-sync         동기, 앱 cpus 제한 완화
  max-async        비동기, 앱 cpus 제한 완화 + 워커 4

  [스파이크 3000 RPS × 30초]
  spike-sync       동기로 스파이크를 받는다
  spike-async-w1   비동기 + 워커 1  <- 큐 depth 가 가장 크게 자란다
  spike-async-w4   비동기 + 워커 4  <- 복구가 빠른지

  [멱등성 / DLQ]
  dup-inject       같은 메시지를 강제로 두 번 발행
EOF
    exit 0 ;;

  sync-base)      WORKERS=0 ;;
  async-w1)       export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=1 ;;
  async-w2)       export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=2 ;;
  async-w4)       export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=4 ;;

  # CPU 제약 해제. 앱이 쓸 수 있는 만큼 쓰게 둔다.
  max-sync)       export APP_CPUS=2.0; WORKERS=0; RATE=1500 ;;
  max-async)      export APP_CPUS=2.0 ASYNC_WRITE=1 STOCK_GATE=1 WORKER_CPUS=0.5; WORKERS=4; RATE=1500 ;;

  spike-sync)     WORKERS=0; SPIKE=1 ;;
  spike-async-w1) export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=1; SPIKE=1 ;;
  spike-async-w4) export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=4; SPIKE=1 ;;

  dup-inject)     export ASYNC_WRITE=1 STOCK_GATE=1; WORKERS=1; DUP_INJECT=1; RATE=200; DURATION=40s ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-mq.sh --list)"; exit 1 ;;
esac

# 워커 수에 따라 profile 을 고른다.
PROFILES=()
case "$WORKERS" in
  0) ;;
  1) PROFILES=(--profile mq) ;;
  2) PROFILES=(--profile mq --profile mq2) ;;
  4) PROFILES=(--profile mq --profile mq2 --profile mq4) ;;
esac
WORKER_LIST=""
[ "$WORKERS" -ge 1 ] && WORKER_LIST="worker"
[ "$WORKERS" -ge 2 ] && WORKER_LIST="$WORKER_LIST worker2"
[ "$WORKERS" -ge 4 ] && WORKER_LIST="$WORKER_LIST worker3 worker4"

mkdir -p results
find ./db ./k6 ./prometheus ./app ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true
PSQL=(docker compose exec -T postgres psql -q -U lts -d lts)
RMQ=(docker compose exec -T rabbitmq rabbitmqctl)

echo "==> 실험: ${EXP}"
echo "    모드: $([ "$ASYNC_WRITE" = 1 ] && echo '비동기(202)' || echo '동기(201)')  워커 ${WORKERS}대  선점게이트=${STOCK_GATE}"
echo "    앱 cpus=${APP_CPUS} × 3대   부하 ${RATE} RPS / ${DURATION} / ${KEY_DIST}"
[ "$SPIKE" = 1 ] && echo "    ★ 스파이크 시나리오: 3000 RPS × 30초"
[ "$DUP_INJECT" = 1 ] && echo "    ★ 중복 메시지 강제 주입"

echo "==> 인프라 기동 (redis, rabbitmq, pgbouncer)"
docker compose up -d --force-recreate --no-deps redis rabbitmq pgbouncer >/dev/null 2>&1
for _ in $(seq 1 60); do
  docker compose exec -T rabbitmq rabbitmq-diagnostics -q ping >/dev/null 2>&1 && break; sleep 2
done
docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1 || true
# 큐를 비운다. 이전 런이 남긴 메시지가 이번 랙 측정을 오염시킨다.
docker compose exec -T rabbitmq rabbitmqctl purge_queue reservations >/dev/null 2>&1 || true
docker compose exec -T rabbitmq rabbitmqctl purge_queue reservations.dlq >/dev/null 2>&1 || true

echo "==> 앱 3대 · LB · 워커 재기동"
docker rm -f lts-app4 lts-app5 lts-app6 >/dev/null 2>&1 || true
docker compose --profile mq --profile mq2 --profile mq4 rm -fs worker worker2 worker3 worker4 >/dev/null 2>&1 || true
docker compose ${PROFILES[@]+"${PROFILES[@]}"} up -d --build --force-recreate --no-deps \
  app1 app2 app3 haproxy ${WORKER_LIST} >/dev/null 2>&1

for _ in $(seq 1 45); do
  curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 && break; sleep 1
done
if curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1; then
  echo "    healthz OK"
  docker logs lts-app1 2>&1 | grep -a "async=" | tail -1 | sed 's/^/    /'
else
  echo "    !! 기동 실패"; docker logs lts-app1 --tail 12 2>&1 | sed 's/^/    /'
fi

echo "==> DB 초기화 (재고 희소화)"
"${PSQL[@]}" < db/reset-scarce.sql 2>&1 | grep -aE "^ *[0-9]+ \| *[0-9]+" | tail -1 | sed 's/^/    총재고|이벤트수:/'

# ★ Redis 재고 카운터를 DB 값으로 채운다.
#   이걸 안 하면 선점 게이트가 0 부터 시작해 전부 거절한다.
if [ "$STOCK_GATE" = "1" ]; then
  echo "==> Redis 재고 카운터 시딩"
  "${PSQL[@]}" -tAc "select 'SET stock:'||id||' '||remaining from events" 2>/dev/null \
    | docker compose exec -T redis redis-cli --pipe >/dev/null 2>&1 || true
  echo "    stock 키: $(docker compose exec -T redis redis-cli DBSIZE 2>/dev/null | tr -d '\r')"
fi
sleep 2

# ── 샘플러 ────────────────────────────────────────────────────────────────
rm -f "results/${EXP}.stats.csv" "results/${EXP}.mq.csv" "results/${EXP}.stock.csv"

( while true; do t=$(date +%s)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
    | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"
  sleep 2; done ) & STATPID=$!

# 큐 depth 와 컨슈머 랙. 이 Phase 의 핵심 지표다.
#   messages       큐에 쌓인 총 메시지 (= 컨슈머 랙)
#   messages_ready 아직 아무 워커도 안 집어간 것
#   messages_unack 워커가 집었지만 아직 ack 안 한 것
echo "ts,messages,ready,unacked,dlq,publish_rate,deliver_rate" > "results/${EXP}.mq.csv"
( while true; do
  t=$(date +%s)
  r=$(docker compose exec -T rabbitmq rabbitmqctl list_queues -q --no-table-headers \
        name messages messages_ready messages_unacknowledged 2>/dev/null \
      | awk '$1=="reservations"{m=$2;rd=$3;un=$4} $1=="reservations.dlq"{d=$2}
             END{print (m+0)","(rd+0)","(un+0)","(d+0)}')
  [ -n "$r" ] && echo "${t},${r},," >> "results/${EXP}.mq.csv"
  sleep 2
done ) & MQPID=$!

echo "ts,sold_out_events,remaining_total,reservations" > "results/${EXP}.stock.csv"
( while true; do
  t=$(date +%s)
  r=$(docker compose exec -T postgres psql -tA -U lts -d lts -F',' -c \
    "select count(*) filter (where remaining<=0), coalesce(sum(remaining),0) from events" 2>/dev/null | tr -d ' ')
  n=$(docker compose exec -T postgres psql -tA -U lts -d lts -c "select count(*) from reservations" 2>/dev/null | tr -d ' ')
  [ -n "$r" ] && echo "${t},${r},${n:-0}" >> "results/${EXP}.stock.csv"
  sleep 2
done ) & STOCKPID=$!

trap 'kill "$STATPID" "$MQPID" "$STOCKPID" 2>/dev/null || true' EXIT

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

K6_SCRIPT=/scripts/lb-test.js
K6_EXTRA=()
if [ "$SPIKE" = 1 ]; then
  K6_EXTRA=(-e SPIKE=1 -e SPIKE_RATE=3000 -e SPIKE_SEC=30)
fi
[ "$DUP_INJECT" = 1 ] && K6_EXTRA+=(-e DUP_RATIO=0.5)

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" -e BASE_URL="$TARGET" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e LABEL="$EXP" -e KEY_DIST="$KEY_DIST" \
  ${K6_EXTRA[@]+"${K6_EXTRA[@]}"} \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  "$K6_SCRIPT" 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

# 부하가 끝난 뒤 큐가 비는 데 걸리는 시간 = 복구 시간.
if [ "$WORKERS" -ge 1 ]; then
  echo "==> 큐 배수(drain) 대기 — 복구 시간 측정"
  DRAIN_START=$(date +%s)
  for _ in $(seq 1 120); do
    left=$(docker compose exec -T rabbitmq rabbitmqctl list_queues -q --no-table-headers name messages 2>/dev/null \
           | awk '$1=="reservations"{print $2+0}')
    [ "${left:-0}" -le 0 ] && break
    sleep 2
  done
  DRAIN_SEC=$(( $(date +%s) - DRAIN_START ))
  echo "    큐가 비는 데 ${DRAIN_SEC}초"
else
  DRAIN_SEC=0
fi

END_EPOCH=$(date +%s)
kill "$STATPID" "$MQPID" "$STOCKPID" 2>/dev/null || true
trap - EXIT

FINAL_RES=$("${PSQL[@]}" -tAc "select count(*) from reservations" 2>/dev/null | tr -d ' ')
DLQ_N=$(docker compose exec -T rabbitmq rabbitmqctl list_queues -q --no-table-headers name messages 2>/dev/null \
        | awk '$1=="reservations.dlq"{print $2+0}')

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}", "phase": 8,
  "rate": ${RATE}, "keyDist": "${KEY_DIST}", "apps": 3, "appCpus": ${APP_CPUS},
  "asyncWrite": ${ASYNC_WRITE}, "stockGate": ${STOCK_GATE},
  "workers": ${WORKERS}, "workerCpus": ${WORKER_CPUS}, "prefetch": ${MQ_PREFETCH},
  "spike": ${SPIKE}, "dupInject": ${DUP_INJECT},
  "drainSec": ${DRAIN_SEC},
  "finalReservations": ${FINAL_RES:-0},
  "dlqMessages": ${DLQ_N:-0},
  "startEpoch": ${START_EPOCH}, "endEpoch": ${END_EPOCH}, "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})  예약행=${FINAL_RES:-0}  DLQ=${DLQ_N:-0}  drain=${DRAIN_SEC}s"
