#!/usr/bin/env bash
# Phase 03 실행 래퍼.
#
# 실험마다 (1) LB/앱을 그 조건으로 재기동하고 (2) 네트워크 상태 캡처를 켜고
# (3) k6 를 돌린다. 조건은 전부 환경변수로 주입한다.
#
# 사용: run-lb.sh <실험이름> [k6 추가옵션...]
set -euo pipefail
cd "$(dirname "$0")/.."

EXP="${1:?사용법: run-lb.sh <실험이름>   (목록은 --list)}"

# 기본값 — 각 case 에서 필요한 것만 덮어쓴다
export LB_ALGO=roundrobin
export LB_MAXCONN=20000 LB_FE_MAXCONN=20000 LB_SRV_MAXCONN=2000
export LB_BACKLOG=4096 LB_SOMAXCONN=4096
export LB_HTTP_REUSE=safe LB_POOL_MAX_CONN=100
export LB_PORT_RANGE="32768 60999" LB_NOFILE=65535
export LB_CHECK_INTER=2s LB_CHECK_FALL=3 LB_CHECK_RISE=2
export APP1_SLOW_MS=0 APP2_SLOW_MS=0 APP3_SLOW_MS=0
export APP1_DRAIN_WAIT_MS=0 APP2_DRAIN_WAIT_MS=0 APP3_DRAIN_WAIT_MS=0
export APP_SOMAXCONN=4096 APP_BACKLOG=511
RATE=900; DURATION=90s; NO_REUSE=0; KILL_APP=""; KILL_AT=40

case "$EXP" in
  --list)
    cat <<'EOF'
  base-rr              기준선: round-robin, 정상 상태
  a-maxconn            (a) LB maxconn 을 낮춰 커넥션 슬롯 고갈
  a-nofile             (a) ulimit nofile 을 낮춰 fd 고갈
  b-noreuse            (b) 업스트림 keepalive 끔 + ephemeral 포트 범위 축소
  c-backlog            (c) accept 큐(backlog/somaxconn) 축소로 SYN 드롭
  d-slow-rr            (d) app3 만 300ms 느림 + round-robin
  d-slow-leastconn     (d) 같은 조건 + least-connections
  d-slow-source        (d) 같은 조건 + source(ip-hash)
  e-kill-nodrain       (e) 실행 중 app3 kill, graceful 없음  -> 죽은 구간 노출
  e-kill-drain         (e) 같은 kill 이지만 drain 8초  -> 죽은 구간 제거 확인
EOF
    exit 0 ;;

  base-rr) ;;

  a-maxconn)   export LB_MAXCONN=60 LB_FE_MAXCONN=50 LB_SRV_MAXCONN=20 ;;
  a-nofile)    export LB_NOFILE=256 ;;
  b-noreuse)   export LB_HTTP_REUSE=never LB_POOL_MAX_CONN=0 LB_PORT_RANGE="56000 60999"; NO_REUSE=1 ;;
  c-backlog)   export LB_BACKLOG=8 LB_SOMAXCONN=8; NO_REUSE=1; RATE=1500 ;;
  # (c) 재설계: 큐가 넘치는 현실적인 지점은 LB 가 아니라 "스레드 하나로 accept 하는 앱"이다.
  c-app-backlog) export APP_SOMAXCONN=4 APP_BACKLOG=4 LB_HTTP_REUSE=never LB_POOL_MAX_CONN=0; NO_REUSE=1; RATE=1800; DURATION=60s ;;
  # (b) 재설계: HAProxy 가 백엔드 커넥션을 먼저 닫게 만들어 임시 포트에 TIME_WAIT 을 쌓는다
  b-portexhaust) export LB_HTTP_REUSE=never LB_POOL_MAX_CONN=0 LB_PORT_RANGE="60000 60299"; RATE=600; DURATION=60s ;;

  d-slow-rr)         export APP3_SLOW_MS=300 LB_ALGO=roundrobin ;;
  d-slow-leastconn)  export APP3_SLOW_MS=300 LB_ALGO=leastconn ;;
  d-slow-source)     export APP3_SLOW_MS=300 LB_ALGO=source ;;

  e-kill-nodrain) KILL_APP=lts-app3; KILL_AT=40 ;;
  e-kill-drain)   KILL_APP=lts-app3; KILL_AT=40; export APP3_DRAIN_WAIT_MS=8000 ;;

  *) echo "알 수 없는 실험: $EXP (목록: run-lb.sh --list)"; exit 1 ;;
