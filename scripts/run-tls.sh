#!/usr/bin/env bash
# Phase 02 실행 래퍼.
#
# 구성 하나를 받아서 (1) 앱을 그 모드로 재기동하고 (2) DB 를 초기화하고 (3) k6 를 돌린다.
# 앱을 매번 재기동하는 이유: TLS 모드를 바꾸려면 프로세스를 새로 띄워야 하고,
# 동시에 V8/커넥션풀 상태도 초기화되어 구성 간 조건이 같아진다.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${1:?사용법: run-tls.sh <구성이름>   (목록은 --list)}"

case "$CONFIG" in
  --list)
    cat <<'EOF'
  a-http               평문 HTTP, 앱 직결                 (Phase 01 기준선 재확인)
  b-ecdsa-reuse        HTTPS(ECDSA), 앱 직결, keep-alive  (TLS 평상시 비용)
  c-ecdsa-noreuse      HTTPS(ECDSA), 앱 직결, 재사용 끔   (핸드쉐이크 진짜 비용)
  d-rsa-reuse          HTTPS(RSA),   앱 직결, keep-alive
  e-rsa-noreuse        HTTPS(RSA),   앱 직결, 재사용 끔   (RSA vs ECDSA 비교)
  f-nginx-http         평문, nginx 경유                   (프록시 홉만의 비용)
  g-nginx-tls-reuse    HTTPS, nginx 종료, keep-alive
  h-nginx-tls-noreuse  HTTPS, nginx 종료, 재사용 끔       (오프로딩 효과)
EOF
    exit 0 ;;
  a-http)              TLS_MODE=off;   URL="http://app:3000";    REUSE=0 ;;
  b-ecdsa-reuse)       TLS_MODE=ecdsa; URL="https://app:3000";   REUSE=0 ;;
  c-ecdsa-noreuse)     TLS_MODE=ecdsa; URL="https://app:3000";   REUSE=1 ;;
  d-rsa-reuse)         TLS_MODE=rsa;   URL="https://app:3000";   REUSE=0 ;;
  e-rsa-noreuse)       TLS_MODE=rsa;   URL="https://app:3000";   REUSE=1 ;;
  f-nginx-http)        TLS_MODE=off;   URL="http://nginx:8080";  REUSE=0 ;;
  g-nginx-tls-reuse)   TLS_MODE=off;   URL="https://nginx:8443"; REUSE=0 ;;
  h-nginx-tls-noreuse) TLS_MODE=off;   URL="https://nginx:8443"; REUSE=1 ;;
  *) echo "알 수 없는 구성: $CONFIG (목록: run-tls.sh --list)"; exit 1 ;;
esac

shift || true
mkdir -p results

# iCloud dataless 방지 (README 참고)
find ./db ./k6 ./prometheus ./grafana ./certs ./nginx -type f -exec cat {} \; > /dev/null 2>&1 || true

echo "==> 구성: ${CONFIG}"
echo "    TLS_MODE=${TLS_MODE}  대상=${URL}  커넥션재사용=$([ "$REUSE" = 1 ] && echo 끔 || echo 켬)"

echo "==> 앱을 TLS_MODE=${TLS_MODE} 로 재기동"
TLS_MODE="$TLS_MODE" docker compose up -d --force-recreate --no-deps app >/dev/null 2>&1

# 앱이 뜰 때까지 대기. TLS 모드면 https 로, 자체서명이라 -k.
SCHEME=$([ "$TLS_MODE" = off ] && echo http || echo https)
for _ in $(seq 1 40); do
  if curl -sfk "${SCHEME}://localhost:3000/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
HEALTH=$(curl -sfk "${SCHEME}://localhost:3000/healthz" || true)
[ -n "$HEALTH" ] || { echo "앱 기동 실패"; docker compose logs --tail=20 app; exit 1; }
echo "    healthz: ${HEALTH}"

echo "==> DB 초기화"
docker compose exec -T postgres psql -q -U lts -d lts < db/reset.sql

# Prometheus 가 재기동된 앱을 다시 잡을 시간
sleep 4

START_EPOCH=$(date +%s)
echo "==> k6 시작 (start=${START_EPOCH})"

# 컨테이너별 CPU 샘플러.
# cAdvisor 가 colima 환경에서 컨테이너 이름을 못 붙여서(name 라벨 없음) 쓸 수 없었다.
# docker stats 를 2초마다 찍는 쪽이 단순하고 확실하다.
# 형식: epoch,컨테이너명,CPU퍼센트
STATS_FILE="results/${CONFIG}.stats.csv"
echo "epoch,name,cpu_percent" > "$STATS_FILE"
(
  while true; do
    ts=$(date +%s)
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}}' 2>/dev/null \
      | sed "s/^/${ts},/; s/%//" >> "$STATS_FILE" || true
    sleep 2
  done
) &
STATS_PID=$!
trap 'kill "$STATS_PID" 2>/dev/null || true' EXIT

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" \
  -e BASE_URL="$URL" \
  -e NO_REUSE="$REUSE" \
  -e LABEL="$CONFIG" \
  ${@+"$@"} \
  k6 run \
  --out experimental-prometheus-rw \
  --tag testid="$CONFIG" \
  /scripts/tls-fixed.js 2>&1 | tee "results/${CONFIG}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)
kill "$STATS_PID" 2>/dev/null || true
trap - EXIT
echo "==> k6 종료 (exit=${K6_EXIT}, end=${END_EPOCH})"

cat > "results/${CONFIG}.meta.json" <<EOF
{
  "config": "${CONFIG}",
  "tlsMode": "${TLS_MODE}",
  "baseUrl": "${URL}",
  "noReuse": ${REUSE},
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF
