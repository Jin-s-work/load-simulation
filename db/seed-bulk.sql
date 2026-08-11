-- Phase 05 (f): reservations 를 대용량으로 채운다.
--
-- 왜 필요한가:
--   기본 시드는 reservations 가 5천 행 남짓이라 어떤 쿼리도 자연스럽게 느려지지 않는다.
--   pg_sleep() 으로 가짜 지연을 만들 수도 있지만, 그러면 "인덱스 추가로 개선" 을
--   증명할 수 없다. 가짜 지연은 인덱스로 사라지지 않기 때문이다.
--
--   그래서 진짜로 느린 쿼리를 만든다:
--     - 200만 행을 채우고
--     - event_id / user_id 에는 인덱스를 만들지 않는다
--       (외래키 제약이 있어도 Postgres 는 인덱스를 자동 생성하지 않는다)
--     - 그 두 컬럼으로 조회하면 순차 스캔이 된다
--
--   이게 실무에서 가장 흔한 사고 패턴이다. 개발 DB 에선 데이터가 적어 멀쩡하다가
--   운영에서 행이 쌓이면 터진다. 그리고 인덱스 하나로 고쳐진다.
--
-- ★ id 를 1..2000000 으로 결정적으로 만든다.
--   그래야 db/reset-bulk.sql 이 "id > 2000000 인 것만 지운다" 로 런 사이를 초기화할 수 있다.
--   (기본 reset.sql 은 TRUNCATE 라 이 200만 행을 통째로 날려버린다.)

\timing on

TRUNCATE reservations RESTART IDENTITY;

INSERT INTO reservations (event_id, user_id, quantity, idempotency_key, created_at)
SELECT
  -- 이벤트 1000개에 고르게 뿌린다. 특정 이벤트로 필터하면 2000행이 맞는데
  -- 인덱스가 없어 200만 행을 전부 훑는다 = "결과는 적은데 스캔은 전부".
  (i % 1000) + 1,
  (i % 50000) + 1,
  1,
  gen_random_uuid(),
  now() - (i % 86400) * interval '1 second'
FROM generate_series(1, 2000000) AS i;

-- 통계를 갱신해야 플래너가 현실적인 계획을 세운다.
-- 빼먹으면 "행이 5천 개인 줄 알고" 엉뚱한 계획을 고른다.
ANALYZE reservations;

SELECT
  (SELECT count(*) FROM reservations) AS 행수,
  pg_size_pretty(pg_total_relation_size('reservations')) AS 크기;

-- event_id/user_id 에 인덱스가 없어야 (f) 가 성립한다.
SELECT indexname FROM pg_indexes WHERE tablename = 'reservations' ORDER BY indexname;

-- 실제로 순차 스캔이 되는지 계획으로 확인한다. 추측하지 않는다.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM reservations WHERE event_id = 1 AND user_id = 1 LIMIT 1;