esac

shift || true
mkdir -p results
find ./db ./k6 ./prometheus ./grafana ./haproxy -type f -exec cat {} \; > /dev/null 2>&1 || true

echo "==> 실험: ${EXP}"
echo "    algo=${LB_ALGO} maxconn=${LB_MAXCONN} nofile=${LB_NOFILE} reuse=${LB_HTTP_REUSE}"
echo "    backlog=${LB_BACKLOG} somaxconn=${LB_SOMAXCONN} ports='${LB_PORT_RANGE}'"
echo "    slow=(${APP1_SLOW_MS},${APP2_SLOW_MS},${APP3_SLOW_MS})ms drain=(${APP1_DRAIN_WAIT_MS},${APP2_DRAIN_WAIT_MS},${APP3_DRAIN_WAIT_MS})ms"
echo "    부하 ${RATE} RPS / ${DURATION}"

echo "==> 앱 3대 + LB 재기동"
docker compose up -d --force-recreate app1 app2 app3 haproxy >/dev/null 2>&1

up=0
for _ in $(seq 1 40); do
  # 반드시 server_status 만 센다. 예전엔 'state="UP"} 1' 로 세다가 frontend/backend 까지
  # 포함되어 서버가 하나도 안 떴는데 6 이 나왔고, 그대로 부하를 걸어 503 을 대량 생성했다.
  up=$(curl -s http://localhost:8404/metrics 2>/dev/null | grep -c '^haproxy_server_status{proxy="be_app",server="app[123]",state="UP"} 1' || true)
  [ "${up:-0}" -ge 3 ] && break
  sleep 1
done
echo "    백엔드 UP: ${up}/3"

echo "==> DB 초기화"
docker compose exec -T postgres psql -q -U lts -d lts < db/reset.sql
sleep 3

rm -f "results/${EXP}.stats.csv" "results/${EXP}.events.log"

./scripts/net-snapshot.sh "results/${EXP}.net.csv" lts-haproxy 1 >/dev/null 2>&1 &
NETPID=$!
# 앱 쪽도 같이 본다. accept 큐 넘침과 TIME_WAIT 은 앱 쪽에서 일어나는 경우가 더 흔하다.
./scripts/net-snapshot.sh "results/${EXP}.app.net.csv" lts-app1 1 >/dev/null 2>&1 &
APPNETPID=$!
( while true; do t=$(date +%s); docker stats --no-stream --format '{{.Name}},{{.CPUPerc}}' 2>/dev/null | sed "s/^/${t},/; s/%//" >> "results/${EXP}.stats.csv"; sleep 2; done ) &
STATPID=$!
trap 'kill "$NETPID" "$APPNETPID" "$STATPID" 2>/dev/null || true' EXIT

if [ -n "$KILL_APP" ]; then
  : > "results/${EXP}.events.log"
  ( sleep "$KILL_AT"
    echo "$(date +%s) SIGTERM_SENT ${KILL_APP}" >> "results/${EXP}.events.log"
    docker stop -t 30 "$KILL_APP" >/dev/null 2>&1
    echo "$(date +%s) STOPPED ${KILL_APP}" >> "results/${EXP}.events.log"
  ) &
  echo "==> ${KILL_AT}초 후 ${KILL_APP} 종료 예정"
fi

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" \
  -e BASE_URL="http://haproxy:8000" \
  -e RATE="$RATE" -e DURATION="$DURATION" -e NO_REUSE="$NO_REUSE" -e LABEL="$EXP" \
  ${@+"$@"} \
  k6 run --out experimental-prometheus-rw --tag testid="$EXP" \
  /scripts/lb-test.js 2>&1 | tee "results/${EXP}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)
kill "$NETPID" "$APPNETPID" "$STATPID" 2>/dev/null || true
trap - EXIT

cat > "results/${EXP}.meta.json" <<EOF
{
  "experiment": "${EXP}",
  "algo": "${LB_ALGO}",
  "rate": ${RATE},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "killApp": "${KILL_APP}",
  "killAt": ${KILL_AT},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 종료 (exit=${K6_EXIT}). 결과: results/${EXP}.{log,json,net.csv,stats.csv}"

if [ -n "$KILL_APP" ]; then
  docker compose up -d "${KILL_APP#lts-}" >/dev/null 2>&1 || true
fi
