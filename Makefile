.PHONY: up down nuke logs ps reset sanity breaking closed analyze

COMPOSE = docker compose

up:
	$(COMPOSE) up -d --build
	@echo "app       http://localhost:3000/healthz"
	@echo "metrics   http://localhost:3000/metrics"
	@echo "prometheus http://localhost:9090"
	@echo "grafana   http://localhost:3001  (익명 열람 가능)"

down:
	$(COMPOSE) down

## 볼륨까지 삭제. DB 를 처음부터 다시 만든다.
nuke:
	$(COMPOSE) down -v

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100 app

## 매 측정 전 필수. 이전 런의 데이터와 워밍업된 상태를 지운다.
reset:
	$(COMPOSE) exec -T postgres psql -q -U lts -d lts < db/reset.sql
	$(COMPOSE) restart app
	@sleep 3
	@curl -sf http://localhost:3000/healthz && echo " <- app 재기동 완료"

## 1) 생성기/앱 단독 상한 확인 (DB 미사용)
sanity:
	./scripts/run-k6.sh generator-sanity

## 2) 주 시나리오: open model breaking point
breaking:
	./scripts/run-k6.sh breaking-point

## 3) 대조군: closed model
closed:
	./scripts/run-k6.sh closed-model

## 계단별 지표를 Prometheus 에서 뽑아 표로 출력
analyze:
	@node scripts/analyze.mjs $(RUN)
