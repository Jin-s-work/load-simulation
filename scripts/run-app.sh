#!/usr/bin/env bash
# Phase 04 실행 래퍼.
#
# 앱 1대에 직접(LB 없이) 부하를 건다. 앱 자체의 물리적 한계를 보는 것이 목적이라
# LB 를 끼면 변수가 섞인다. 수평 확장 비교에서만 3대 구조를 다시 쓴다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-app.sh <실험이름>   (목록은 --list)}"

# 기본값
export APP_CPUS=1.0 APP_MEM=512m
export CPU_BURN_MS=0 CPU_BURN_ASYNC=0
export ALLOC_KB=0 ALLOC_HOLD=200
export MAX_CONCURRENT=0 SHED_INFLIGHT=0 SHED_LOOP_LAG_MS=0 REQUEST_TIMEOUT_MS=0
export CLUSTER_WORKERS=1 UV_THREADPOOL_SIZE=4
export APP1_SLOW_MS=0 APP1_DRAIN_WAIT_MS=0
RATE=300; DURATION=90s; TARGET="http://app1:3000"; SERVICES="app1"

case "$EXP" in
  --list)
    cat <<'EOF'
  p4-base            기준선: cpus=1 mem=512m, 부하주입 없음
  a-cpu10            (a) 요청당 동기 CPU 10ms
  a-cpu30            (a) 요청당 동기 CPU 30ms   <- 루프 블로킹 심화
  a-cpu30-async      (a) 같은 30ms 를 스레드풀에서 (루프를 막지 않음)
  b-alloc256         (b) 요청당 256KB 할당
  b-alloc512         (b) 요청당 512KB 할당, 600개 유지 (약 300MB)
  b-oom              (b) 700MB 유지 시도 -> mem_limit 512m 초과로 OOM
  c-workers1         (c) 워커 1 (CPU 30ms 부하)
  c-workers2         (c) 워커 2
  c-workers4         (c) 워커 4
  c-threadpool16     (c) 비동기 CPU + 스레드풀 16
  d-queue            (d) 처리 용량을 넘는 유입 -> 큐 폭발
  fix-timeout        개선: 타임아웃 500ms
  fix-bulkhead       개선: 동시 50개 제한
  fix-shed           개선: 큐 길이 기반 load shedding
  fix-all            개선: 클러스터4 + 타임아웃 + shedding 전부
EOF
    exit 0 ;;

  p4-base) ;;

  a-cpu10)        export CPU_BURN_MS=10 ;;
  a-cpu30)        export CPU_BURN_MS=30 ;;
  a-cpu30-async)  export CPU_BURN_MS=30 CPU_BURN_ASYNC=1 ;;

  b-alloc256)     export ALLOC_KB=256 ALLOC_HOLD=600 ;;
  b-alloc512)     export ALLOC_KB=512 ALLOC_HOLD=600 ;;
  b-oom)          export ALLOC_KB=512 ALLOC_HOLD=1400 ;;   # 1400x512KB=700MB > 512m 상한

  c-workers1)     export CPU_BURN_MS=30 CLUSTER_WORKERS=1 ;;
  c-workers2)     export CPU_BURN_MS=30 CLUSTER_WORKERS=2 ;;
  c-workers4)     export CPU_BURN_MS=30 CLUSTER_WORKERS=4 ;;
  c-threadpool16) export CPU_BURN_MS=30 CPU_BURN_ASYNC=1 UV_THREADPOOL_SIZE=16 ;;

  # (d) 용량을 넘기는 유입. CPU 30ms 면 이론 용량은 1초/30ms ≈ 33 RPS 다.
  d-queue)        export CPU_BURN_MS=30; RATE=120; DURATION=90s ;;

  fix-timeout)    export CPU_BURN_MS=30 REQUEST_TIMEOUT_MS=500; RATE=120 ;;
  fix-bulkhead)   export CPU_BURN_MS=30 MAX_CONCURRENT=50; RATE=120 ;;
  fix-shed)       export CPU_BURN_MS=30 SHED_INFLIGHT=50 SHED_LOOP_LAG_MS=300; RATE=120 ;;
  fix-all)        export CPU_BURN_MS=30 CLUSTER_WORKERS=4 SHED_INFLIGHT=50 \
                         SHED_LOOP_LAG_MS=300 REQUEST_TIMEOUT_MS=1000; RATE=120 ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-app.sh --list)"; exit 1 ;;
esac

shift || true
mkdir -p results
find ./db ./k6 ./prometheus ./app -type f -exec cat {} \; > /dev/null 2>&1 || true

echo "==> 실험: ${EXP}"
echo "    cpus=${APP_CPUS} mem=${APP_MEM} workers=${CLUSTER_WORKERS} threadpool=${UV_THREADPOOL_SIZE}"
echo "    부하주입: cpuBurn=${CPU_BURN_MS}ms(async=${CPU_BURN_ASYNC}) alloc=${ALLOC_KB}KB"
echo "    보호장치: maxConc=${MAX_CONCURRENT} shedInflight=${SHED_INFLIGHT} shedLag=${SHED_LOOP_LAG_MS}ms timeout=${REQUEST_TIMEOUT_MS}ms"
echo "    부하 ${RATE} RPS / ${DURATION} -> ${TARGET}"

echo "==> 앱 재기동"
docker compose up -d --force-recreate --no-deps ${SERVICES} >/dev/null 2>&1

for _ in $(seq 1 40); do
  curl -sf --max-time 2 http://localhost:3000/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -sf --max-time 2 http://localhost:3000/healthz >/dev/null || { echo "앱 기동 실패"; docker logs lts-app1 --tail 20; exit 1; }
echo "    healthz OK"

echo "==> DB 초기화"
docker compose exec -T postgres psql -q -U lts -d lts < db/reset.sql
sleep 4

rm -f "results/${EXP}.stats.csv"
( while true; do t=$(date +%s); docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"; sleep 2; done ) &
STATPID=$!
trap 'kill "$STATPID" 2>/dev/null || true' EXIT

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" -e BASE_URL="$TARGET" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e LABEL="$EXP" \
  ${@+"$@"} \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  /scripts/lb-test.js 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)
kill "$STATPID" 2>/dev/null || true
trap - EXIT

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}",
  "rate": ${RATE},
  "cpuBurnMs": ${CPU_BURN_MS},
  "cpuBurnAsync": ${CPU_BURN_ASYNC},
  "allocKb": ${ALLOC_KB},
  "workers": ${CLUSTER_WORKERS},
  "threadpool": ${UV_THREADPOOL_SIZE},
  "maxConcurrent": ${MAX_CONCURRENT},
  "shedInflight": ${SHED_INFLIGHT},
  "shedLoopLagMs": ${SHED_LOOP_LAG_MS},
  "requestTimeoutMs": ${REQUEST_TIMEOUT_MS},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT})"
