#!/usr/bin/env bash
# Phase 06 실행 래퍼 — 앱과 DB 사이의 커넥션 풀러(PgBouncer).
#
# 이 Phase 가 재는 것은 **처리량 확장이 아니라 커넥션 확장**이다.
#
# VM 이 6 CPU 라 앱 6대에 1.0 씩 줄 수 없다. 그래서 3대/6대 구성에서
# **총 앱 CPU 를 2.4 로 고정**한다(3×0.8 = 6×0.4).
# 이렇게 해야 "앱을 늘려서 빨라졌나" 가 아니라 "커넥션 수가 어떻게 변했나" 만 분리된다.
# Phase 04 에서 고정 CPU 를 쪼개봐야 처리량이 안 는다는 걸 이미 확인했으므로,
# 그 변수를 다시 섞을 이유가 없다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-proxy.sh <실험이름>   (목록은 --list)}"

# ── 기본값 ────────────────────────────────────────────────────────────────
export APP_MEM=512m
export CPU_BURN_MS=0 CPU_BURN_ASYNC=0 ALLOC_KB=0
export MAX_CONCURRENT=0 SHED_INFLIGHT=0 SHED_LOOP_LAG_MS=0 REQUEST_TIMEOUT_MS=0
export CLUSTER_WORKERS=1 UV_THREADPOOL_SIZE=4
export APP1_SLOW_MS=0 APP2_SLOW_MS=0 APP3_SLOW_MS=0
export APP1_DRAIN_WAIT_MS=0 APP2_DRAIN_WAIT_MS=0 APP3_DRAIN_WAIT_MS=0
export LB_ALGO=leastconn
export PG_ACQUIRE_TIMEOUT_MS=0 PG_IDLE_TIMEOUT_MS=10000 PG_MAX_LIFETIME_SEC=0
export PG_STATEMENT_TIMEOUT_MS=0 PG_LOCK_TIMEOUT_MS=0 PG_IDLE_TX_TIMEOUT_MS=0
export TX_HOLD_MS=0 SLOW_QUERY=0 TX_OPTIMIZED=0
export PG_POOL_MAX=10

# 프록시 관련
export DB_HOST=postgres DB_PORT=5432
export PGB_POOL_MODE=transaction PGB_DEFAULT_POOL_SIZE=20
export PGB_MAX_CLIENT_CONN=1000 PGB_RESERVE_POOL_SIZE=0 PGB_CPUS=1.0

APPS=3; RATE=600; DURATION=90s; HOT_RATIO=0.1
TARGET="http://haproxy:8000"
USE_PROXY=0
KILL_PROXY_AT=0     # >0 이면 그 초에 PgBouncer 를 죽인다 (SPOF 실험)

case "$EXP" in
  --list)
    cat <<'EOF'
  [프록시 없음]
  d3-direct        앱3대 직결, 풀10 -> DB 커넥션 30
  d6-direct        앱6대 직결, 풀10 -> DB 커넥션 60      <- 곱셈 확인
  d6-direct-p20    앱6대 직결, 풀20 -> DB 커넥션 120     <- max_connections(100) 초과

  [프록시 있음 · transaction 모드]
  p3-proxy         앱3대 + PgBouncer(pool 20)
  p6-proxy         앱6대 + PgBouncer(pool 20)            <- 대수와 무관함 증명
  p6-proxy-p20     앱6대 + 앱풀20 + PgBouncer(pool 20)   <- 직결이면 120 인 조건

  [모드 비교]
  p6-session       앱6대 + PgBouncer(session 모드)       <- 접힘이 안 일어난다

  [프록시 풀 크기 곡선]
  q-pool2          PgBouncer pool 2
  q-pool5          PgBouncer pool 5
  q-pool10         PgBouncer pool 10
  q-pool40         PgBouncer pool 40

  [프록시가 병목/SPOF 가 되는 지점]
  s-cpu02          PgBouncer cpus=0.2   <- 단일 스레드가 벽이 된다
  s-maxclient50    MAX_CLIENT_CONN=50   <- 프록시가 먼저 거절
  s-kill           부하 중 55초에 PgBouncer 를 죽인다    <- SPOF
