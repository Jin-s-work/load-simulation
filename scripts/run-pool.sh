#!/usr/bin/env bash
# Phase 05 실행 래퍼 — 커넥션 풀과 DB 메모리.
#
# Phase 04 와 달리 앱 3대 + HAProxy 구조로 돌린다.
# (a) 의 "앱 대수 × 풀 크기" 가 이번 Phase 의 핵심이라 여러 대가 있어야 한다.
#
# Phase 04 의 CPU/메모리 주입은 전부 끈다. 앱 CPU 가 병목이면 풀 효과가 가려진다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-pool.sh <실험이름>   (목록은 --list)}"

# ── 기본값 ────────────────────────────────────────────────────────────────
export APP_CPUS=1.2 APP_MEM=512m
export CPU_BURN_MS=0 CPU_BURN_ASYNC=0 ALLOC_KB=0        # Phase 04 주입 off
export MAX_CONCURRENT=0 SHED_INFLIGHT=0 SHED_LOOP_LAG_MS=0 REQUEST_TIMEOUT_MS=0
export CLUSTER_WORKERS=1 UV_THREADPOOL_SIZE=4
export APP1_SLOW_MS=0 APP2_SLOW_MS=0 APP3_SLOW_MS=0
export APP1_DRAIN_WAIT_MS=0 APP2_DRAIN_WAIT_MS=0 APP3_DRAIN_WAIT_MS=0
export LB_ALGO=leastconn

export PG_POOL_MAX=10 PG_ACQUIRE_TIMEOUT_MS=0 PG_IDLE_TIMEOUT_MS=10000 PG_MAX_LIFETIME_SEC=0
export PG_STATEMENT_TIMEOUT_MS=0 PG_LOCK_TIMEOUT_MS=0 PG_IDLE_TX_TIMEOUT_MS=0
export TX_HOLD_MS=0 SLOW_QUERY=0 TX_OPTIMIZED=0

RATE=600; DURATION=90s; HOT_RATIO=0.1
TARGET="http://haproxy:8000"
NEED_BULK=0            # 1 이면 200만 행 시드가 필요한 실험
RESET_SQL="db/reset.sql"

case "$EXP" in
  --list)
    cat <<'EOF'
  p5-base          기준선: 앱3대 × 풀10 = 30 커넥션
  a-exceed         (a) 앱3대 × 풀40 = 120 > max_connections(100). 연결 거부 재현
  a-exceed-soft    (a) 앱3대 × 풀32 = 96. 한계 직전
  b-starve         (b) 앱3대 × 풀1 = 3. 획득 대기가 지연의 주범
  c-pool1          (c) 곡선: 풀 1  (총 3)
  c-pool2          (c) 곡선: 풀 2  (총 6)
  c-pool4          (c) 곡선: 풀 4  (총 12)
  c-pool8          (c) 곡선: 풀 8  (총 24)
  c-pool16         (c) 곡선: 풀 16 (총 48)
  c-pool32         (c) 곡선: 풀 32 (총 96)
  e-lock           (e) 핫키 100% + 트랜잭션 200ms 유지 -> 락 경합으로 커넥션 고갈
  f-slowquery      (f) 200만 행 순차 스캔을 트랜잭션 안에서 -> 풀이 마른다
  fix-timeouts     개선: statement/lock/idle-tx 타임아웃
  fix-index        개선: (event_id,user_id) 인덱스 추가        [f 와 같은 조건]
  fix-tx           개선: 트랜잭션 왕복 5회 -> 2회               [e 와 같은 조건]
  fix-pool         개선: (c) 곡선의 최적점으로 풀 크기 조정
  fix-all          개선: 인덱스 + 트랜잭션 축소 + 타임아웃 + 풀 튜닝
