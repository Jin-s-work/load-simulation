#!/usr/bin/env bash
# 자체서명 인증서 2종을 만든다. 실험의 핵심 변수는 "키 종류"다.
#
#   ecdsa : ECDSA P-256  — 서버 서명이 싸다
#   rsa   : RSA 2048     — 서버 서명이 비싸다
#
# 나머지 조건(유효기간, SAN, 서명 해시)은 똑같이 맞춘다.
# 변수를 하나만 남겨야 차이의 원인을 키 종류로 귀속시킬 수 있다.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p certs
cd certs

SUBJ="/C=KR/O=loadtest-sim/CN=localhost"
SAN="subjectAltName=DNS:localhost,DNS:app,DNS:nginx,IP:127.0.0.1"
DAYS=365

echo "==> ECDSA P-256 인증서 생성"
openssl req -x509 -nodes -days "$DAYS" \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout ecdsa-key.pem -out ecdsa-cert.pem \
  -subj "$SUBJ" -addext "$SAN" -sha256 2>/dev/null

echo "==> RSA 2048 인증서 생성"
openssl req -x509 -nodes -days "$DAYS" \
  -newkey rsa:2048 \
  -keyout rsa-key.pem -out rsa-cert.pem \
  -subj "$SUBJ" -addext "$SAN" -sha256 2>/dev/null

chmod 644 ./*.pem

echo
echo "==> 생성 결과"
for n in ecdsa rsa; do
  algo=$(openssl x509 -in "$n-cert.pem" -noout -text | grep "Public Key Algorithm" | head -1 | sed 's/.*: //')
  bits=$(openssl x509 -in "$n-cert.pem" -noout -text | grep -E "Public-Key:" | head -1 | tr -d ' ')
  printf "  %-6s %-24s %s\n" "$n" "$algo" "$bits"
done
