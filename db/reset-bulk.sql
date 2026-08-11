-- Phase 05 전용 런 사이 초기화.
--
-- 기본 db/reset.sql 은 TRUNCATE 라 seed-bulk.sql 이 넣은 200만 행까지 날린다.
-- (f) 실험은 그 200만 행이 있어야 성립하므로, 여기서는 **런 중에 생긴 행만** 지운다.
--
-- seed-bulk.sql 이 id 를 1..2000000 으로 결정적으로 만들어 두므로
-- 그보다 큰 id 가 이번 런에서 생긴 것이다.
DELETE FROM reservations WHERE id > 2000000;
SELECT setval('reservations_id_seq', 2000000, true);

UPDATE events SET remaining = total_seats, version = 0;

-- VACUUM FULL 은 쓰지 않는다. 테이블 전체를 다시 쓰느라 수십 초가 걸리고,
-- 매 런마다 하면 실험 시간이 배로 든다. 지운 행이 런당 수천 개 수준이라
-- 일반 VACUUM 으로 충분하다.
VACUUM ANALYZE reservations;
VACUUM ANALYZE events;
