#!/usr/bin/env bash
# HAProxy 컨테이너의 네트워크 상태를 주기적으로 CSV 로 남긴다.
#
# ss / netstat 를 설치하지 않는다. 그 도구들이 읽는 원본이 /proc/net/* 이고,
# 컨테이너는 자기 네트워크 네임스페이스의 값을 보므로 cat 만으로 충분하다.
#
#   /proc/net/sockstat  TCP inuse / orphan / tw(TIME_WAIT) / alloc / mem
#   /proc/net/snmp      Tcp: CurrEstab, ActiveOpens, PassiveOpens, AttemptFails
#   /proc/net/netstat   TcpExt: ListenOverflows, ListenDrops  <- accept 큐 넘침
#
# 사용: net-snapshot.sh <출력파일> [컨테이너] [간격초]
set -uo pipefail

OUT="${1:?사용법: net-snapshot.sh <출력파일> [컨테이너] [간격초]}"
CONTAINER="${2:-lts-haproxy}"
INTERVAL="${3:-1}"

# tw_listen  = 리슨 포트(8000/8404/3000)에 쌓인 TIME_WAIT -> ephemeral 포트를 안 먹는다
# tw_ephem   = 임시 포트에 쌓인 TIME_WAIT -> ★ 이것이 포트 고갈을 일으킨다
echo "epoch,tcp_inuse,tcp_orphan,tcp_tw,tcp_alloc,curr_estab,active_opens,passive_opens,attempt_fails,listen_overflows,listen_drops,tw_listen,tw_ephem" > "$OUT"

while true; do
  ts=$(date +%s)
  raw=$(docker exec "$CONTAINER" sh -c 'cat /proc/net/sockstat; echo "---"; cat /proc/net/snmp; echo "---"; cat /proc/net/netstat' 2>/dev/null) || { sleep "$INTERVAL"; continue; }

  # TIME_WAIT(state 06)을 로컬 포트로 나눈다.
  # /proc/net/tcp 의 local_address 는 "IP:PORT" 16진수다. 1F40=8000, 20D4=8404, 0BB8=3000
  tw_split=$(docker exec "$CONTAINER" sh -c 'cat /proc/net/tcp' 2>/dev/null | awk '
    function hex2dec(h,   i, c, v, d) {
      v = 0; h = toupper(h)
      for (i = 1; i <= length(h); i++) {
        c = substr(h, i, 1); d = index("0123456789ABCDEF", c) - 1
        if (d < 0) return 0
        v = v * 16 + d
      }
      return v
    }
    NR>1 && $4=="06" {
      split($2, a, ":"); port = hex2dec(a[2])
      if (port==8000 || port==8404 || port==3000) l++; else e++
    }
    END { printf "%d %d", l+0, e+0 }') || tw_split="0 0"

  echo "$raw" | awk -v ts="$ts" -v twsplit="$(echo $tw_split | tr ' ' ',')" '
    /^TCP: inuse/ { inuse=$3; orphan=$5; twc=$7; alloc=$9 }
    /^Tcp:/ {
      if ($2 == "RtoAlgorithm") { for (i=1;i<=NF;i++) tcphdr[i]=$i; next }
      for (i=1;i<=NF;i++) tcpval[tcphdr[i]]=$i
    }
    /^TcpExt:/ {
      if ($2 ~ /[A-Za-z]/ && $2 !~ /^[0-9]+$/) {
        if (!have_ext_hdr) { for (i=1;i<=NF;i++) exthdr[i]=$i; have_ext_hdr=1; next }
        for (i=1;i<=NF;i++) extval[exthdr[i]]=$i
      }
    }
    END {
      printf "%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n", ts,
        inuse+0, orphan+0, twc+0, alloc+0,
        tcpval["CurrEstab"]+0, tcpval["ActiveOpens"]+0, tcpval["PassiveOpens"]+0, tcpval["AttemptFails"]+0,
        extval["ListenOverflows"]+0, extval["ListenDrops"]+0, twsplit
    }' >> "$OUT"

  sleep "$INTERVAL"
done
