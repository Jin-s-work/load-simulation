#!/usr/bin/env bash
# Phase 09 최종 검증 래퍼.
#
# 구성은 Phase 08 의 max-async 를 그대로 쓴다 — 그게 SLO 를 처음 만족한 조합이다.
#   앱 3대(cpus 2.0) + Redis 캐시 + 선점게이트 + RabbitMQ + 워커 4대 + PgBouncer
#
# 시나리오 셋은 각각 다른 것을 본다.
#   soak    1000 RPS × 10분.  처리량이 아니라 **시간에 따른 열화**(메모리 누수)
#   spike   0 -> 2000 RPS.    탄력성
#   fault   1000 RPS 중 앱 1대 kill.  장애 내성
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-final.sh <soak|spike|fault>}"

# ── Phase 08 max-async 구성 ───────────────────────────────────────────────
export APP_CPUS=2.0 APP_MEM=512m
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
export ASYNC_WRITE=1 STOCK_GATE=1 MQ_CONFIRM=1 MQ_MAX_RETRY=3
export MQ_CPUS=1.0 WORKER_CPUS=0.5 MQ_PREFETCH=20

RATE=1000; MODE="$EXP"; KILL_APP_AT=0
# ★ 재고를 시나리오마다 다르게 잡는다.
#   Phase 07~08 의 29,000석을 10분 soak 에 쓰면 1분 만에 다 팔리고
#   나머지 9분은 캐시가 409 만 내보낸다 — 쓰기 경로가 놀아서 누수를 못 본다.
#   soak 은 10분 내내 쓰기가 돌도록 넉넉히 준다.
STOCK_PER_EVENT=20

case "$EXP" in
  soak)   RATE=1000; STOCK_PER_EVENT=800 ;;   # 1000 RPS × 600s, 쓰기가 계속 돌게
  spike)  RATE=2000; STOCK_PER_EVENT=800 ;;
  fault)  RATE=1000; STOCK_PER_EVENT=800; KILL_APP_AT=90 ;;
  *) echo "알 수 없는 시나리오: $EXP"; exit 1 ;;
esac

mkdir -p results
find ./db ./k6 ./prometheus ./app ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true
PSQL=(docker compose exec -T postgres psql -q -U lts -d lts)

