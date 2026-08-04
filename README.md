# loadtest-sim

k6 → (로드밸런서) → 앱서버 → DB 구조를 로컬에 만들고, **단 하나의 라우트**를 계층별로 튜닝하며
백엔드 성능/부하를 학습하는 프로젝트. 작업 규칙은 [CLAUDE.md](CLAUDE.md), 실험 기록은 `docs/labs/`.

현재: **Phase 01 — 취약 기준선**

## 사전 준비 (macOS)

```bash
brew install colima docker docker-compose
```

`~/.docker/config.json` 에 compose 플러그인 경로를 등록해야 `docker compose` 가 동작한다:

```json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

VM 기동 (리소스는 실험 재현성을 위해 반드시 고정한다):

```bash
colima start --cpu 6 --memory 8 --disk 40 --vm-type vz --mount-type sshfs
```

## 실행

```bash
make up
```

| 주소 | 용도 |
|---|---|
| http://localhost:3000/healthz | 앱 상태 |
| http://localhost:3000/metrics | 앱 Prometheus 지표 |
| http://localhost:9090 | Prometheus |
| http://localhost:3001 | Grafana (대시보드: Phase 01 - Baseline) |

## 측정

반드시 이 순서로 한다.

```bash
make sanity
```

DB 를 타지 않는 라우트로 **k6 자신의 상한**과 앱 단독 처리량을 먼저 잰다.
여기서 목표 RPS 의 3~5배가 안 나오면 이후 모든 숫자는 서버가 아니라 k6 를 잰 것이다.

```bash
make breaking
```

주 시나리오. open model(`ramping-arrival-rate`)로 RPS 를 계단식으로 올려 breaking point 를 찾는다.

```bash
make closed
```

대조군. closed model(`ramping-vus`)로 같은 서버를 잰다. 측정 방법이 결과를 어떻게 바꾸는지 본다.

```bash
node scripts/analyze.mjs breaking-point
```

각 계단의 유지구간만 잘라서 앱/풀/DB 지표를 표로 뽑는다. k6 요약은 런 전체를 뭉갠 숫자라
"몇 RPS 에서 무엇이 먼저 터졌는지"를 알 수 없다.

## 알려진 환경 제약

- **k6 와 서버가 같은 VM 안에서 돈다.** CPU 를 나눠 쓰므로 `make sanity` 로 생성기 여유를
  매번 확인해야 한다.
- 이 저장소가 iCloud Drive 가 동기화하는 `~/Desktop` 아래에 있으면, 디스크가 부족할 때
  macOS 가 파일을 dataless 로 내보내 컨테이너 마운트 읽기가 `Resource deadlock would occur`
  로 실패한다. `scripts/run-k6.sh` 가 실행 전에 강제 실체화하지만, 근본 해결은 저장소를
  동기화 대상 밖(예: `~/loadtest-sim`)으로 옮기는 것이다.

## 구조

```
app/            Fastify + Drizzle 앱 (단일 프로세스)
db/             스키마/시드(init.sql), 실행 간 초기화(reset.sql)
k6/             부하 스크립트 3종 + 공용 헬퍼
prometheus/     스크레이프 설정 (앱은 1초 해상도)
grafana/        데이터소스/대시보드 프로비저닝
scripts/        실행 래퍼, 계단별 분석기
docs/labs/      실험 기록 (이 프로젝트의 진짜 산출물)
results/        k6 원본 출력 (git 미추적)
```
