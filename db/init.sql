-- Phase 01 기준선 스키마.
-- 튜닝하지 않는다. 인덱스는 정확성에 필요한 것만 만든다.
--   - reservations.idempotency_key UNIQUE : 멱등성 보장에 필요 (성능 최적화가 아님)
--   - events PK / reservations PK        : 기본
-- reservations.event_id 인덱스는 일부러 만들지 않는다. 이 라우트는 event_id 로 조회하지 않는다.

CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  total_seats INTEGER     NOT NULL,
  remaining   INTEGER     NOT NULL,
  version     INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id              BIGSERIAL   PRIMARY KEY,
  event_id        BIGINT      NOT NULL REFERENCES events(id),
  user_id         BIGINT      NOT NULL,
  quantity        INTEGER     NOT NULL,
  idempotency_key UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reservations_idempotency_key_uidx
  ON reservations (idempotency_key);

-- 이벤트 1000개. 기준선은 HOT_RATIO=0(무경합)으로 돌리므로 부하가 1000행에 흩어진다.
-- remaining 을 크게 잡아 SOLD_OUT 이 섞이지 않게 한다.
-- (재고 소진은 측정하려는 대상이 아니라 노이즈다. 경합 실험은 Phase 02 이후 별도로 한다.)
INSERT INTO events (name, total_seats, remaining)
SELECT 'event-' || i, 100000000, 100000000
FROM generate_series(1, 1000) AS i;
