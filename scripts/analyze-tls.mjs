#!/usr/bin/env node
// Phase 02 비교표 생성기.
//
// 각 구성의 "유지구간"만 잘라서 처리량/지연/CPU 를 나란히 놓는다.
// 마지막 두 열이 이번 Phase 의 핵심이다:
//   요청당 앱 CPU  = 요청 하나를 처리하는 데 앱 스레드가 실제로 쓴 시간
//   환산 천장      = 1.15 코어(Phase 01 에서 관측한 단일 스레드 상한) ÷ 요청당 CPU
//
// 사용: node scripts/analyze-tls.mjs [구성이름 ...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/api/v1/events/:eventId/reservations';

// Phase 01 에서 실측한 앱 프로세스 CPU 천장(코어). 환산에만 쓴다.
const CPU_CEILING = Number(process.env.CPU_CEILING || 1.15);
const SKIP_HEAD = Number(process.env.SKIP_HEAD || 20);
const SKIP_TAIL = Number(process.env.SKIP_TAIL || 3);

const ORDER = [
  'a-http', 'b-ecdsa-reuse', 'c-ecdsa-noreuse',
  'd-rsa-reuse', 'e-rsa-noreuse',
  'f-nginx-http', 'g-nginx-tls-reuse', 'h-nginx-tls-noreuse',
];

const LABELS = {
  'a-http': 'HTTP 직결',
  'b-ecdsa-reuse': 'HTTPS ECDSA · 재사용',
  'c-ecdsa-noreuse': 'HTTPS ECDSA · 핸드쉐이크',
  'd-rsa-reuse': 'HTTPS RSA · 재사용',
  'e-rsa-noreuse': 'HTTPS RSA · 핸드쉐이크',
  'f-nginx-http': 'nginx HTTP 경유',
  'g-nginx-tls-reuse': 'nginx TLS · 재사용',
  'h-nginx-tls-noreuse': 'nginx TLS · 핸드쉐이크',
};

