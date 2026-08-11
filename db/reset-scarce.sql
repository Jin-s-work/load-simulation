-- Phase 07 전용 초기화 — 재고를 희소하게 만든다.
--
-- 왜 필요한가:
--   기본 시드는 total_seats 가 1억이라 절대 매진되지 않는다.
--   Phase 06 마지막 런에서 28,196건이 **전부 created** 였고 sold_out 은 0건이었다.
--   즉 이 라우트는 지금 100% 쓰기이고, **캐시가 걸릴 읽기 경로가 없다.**
--
--   캐시가 실제로 값을 하는 지점은 **매진 이후의 거절**이다.
--   10만 명이 1만 석을 두고 싸우면 대부분의 요청은 "이미 매진"이라는 거절이고,
--   그 거절은 DB 를 안 거치고 캐시에서 끝낼 수 있다. 티켓팅의 실제 모습이다.
--
-- 재고 배분:
--   부하 600 RPS × 90초 ≈ 54,000 요청.
--   총 재고를 그보다 훨씬 적게 잡아야 유지구간 대부분이 "매진 상태"가 된다.
--   1~10번 이벤트(핫키 대상)는 특히 적게 줘서 초반에 매진시킨다.
UPDATE events
SET remaining = CASE
      WHEN id <= 10  THEN 200      -- 핫키. Zipf 상위. 몇 초 안에 매진된다
      WHEN id <= 100 THEN 100
      ELSE 20                      -- 나머지 900개
    END,
    version = 0;

-- total_seats 도 맞춰 둔다. reset.sql(remaining = total_seats)을 잘못 돌려도
-- 재고가 1억으로 되돌아가지 않게 하기 위해서다.
UPDATE events SET total_seats = remaining;

TRUNCATE reservations RESTART IDENTITY;
VACUUM ANALYZE reservations;
VACUUM ANALYZE events;

SELECT sum(remaining) AS 총재고, count(*) AS 이벤트수 FROM events;
