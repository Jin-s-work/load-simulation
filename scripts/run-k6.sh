#!/usr/bin/env bash
# k6 실행 래퍼.
#
# 하는 일:
#   1) DB 초기화 + 앱 재기동 (재현성)
#   2) 실행 시작/종료 epoch 기록  <- 이게 있어야 나중에 Prometheus 에서 계단별 구간을 잘라낼 수 있다
#   3) k6 실행 결과를 results/ 에 남김
set -euo pipefail

cd "$(dirname "$0")/.."

SCRIPT_NAME="${1:?사용법: run-k6.sh <breaking-point|generator-sanity|closed-model>}"
shift || true

mkdir -p results

# 이 프로젝트는 iCloud Drive 가 동기화하는 ~/Desktop 아래에 있다.
# 디스크가 꽉 차면 macOS 가 파일을 dataless(클라우드 전용) 상태로 내보내는데,
# 그 상태의 파일을 Lima VM 이 읽으면 EDEADLK("Resource deadlock would occur")로 실패한다.
# 컨테이너가 설정/스크립트를 읽는 건 기동 시점이므로, 기동 전에 강제로 실체화해 둔다.
echo "==> 마운트 대상 파일 실체화 (iCloud dataless 방지)"
find ./db ./k6 ./prometheus ./grafana -type f -exec cat {} \; > /dev/null 2>&1 || true

echo "==> DB 초기화 + 앱 재기동"
docker compose exec -T postgres psql -q -U lts -d lts < db/reset.sql
docker compose restart app >/dev/null
for _ in $(seq 1 30); do
  if curl -sf http://localhost:3000/healthz >/dev/null; then break; fi
  sleep 1
done
curl -sf http://localhost:3000/healthz >/dev/null || { echo "app 기동 실패"; exit 1; }

# Prometheus 가 재기동된 앱을 다시 잡을 시간을 준다.
sleep 3

START_EPOCH=$(date +%s)
echo "==> k6 시작: ${SCRIPT_NAME} (start=${START_EPOCH})"

set +e
docker compose run --rm \
  -e RUN_ID="$(date +%s)" \
  ${@+"$@"} \
  k6 run \
  --out experimental-prometheus-rw \
  --tag testid="${SCRIPT_NAME}" \
  "/scripts/${SCRIPT_NAME}.js" 2>&1 | tee "results/${SCRIPT_NAME}.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

END_EPOCH=$(date +%s)

# k6 는 임계값(threshold) 실패 시 exit 99 를 낸다.
# breaking point 테스트에서는 뒤쪽 계단이 SLO 를 깨는 게 정상이므로 실패가 아니다.
echo "==> k6 종료 (exit=${K6_EXIT}, end=${END_EPOCH})"

cat > "results/${SCRIPT_NAME}.meta.json" <<EOF
{
  "script": "${SCRIPT_NAME}",
  "startEpoch": ${START_EPOCH},
  "endEpoch": ${END_EPOCH},
  "k6Exit": ${K6_EXIT}
}
EOF

echo "==> 결과: results/${SCRIPT_NAME}.log, results/${SCRIPT_NAME}.json, results/${SCRIPT_NAME}.meta.json"
echo "==> 계단별 분석: node scripts/analyze.mjs ${SCRIPT_NAME}"