async function q(expr, at) {
  const url = `${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    if (body.status !== 'success' || !body.data.result.length) return null;
    const v = Number(body.data.result[0].value[1]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

const f = (v, d = 1, s = 1) => (v === null || v === undefined ? '—' : (v * s).toFixed(d));

// 앱이 부하 없이 떠 있을 때 쓰는 CPU(코어). 실측값.
const IDLE_CPU = Number(process.env.IDLE_CPU || 0.0079);
// Phase 01 회귀에서 나온 고부하 요청당 한계 CPU(µs)와 절편(코어).
// docs/labs/01-baseline.md 의 100~1200 RPS 측정으로 얻었고, 실측 천장 2000 RPS 와 맞았다.
const P1_MARGINAL = Number(process.env.P1_MARGINAL || 515);
const P1_INTERCEPT = Number(process.env.P1_INTERCEPT || 0.085);

/** run-tls.sh 가 남긴 docker stats 샘플에서 구간 평균 CPU(코어 단위)를 뽑는다. */
function readStats(cfg, from, to) {
  const p = path.join(ROOT, 'results', `${cfg}.stats.csv`);
  const out = { nginx: null, k6: null, app: null };
  if (!fs.existsSync(p)) return out;

  const acc = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n').slice(1)) {
    const [ts, name, pct] = line.split(',');
    const t = Number(ts);
    if (!name || !Number.isFinite(t) || t < from || t > to) continue;
    const v = Number(pct);
    if (!Number.isFinite(v)) continue;
    let key = null;
    if (name === 'lts-nginx') key = 'nginx';
    else if (name.includes('k6-run')) key = 'k6';
    else if (name === 'lts-app') key = 'app';
    if (!key) continue;
    acc[key] ??= { sum: 0, n: 0 };
    acc[key].sum += v;
    acc[key].n += 1;
  }
  // docker stats 는 퍼센트로 준다. 100% = 코어 1개.
  for (const k of Object.keys(acc)) out[k] = acc[k].sum / acc[k].n / 100;
  return out;
}

async function measure(cfg) {
  const metaPath = path.join(ROOT, 'results', `${cfg}.meta.json`);
  const sumPath = path.join(ROOT, 'results', `${cfg}.json`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(sumPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const summary = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
  const s = summary.schedule[0];

  const from = meta.startEpoch + s.holdStart + SKIP_HEAD;
  const to = meta.startEpoch + s.holdEnd - SKIP_TAIL;
  const w = Math.max(1, to - from);
  const at = to;
  const r = `route="${ROUTE}"`;

  // 앱은 TLS 모드에 따라 job=app(평문) 또는 job=app_tls(HTTPS) 로 잡힌다. 둘 다 본다.
  const APP = 'job=~"app|app_tls"';

  const [total, p50, p99, appCpu, dropped] = await Promise.all([
    q(`sum(increase(http_request_duration_seconds_count{${r}}[${w}s]))`, at),
    q(`histogram_quantile(0.50, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`histogram_quantile(0.99, sum by (le) (increase(http_request_duration_seconds_bucket{${r}}[${w}s])))`, at),
    q(`avg_over_time(rate(process_cpu_seconds_total{${APP}}[15s])[${w}s:5s])`, at),
    q(`sum(increase(k6_dropped_iterations_total[${w}s]))`, at),
  ]);

  // 컨테이너별 CPU 는 docker stats 샘플에서 읽는다 (cAdvisor 가 colima 에서 이름을 못 붙임).
  const stats = readStats(cfg, from, to);

  // k6 요약에서 TLS 핸드쉐이크 시간(클라이언트가 기다린 시간)
  const hs = summary.metrics?.http_req_tls_handshaking?.values?.avg ?? null;

  const rps = total === null ? null : total / w;
  const cpuPerReqAvg = appCpu !== null && rps ? (appCpu / rps) * 1e6 : null;

  return {
    cfg, meta, rps, p50, p99, appCpu, hs, dropped,
    nginxCpu: stats.nginx, k6Cpu: stats.k6, appCpuStats: stats.app,
    cpuPerReqAvg,
  };
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ORDER;
  const rows = [];
  for (const cfg of wanted) {
    const m = await measure(cfg);
    if (m) rows.push(m);
  }

  if (!rows.length) {
    console.log('측정 결과가 없다. 먼저 ./scripts/run-tls.sh <구성> 을 돌려야 한다.');
    return;
  }

  const base = rows.find((x) => x.cfg === 'a-http');

  // ---------------------------------------------------------------------------
  // 절대 천장을 어떻게 환산하는가 (여기가 중요하다)
  //
  // 순진하게 (총 CPU - 유휴) / RPS 로 계산하면 안 된다.
  // 300 RPS 에서 잰 "요청당 CPU"는 1000+ RPS 에서의 값보다 크다. 부하가 낮을수록
  // 배칭이 덜 되어 요청 하나가 비싸지기 때문이다(곡선이 아래로 볼록).
  // 실제로 유휴는 0.008 코어인데 Phase 01 회귀 절편은 0.085 였다. 이 차이가 그 증거다.
  //
  // 그래서 절대값은 이렇게 만든다:
  //   1) 이번 실험에서는 HTTP 대비 "TLS 가 추가로 먹는 CPU"(증분)만 뽑는다.
  //      증분은 핸드쉐이크/암호화라는 실제 작업량이라 부하 수준에 덜 의존한다.
  //   2) 그 증분을 Phase 01 에서 검증된 고부하 요청당 비용(515µs)에 더한다.
  //   3) 그 합으로 천장을 환산한다.
  // 즉 비교는 이번 측정으로, 절대값은 검증된 모델로 한다.
  // ---------------------------------------------------------------------------
  for (const x of rows) {
    x.deltaPerReq = base && base.cpuPerReqAvg && x.cpuPerReqAvg
      ? x.cpuPerReqAvg - base.cpuPerReqAvg
      : null;
    x.scaledPerReq = x.deltaPerReq === null ? null : P1_MARGINAL + x.deltaPerReq;
    x.derivedCeiling = x.scaledPerReq && x.scaledPerReq > 0
      ? ((CPU_CEILING - P1_INTERCEPT) * 1e6) / x.scaledPerReq
      : null;
  }

  const out = [
    '### Phase 02 TLS 비교',
    '',
    `고정 부하 300 RPS / 90초. 유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외.`,
    `앱 유휴 CPU ${IDLE_CPU} 코어(실측). 환산 천장 = (${CPU_CEILING} − ${P1_INTERCEPT}) ÷ (${P1_MARGINAL}µs + TLS 증분).`,
    '',
    '| 구성 | 실측 RPS | p50 | p99 | 핸드쉐이크(클라 대기) | 앱 CPU | nginx CPU | k6 CPU | **TLS 증분 CPU/req** | 환산 요청당 CPU | **환산 천장** |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((x) => [
      LABELS[x.cfg] ?? x.cfg,
      f(x.rps, 0),
      `${f(x.p50, 2, 1000)}ms`,
      `${f(x.p99, 1, 1000)}ms`,
      x.hs === null ? '—' : `${f(x.hs, 2)}ms`,
      f(x.appCpu, 3),
      f(x.nginxCpu, 3),
      f(x.k6Cpu, 3),
      x.deltaPerReq === null ? '—' : `${x.deltaPerReq >= 0 ? '+' : ''}${f(x.deltaPerReq, 0)}µs`,
      `${f(x.scaledPerReq, 0)}µs`,
      `${f(x.derivedCeiling, 0)} RPS`,
    ].join(' | ')).map((b) => `| ${b} |`),
    '',
    '판독:',
    '- **TLS 증분 CPU/req** 가 이번 Phase 의 주인공이다. HTTP 대비 TLS 가 앱 스레드에서 추가로 먹는 시간이다.',
    '  앱 스레드는 하나뿐이라 이 증분이 그대로 천장을 깎는다.',
    '- TLS 핸드쉐이크 열은 *클라이언트가 기다린 시간*이지 서버 CPU 가 아니다. 둘을 혼동하면 안 된다.',
    '- nginx CPU 가 앱 CPU 를 대신 쓰고 있으면 오프로딩이 작동한 것이다.',
    '- k6 CPU 가 상한(1.5)에 가까우면 그 측정은 서버가 아니라 생성기를 잰 것이다.',
  ].join('\n');

  console.log(out);
  fs.writeFileSync(path.join(ROOT, 'results', 'tls-comparison.md'), `${out}\n`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