EOF
    exit 0 ;;

  p5-base)        export PG_POOL_MAX=10 ;;

  # (a) 총 커넥션이 max_connections(100)를 넘긴다.
  #     Postgres 는 superuser 예약분 3 을 빼므로 실제 여유는 약 97 이다.
  a-exceed)       export PG_POOL_MAX=40 ;;   # 3 × 40 = 120
  a-exceed-soft)  export PG_POOL_MAX=32 ;;   # 3 × 32 = 96  (직전)

  # (b) 풀이 너무 작다. DB 는 놀고 앱이 풀 앞에서 줄 선다.
  b-starve)       export PG_POOL_MAX=1 ;;

  # (c) 최적점 곡선. 이 런들의 Postgres 메모리 샘플이 (d) 의 데이터가 된다.
  c-pool1)        export PG_POOL_MAX=1 ;;
  c-pool2)        export PG_POOL_MAX=2 ;;
  c-pool4)        export PG_POOL_MAX=4 ;;
  c-pool8)        export PG_POOL_MAX=8 ;;
  c-pool16)       export PG_POOL_MAX=16 ;;
  c-pool32)       export PG_POOL_MAX=32 ;;

  # (e) 락 경합. 핫키 100% 로 모든 요청이 같은 행을 노리게 하고,
  #     락을 잡은 채 200ms 머문다. 커넥션이 락 대기로 물린다.
  e-lock)         export PG_POOL_MAX=10 TX_HOLD_MS=200; HOT_RATIO=1.0; RATE=300 ;;

  # (f) 느린 쿼리 하나가 풀 전체를 마르게 한다.
  f-slowquery)    export PG_POOL_MAX=10 SLOW_QUERY=1; NEED_BULK=1; RATE=300 ;;

  # ── 개선 ────────────────────────────────────────────────────────────────
  fix-timeouts)   export PG_POOL_MAX=10 TX_HOLD_MS=200 \
                         PG_STATEMENT_TIMEOUT_MS=500 PG_LOCK_TIMEOUT_MS=200 \
                         PG_IDLE_TX_TIMEOUT_MS=1000 PG_ACQUIRE_TIMEOUT_MS=1000
                  HOT_RATIO=1.0; RATE=300 ;;

  fix-index)      export PG_POOL_MAX=10 SLOW_QUERY=1; NEED_BULK=1; RATE=300 ;;   # 인덱스는 아래에서 생성

  fix-tx)         export PG_POOL_MAX=10 TX_HOLD_MS=200 TX_OPTIMIZED=1; HOT_RATIO=1.0; RATE=300 ;;

  fix-pool)       export PG_POOL_MAX=8 ;;    # (c) 결과를 보고 조정한다

  fix-all)        export PG_POOL_MAX=8 TX_OPTIMIZED=1 SLOW_QUERY=1 \
                         PG_STATEMENT_TIMEOUT_MS=500 PG_LOCK_TIMEOUT_MS=200 \
                         PG_IDLE_TX_TIMEOUT_MS=1000 PG_ACQUIRE_TIMEOUT_MS=1000
                  NEED_BULK=1; RATE=300 ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-pool.sh --list)"; exit 1 ;;
esac

TOTAL_CONN=$(( PG_POOL_MAX * 3 ))
[ "$NEED_BULK" = "1" ] && RESET_SQL="db/reset-bulk.sql"

mkdir -p results
# iCloud dataless 파일 강제 실체화 (README 의 알려진 제약 참고)
find ./db ./k6 ./prometheus ./app ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true

PSQL=(docker compose exec -T postgres psql -q -U lts -d lts)

echo "==> 실험: ${EXP}"
echo "    풀: max=${PG_POOL_MAX}/앱  × 앱3대 = ${TOTAL_CONN} 커넥션  (max_connections=100)"
echo "    풀 타임아웃: acquire=${PG_ACQUIRE_TIMEOUT_MS}ms idle=${PG_IDLE_TIMEOUT_MS}ms lifetime=${PG_MAX_LIFETIME_SEC}s"
echo "    서버 타임아웃: stmt=${PG_STATEMENT_TIMEOUT_MS}ms lock=${PG_LOCK_TIMEOUT_MS}ms idleTx=${PG_IDLE_TX_TIMEOUT_MS}ms"
echo "    DB 주입: txHold=${TX_HOLD_MS}ms slowQuery=${SLOW_QUERY} txOptimized=${TX_OPTIMIZED}"
echo "    부하 ${RATE} RPS / ${DURATION} / hotRatio=${HOT_RATIO} -> ${TARGET}"

# ── 대용량 시드 (필요한 실험만) ───────────────────────────────────────────
if [ "$NEED_BULK" = "1" ]; then
  ROWS=$("${PSQL[@]}" -tAc "select count(*) from reservations" 2>/dev/null || echo 0)
  if [ "${ROWS:-0}" -lt 2000000 ]; then
    echo "==> 대용량 시드 (현재 ${ROWS} 행 -> 200만). 1~2분 걸린다"
    "${PSQL[@]}" < db/seed-bulk.sql | tail -12
  else
    echo "    대용량 시드 있음 (${ROWS} 행)"
  fi
fi

# ── 인덱스: fix-index / fix-all 만 만든다 ─────────────────────────────────
if [ "$EXP" = "fix-index" ] || [ "$EXP" = "fix-all" ]; then
  echo "==> (event_id, user_id) 인덱스 생성"
  "${PSQL[@]}" -c "CREATE INDEX IF NOT EXISTS reservations_event_user_idx ON reservations (event_id, user_id);"
  "${PSQL[@]}" -c "ANALYZE reservations;"
else
  "${PSQL[@]}" -c "DROP INDEX IF EXISTS reservations_event_user_idx;" >/dev/null
fi

echo "==> 앱·LB 재기동"
# --build 를 붙인다. 앱 소스는 이미지에 구워지므로 빼면 옛 코드로 측정하게 된다.
# 소스가 안 바뀌면 docker 캐시가 받아 사실상 공짜다.
docker compose up -d --build --force-recreate --no-deps app1 app2 app3 haproxy >/dev/null 2>&1

for _ in $(seq 1 45); do
  curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf --max-time 2 http://localhost:8000/healthz >/dev/null 2>&1; then
  echo "    !! 기동 실패 — 그 자체가 (a) 의 결과일 수 있으므로 계속 진행한다"
  docker logs lts-app1 --tail 15 2>&1 | sed 's/^/    /'
else
  echo "    healthz OK"
fi

echo "==> DB 초기화 (${RESET_SQL})"
"${PSQL[@]}" < "$RESET_SQL" >/dev/null
sleep 3

# ── 샘플러 ────────────────────────────────────────────────────────────────
# 1) 컨테이너 CPU/메모리
rm -f "results/${EXP}.stats.csv" "results/${EXP}.pg.csv"
( while true; do t=$(date +%s)
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
    | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"
  sleep 2; done ) & STATPID=$!

# 2) Postgres 내부 상태 — 이게 이번 Phase 의 핵심 증거다.
#    pg_stat_activity 의 state 별 개수와, 백엔드 프로세스 RSS 합계를 같이 잡는다.
#    postgres_exporter 도 state 별 카운트를 주지만 2초 해상도라 짧은 스파이크를 놓친다.
echo "ts,total,active,idle,idle_in_tx,idle_in_tx_aborted,waiting_locks,vmrss_kb,rssanon_kb" > "results/${EXP}.pg.csv"
( while true; do
  t=$(date +%s)
  row=$(docker compose exec -T postgres psql -tA -U lts -d lts -F',' -c "
    SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='active'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='idle'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='idle in transaction'),
      (SELECT count(*) FROM pg_stat_activity WHERE datname='lts' AND state='idle in transaction (aborted)'),
      (SELECT count(*) FROM pg_locks WHERE NOT granted)
  " 2>/dev/null | tr -d ' ')
  # 백엔드 메모리를 두 가지로 잰다.
  #
  #   VmRSS 합계   : 공유 메모리(shared_buffers)를 백엔드마다 중복으로 센다.
  #                  커넥션당 비용을 크게 부풀린다. 비교용으로만 남긴다.
  #   RssAnon 합계 : 프로세스 **사적** 메모리만. 커넥션 하나가 실제로 더 먹는 몫이다.
  #                  work_mem / 카탈로그 캐시가 여기 잡힌다.
  #
  # 실측(유휴, 커넥션 2개): VmRSS 92,980kB vs RssAnon 16,112kB — 6배 차이.
  # 이 구분을 안 하면 "커넥션당 30MB" 같은 틀린 결론이 나온다.
  mem=$(docker compose exec -T postgres sh -c \
    'v=$(grep -h VmRSS /proc/[0-9]*/status 2>/dev/null | awk "{s+=\$2} END {print s+0}");
     a=$(grep -h RssAnon /proc/[0-9]*/status 2>/dev/null | awk "{s+=\$2} END {print s+0}");
     echo "${v},${a}"' 2>/dev/null || echo "0,0")
  [ -n "$row" ] && echo "${t},${row},${mem:-0,0}" >> "results/${EXP}.pg.csv"
  sleep 2
done ) & PGPID=$!

trap 'kill "$STATPID" "$PGPID" 2>/dev/null || true' EXIT

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
kill "$STATPID" "$PGPID" 2>/dev/null || true
trap - EXIT

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}",
  "phase": 5,
  "rate": ${RATE},
  "hotRatio": ${HOT_RATIO},
  "apps": 3,
  "poolMax": ${PG_POOL_MAX},
  "totalPoolConnections": ${TOTAL_CONN},
  "acquireTimeoutMs": ${PG_ACQUIRE_TIMEOUT_MS},
  "idleTimeoutMs": ${PG_IDLE_TIMEOUT_MS},
  "maxLifetimeSec": ${PG_MAX_LIFETIME_SEC},
  "statementTimeoutMs": ${PG_STATEMENT_TIMEOUT_MS},
  "lockTimeoutMs": ${PG_LOCK_TIMEOUT_MS},
  "idleTxTimeoutMs": ${PG_IDLE_TX_TIMEOUT_MS},
  "txHoldMs": ${TX_HOLD_MS},
  "slowQuery": ${SLOW_QUERY},
  "txOptimized": ${TX_OPTIMIZED},
  "bulkSeed": ${NEED_BULK},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})"