wait_port() {   # 절전에서 매달리지 않는 대기 (Phase 08 사고 대응)
  local port="$1" name="$2" max="${3:-120}" i=0
  while [ "$i" -lt "$max" ]; do
    (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null && { exec 3<&- 3>&-; return 0; }
    sleep 1; i=$((i+1))
  done
  echo "    !! ${name} 포트 ${port} 대기 초과 (${max}s)"; return 1
}

echo "==> 최종 검증: ${EXP}"
echo "    구성: 앱3대(cpus ${APP_CPUS}) + Redis캐시 + 선점게이트 + RabbitMQ + 워커4대 + PgBouncer"
echo "    부하: ${RATE} RPS  이벤트당 재고 ${STOCK_PER_EVENT}석"
[ "$KILL_APP_AT" -gt 0 ] && echo "    ★ 부하 시작 ${KILL_APP_AT}초에 app1 을 강제 종료한다"

echo "==> 인프라 기동"
docker compose up -d --force-recreate --no-deps redis rabbitmq pgbouncer >/dev/null 2>&1
wait_port 5672 rabbitmq 150 || true
wait_port 6379 redis 60 || true
docker compose exec -T redis redis-cli FLUSHALL >/dev/null 2>&1 || true
curl -s --max-time 5 -u lts:lts -X DELETE 'http://localhost:15672/api/queues/%2F/reservations/contents' >/dev/null 2>&1 || true
curl -s --max-time 5 -u lts:lts -X DELETE 'http://localhost:15672/api/queues/%2F/reservations.dlq/contents' >/dev/null 2>&1 || true

echo "==> 앱 3대 · LB · 워커 4대 재기동"
docker rm -f lts-app4 lts-app5 lts-app6 >/dev/null 2>&1 || true
docker compose --profile mq --profile mq2 --profile mq4 rm -fs worker worker2 worker3 worker4 >/dev/null 2>&1 || true
docker compose --profile mq --profile mq2 --profile mq4 up -d --build --force-recreate --no-deps \
  app1 app2 app3 haproxy worker worker2 worker3 worker4 >/dev/null 2>&1

for _ in $(seq 1 60); do
  curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 && break; sleep 1
done
curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 \
  && echo "    healthz OK" || { echo "    !! 기동 실패"; docker logs lts-app1 --tail 12 2>&1 | sed 's/^/    /'; }

echo "==> DB 초기화 (이벤트당 ${STOCK_PER_EVENT}석)"
"${PSQL[@]}" -c "UPDATE events SET remaining=${STOCK_PER_EVENT}, total_seats=${STOCK_PER_EVENT}, version=0;" >/dev/null
"${PSQL[@]}" -c "TRUNCATE reservations RESTART IDENTITY;" >/dev/null
# VACUUM 은 트랜잭션 안에서 못 돈다. psql 은 한 -c 에 여러 문장을 주면
# 하나의 트랜잭션으로 묶으므로 반드시 따로 실행해야 한다.
"${PSQL[@]}" -c "VACUUM ANALYZE events;" >/dev/null
"${PSQL[@]}" -c "VACUUM ANALYZE reservations;" >/dev/null
echo "    총재고: $("${PSQL[@]}" -tAc 'select sum(remaining) from events' | tr -d ' ')"

echo "==> Redis 재고 카운터 시딩"
"${PSQL[@]}" -tAc "select 'SET stock:'||id||' '||remaining from events" 2>/dev/null \
  | docker compose exec -T redis redis-cli --pipe >/dev/null 2>&1 || true
sleep 2

# ── 샘플러 ────────────────────────────────────────────────────────────────
rm -f "results/${EXP}.stats.csv" "results/${EXP}.mq.csv" "results/${EXP}.mem.csv"

( while true; do t=$(date +%s)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
    | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"
  sleep 5; done ) & STATPID=$!

echo "ts,messages,ready,unacked,dlq" > "results/${EXP}.mq.csv"
( while true; do
  t=$(date +%s)
  r=$(curl -s --max-time 3 -u lts:lts 'http://localhost:15672/api/queues/%2F' 2>/dev/null \
      | python3 -c "
import json,sys
try: qs={q['name']:q for q in json.load(sys.stdin)}
except Exception: sys.exit(1)
a=qs.get('reservations',{}); d=qs.get('reservations.dlq',{})
print(f\"{a.get('messages',0)},{a.get('messages_ready',0)},{a.get('messages_unacknowledged',0)},{d.get('messages',0)}\")
" 2>/dev/null)
  [ -n "$r" ] && echo "${t},${r}" >> "results/${EXP}.mq.csv"
  sleep 5
done ) & MQPID=$!

# ★ 누수 확인용. 앱 힙과 Postgres 사적메모리를 5초 간격으로 10분 내내 남긴다.
#   docker stats 의 컨테이너 메모리로는 힙 증가와 캐시 증가를 구분할 수 없다.
echo "ts,app_heap_mb,worker_heap_mb,pg_rssanon_mb" > "results/${EXP}.mem.csv"
( while true; do
  t=$(date +%s)
  ah=$(curl -s --max-time 3 http://localhost:9090/api/v1/query \
        --data-urlencode 'query=sum(nodejs_heap_size_used_bytes{job="app"})/1048576' 2>/dev/null \
       | python3 -c "import json,sys;r=json.load(sys.stdin)['data']['result'];print(round(float(r[0]['value'][1]),1) if r else '')" 2>/dev/null)
  wh=$(curl -s --max-time 3 http://localhost:9090/api/v1/query \
        --data-urlencode 'query=sum(nodejs_heap_size_used_bytes{job="worker"})/1048576' 2>/dev/null \
       | python3 -c "import json,sys;r=json.load(sys.stdin)['data']['result'];print(round(float(r[0]['value'][1]),1) if r else '')" 2>/dev/null)
  pg=$(docker compose exec -T postgres sh -c \
        'grep -h RssAnon /proc/[0-9]*/status 2>/dev/null | awk "{s+=\$2} END {print int(s/1024)}"' 2>/dev/null | tr -d '\r')
  echo "${t},${ah},${wh},${pg}" >> "results/${EXP}.mem.csv"
  sleep 5
done ) & MEMPID=$!

trap 'kill "$STATPID" "$MQPID" "$MEMPID" ${KILLPID:-} 2>/dev/null || true' EXIT

KILLPID=""
if [ "$KILL_APP_AT" -gt 0 ]; then
  ( sleep "$KILL_APP_AT"
    echo "    ★ app1 강제 종료 ($(date '+%H:%M:%S'))"
    docker kill lts-app1 >/dev/null 2>&1 || true ) & KILLPID=$!
fi

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" -e BASE_URL="http://haproxy:8000" \
  -e MODE="$MODE" -e RATE="$RATE" -e LABEL="$EXP" -e KEY_DIST=zipf \
  -e SOAK_MIN="${SOAK_MIN:-10}" -e FAULT_SEC="${FAULT_SEC:-180}" \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  /scripts/final.js 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)

# 큐 배수 대기 (복구 시간)
DRAIN_START=$(date +%s); DRAIN_SEC=0
for _ in $(seq 1 120); do
  left=$(curl -s --max-time 3 -u lts:lts 'http://localhost:15672/api/queues/%2F/reservations' 2>/dev/null \
         | python3 -c "import json,sys;print(json.load(sys.stdin).get('messages',0))" 2>/dev/null)
  [ "${left:-0}" -le 0 ] && break
  sleep 2
done
DRAIN_SEC=$(( $(date +%s) - DRAIN_START ))

kill "$STATPID" "$MQPID" "$MEMPID" ${KILLPID:-} 2>/dev/null || true
trap - EXIT

# app1 을 죽였으면 되살린다 (다음 시나리오를 위해)
[ "$KILL_APP_AT" -gt 0 ] && docker start lts-app1 >/dev/null 2>&1 || true

FINAL_RES=$("${PSQL[@]}" -tAc "select count(*) from reservations" 2>/dev/null | tr -d ' ')
DLQ_N=$(curl -s --max-time 3 -u lts:lts 'http://localhost:15672/api/queues/%2F/reservations.dlq' 2>/dev/null \
        | python3 -c "import json,sys;print(json.load(sys.stdin).get('messages',0))" 2>/dev/null)

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}", "phase": 9, "mode": "${MODE}",
  "rate": ${RATE}, "apps": 3, "appCpus": ${APP_CPUS}, "workers": 4,
  "stockPerEvent": ${STOCK_PER_EVENT}, "killAppAt": ${KILL_APP_AT},
  "drainSec": ${DRAIN_SEC}, "finalReservations": ${FINAL_RES:-0}, "dlqMessages": ${DLQ_N:-0},
  "startEpoch": ${START_EPOCH}, "endEpoch": ${END_EPOCH}, "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})  예약행=${FINAL_RES:-0}  DLQ=${DLQ_N:-0}  drain=${DRAIN_SEC}s"