EOF
    exit 0 ;;

  # ── 프록시 없음 ─────────────────────────────────────────────────────────
  d3-direct)      APPS=3; export PG_POOL_MAX=10 ;;
  d6-direct)      APPS=6; export PG_POOL_MAX=10 ;;
  d6-direct-p20)  APPS=6; export PG_POOL_MAX=20 ;;

  # ── 프록시 있음 ─────────────────────────────────────────────────────────
  p3-proxy)       APPS=3; USE_PROXY=1; export PG_POOL_MAX=10 ;;
  p6-proxy)       APPS=6; USE_PROXY=1; export PG_POOL_MAX=10 ;;
  p6-proxy-p20)   APPS=6; USE_PROXY=1; export PG_POOL_MAX=20 ;;

  p6-session)     APPS=6; USE_PROXY=1; export PG_POOL_MAX=10 PGB_POOL_MODE=session ;;

  # ── 프록시 풀 크기 곡선 (앱 6대 고정) ───────────────────────────────────
  q-pool2)        APPS=6; USE_PROXY=1; export PGB_DEFAULT_POOL_SIZE=2 ;;
  q-pool5)        APPS=6; USE_PROXY=1; export PGB_DEFAULT_POOL_SIZE=5 ;;
  q-pool10)       APPS=6; USE_PROXY=1; export PGB_DEFAULT_POOL_SIZE=10 ;;
  q-pool40)       APPS=6; USE_PROXY=1; export PGB_DEFAULT_POOL_SIZE=40 ;;

  # ── 병목 / SPOF ─────────────────────────────────────────────────────────
  s-cpu02)        APPS=6; USE_PROXY=1; export PGB_CPUS=0.2 ;;
  s-maxclient50)  APPS=6; USE_PROXY=1; export PGB_MAX_CLIENT_CONN=50 ;;
  s-kill)         APPS=6; USE_PROXY=1; KILL_PROXY_AT=55 ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-proxy.sh --list)"; exit 1 ;;
esac

# 총 앱 CPU 를 2.4 로 고정한다. 이게 이 Phase 설계의 핵심이다.
export APP_CPUS=$(awk "BEGIN{printf \"%.2f\", 2.4/${APPS}}")

if [ "$USE_PROXY" = "1" ]; then
  export DB_HOST=pgbouncer DB_PORT=6432
fi

APP_LIST="app1 app2 app3"
PROFILE=()
if [ "$APPS" = "6" ]; then
  APP_LIST="app1 app2 app3 app4 app5 app6"
  PROFILE=(--profile six)
fi

APP_POOL_TOTAL=$(( PG_POOL_MAX * APPS ))

mkdir -p results
find ./db ./k6 ./prometheus ./app ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true

PSQL=(docker compose exec -T postgres psql -q -U lts -d lts)

echo "==> 실험: ${EXP}"
echo "    앱 ${APPS}대 × cpus=${APP_CPUS}  (총 앱 CPU 2.4 고정)"
echo "    앱 풀: ${PG_POOL_MAX}/앱 × ${APPS} = ${APP_POOL_TOTAL} 개가 열리려 한다"
if [ "$USE_PROXY" = "1" ]; then
  echo "    프록시: PgBouncer ${PGB_POOL_MODE} 모드, DB쪽 풀 ${PGB_DEFAULT_POOL_SIZE}, maxClient ${PGB_MAX_CLIENT_CONN}, cpus=${PGB_CPUS}"
else
  echo "    프록시: 없음 (DB 직결)  -> DB 가 ${APP_POOL_TOTAL} 개를 그대로 받는다"
fi
echo "    부하 ${RATE} RPS / ${DURATION} / hotRatio=${HOT_RATIO}"
[ "$KILL_PROXY_AT" -gt 0 ] && echo "    ★ 부하 시작 ${KILL_PROXY_AT}초에 PgBouncer 를 죽인다"

# ── 기동 ──────────────────────────────────────────────────────────────────
# 이전 실험이 6대로 띄웠을 수 있으므로 항상 4~6 을 내린다.
docker rm -f lts-app4 lts-app5 lts-app6 >/dev/null 2>&1 || true

if [ "$USE_PROXY" = "1" ]; then
  echo "==> PgBouncer 기동"
  docker compose up -d --force-recreate --no-deps pgbouncer >/dev/null 2>&1
  for _ in $(seq 1 30); do
    docker compose exec -T pgbouncer sh -c 'PGPASSWORD=lts psql -h 127.0.0.1 -p 6432 -U lts -d pgbouncer -tAc "SHOW VERSION"' >/dev/null 2>&1 && break
    sleep 1
  done
  docker compose exec -T pgbouncer sh -c 'PGPASSWORD=lts psql -h 127.0.0.1 -p 6432 -U lts -d pgbouncer -tAc "SHOW VERSION"' 2>&1 | sed 's/^/    /' || echo "    !! PgBouncer 기동 실패"
else
  docker rm -f lts-pgbouncer >/dev/null 2>&1 || true
fi

echo "==> 앱 ${APPS}대 · LB 재기동"
# ${PROFILE[@]+...} 형태로 쓴다. macOS 기본 bash 3.2 는 set -u 에서 빈 배열을
# "${arr[@]}" 로 펼치면 unbound variable 로 죽는다.
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --build --force-recreate --no-deps ${APP_LIST} haproxy >/dev/null 2>&1

for _ in $(seq 1 45); do
  curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 && break
  sleep 1
done
if curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1; then
  echo "    healthz OK"
else
  echo "    !! 기동 실패 — 그 자체가 결과일 수 있으므로 계속 진행한다"
  docker logs lts-app1 --tail 12 2>&1 | sed 's/^/    /'
fi

# HAProxy 가 app4~6 을 UP 으로 올릴 시간을 준다 (inter × rise).
[ "$APPS" = "6" ] && sleep 6

echo "==> DB 초기화"
"${PSQL[@]}" < db/reset.sql >/dev/null
sleep 3

