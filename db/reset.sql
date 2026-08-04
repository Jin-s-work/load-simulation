-- 실행 간 재현성을 위한 초기화.
-- 이전 런이 남긴 수십만 행과 늘어난 인덱스는 다음 런의 조건을 바꾼다.
-- 매 측정 전에 반드시 돌린다. (make reset)
TRUNCATE reservations RESTART IDENTITY;
UPDATE events SET remaining = total_seats, version = 0;
VACUUM ANALYZE reservations;
VACUUM ANALYZE events;