# ── 샘플러 ────────────────────────────────────────────────────────────────
rm -f "results/${EXP}.stats.csv" "results/${EXP}.pg.csv" "results/${EXP}.pgb.csv"

( while true; do t=$(date +%s)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
    | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"
  sleep 2; done ) & STATPID=$!

# Postgres 쪽: 실제로 몇 개의 커넥션·프로세스가 생겼나. 이게 이 Phase 의 핵심 수치다.
echo "ts,total,active,idle,idle_in_tx,waiting_locks,vmrss_kb,rssanon_kb" > "results/${EXP}.pg.csv"
( while true; do
  t=$(date +%s)
  row=$(docker compose exec -T postgres psql -tA -U lts -d lts -F',' -c "
    SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='active'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='idle'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='idle in transaction'),
      (SELECT count(*) FROM pg_locks WHERE NOT granted)
  " 2>/dev/null | tr -d ' ')
  mem=$(docker compose exec -T postgres sh -c \
    'v=$(grep -h VmRSS /proc/[0-9]*/status 2>/dev/null | awk "{s+=\$2} END {print s+0}");
     a=$(grep -h RssAnon /proc/[0-9]*/status 2>/dev/null | awk "{s+=\$2} END {print s+0}");
     echo "${v},${a}"' 2>/dev/null || echo "0,0")
  [ -n "$row" ] && echo "${t},${row},${mem:-0,0}" >> "results/${EXP}.pg.csv"
  sleep 2
done ) & PGPID=$!

# PgBouncer 쪽: SHOW POOLS.
#   cl_active  앱에서 붙어 활성인 클라이언트 커넥션
#   cl_waiting 서버 커넥션을 기다리는 클라이언트  <- 프록시 풀이 좁으면 여기가 는다
#   sv_active  DB 쪽으로 실제로 쓰고 있는 서버 커넥션
#   sv_idle    DB 쪽 유휴
#   maxwait    가장 오래 기다린 클라이언트의 대기 시간(초)
PGBPID=""
if [ "$USE_PROXY" = "1" ]; then
  echo "ts,cl_active,cl_waiting,sv_active,sv_idle,sv_used,maxwait_us" > "results/${EXP}.pgb.csv"
  ( while true; do
    t=$(date +%s)
    # 컬럼 위치는 실제 출력으로 확인했다(PgBouncer 1.23.1). 추측하면 틀린다 —
    # 1.23 이 cl_active_cancel_req / sv_active_cancel / sv_being_canceled 를 끼워 넣어
    # 예전 문서의 순서와 다르다.
    #   1 database  2 user  3 cl_active  4 cl_waiting  5 cl_active_cancel_req
    #   6 cl_waiting_cancel_req  7 sv_active  8 sv_active_cancel  9 sv_being_canceled
    #   10 sv_idle  11 sv_used  12 sv_tested  13 sv_login  14 maxwait  15 maxwait_us
    r=$(docker compose exec -T pgbouncer sh -c \
      'PGPASSWORD=lts psql -h 127.0.0.1 -p 6432 -U lts -d pgbouncer -tA -F"," -c "SHOW POOLS"' 2>/dev/null \
      | awk -F',' '$1=="lts"{ca+=$3; cw+=$4; sa+=$7; si+=$10; su+=$11; w=$14*1000000+$15; if(w>mw)mw=w}
                   END{if(NR)print ca","cw","sa","si","su","mw+0}')
    [ -n "$r" ] && echo "${t},${r}" >> "results/${EXP}.pgb.csv"
    sleep 2
  done ) & PGBPID=$!
fi

trap 'kill "$STATPID" "$PGPID" ${PGBPID:-} 2>/dev/null || true' EXIT

# SPOF 실험: 부하 도중에 프록시를 죽인다.
KILLPID=""
if [ "$KILL_PROXY_AT" -gt 0 ]; then
  ( sleep "$KILL_PROXY_AT"; echo "    ★ PgBouncer kill" ; docker kill lts-pgbouncer >/dev/null 2>&1 || true ) & KILLPID=$!
fi

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" -e BASE_URL="$TARGET" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e LABEL="$EXP" -e HOT_RATIO="$HOT_RATIO" \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  /scripts/lb-test.js 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)
kill "$STATPID" "$PGPID" ${PGBPID:-} ${KILLPID:-} 2>/dev/null || true
trap - EXIT

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}",
  "phase": 6,
  "rate": ${RATE},
  "hotRatio": ${HOT_RATIO},
  "apps": ${APPS},
  "appCpus": ${APP_CPUS},
  "poolMax": ${PG_POOL_MAX},
  "appPoolTotal": ${APP_POOL_TOTAL},
  "useProxy": ${USE_PROXY},
  "pgbPoolMode": "${PGB_POOL_MODE}",
  "pgbDefaultPoolSize": ${PGB_DEFAULT_POOL_SIZE},
  "pgbMaxClientConn": ${PGB_MAX_CLIENT_CONN},
  "pgbCpus": ${PGB_CPUS},
  "killProxyAt": ${KILL_PROXY_AT},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})"
