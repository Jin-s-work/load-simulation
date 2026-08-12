#!/usr/bin/env node
// Phase 06 분석기 — 커넥션 풀러(PgBouncer).
//
// 이 Phase 의 핵심 질문은 하나다:
//   "앱이 열려는 커넥션 수" 와 "DB 가 실제로 받는 커넥션 수" 를 분리할 수 있는가.
//
// 그래서 표의 중심은 처리량이 아니라 **커넥션 수와 메모리**다.
// Phase 05 에서 얻은 `사적메모리 ≈ 10MB + 3.1MB × 커넥션수` 로 절감분을 검증한다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROM = process.env.PROM_URL || 'http://localhost:9090';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = '/api/v1/events/:eventId/reservations';
const SKIP_HEAD = Number(process.env.SKIP_HEAD || 20);
const SKIP_TAIL = Number(process.env.SKIP_TAIL || 3);

// Phase 05 에서 실측한 회귀식. 커넥션 절감이 메모리로 얼마나 돌아오는지 계산할 때 쓴다.
const MEM_BASE_MB = 10;
const MEM_PER_CONN_MB = 3.1;

async function q(expr, at) {
  try {
    const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`);
    if (!res.ok) return null;
    const b = await res.json();
    if (b.status !== 'success' || !b.data.result.length) return null;
    const v = Number(b.data.result[0].value[1]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const f = (v, d = 1, s = 1) => (v === null || v === undefined ? '—' : (v * s).toFixed(d));

function csvStats(name, suffix, from, to, cols) {
  const p = path.join(ROOT, 'results', `${name}.${suffix}.csv`);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  if (lines.length < 2) return null;
  const rows = lines.slice(1).map((l) => l.split(',').map(Number))
    .filter((r) => r.length > Math.max(...Object.values(cols)) && r[0] >= from && r[0] <= to);
  if (!rows.length) return null;
  const out = { samples: rows.length };
  for (const [k, i] of Object.entries(cols)) {
    const a = rows.map((r) => r[i]).filter(Number.isFinite);
    out[`${k}Avg`] = a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    out[`${k}Max`] = a.length ? Math.max(...a) : null;
  }
  return out;
}

function k6Stats(name) {
  const p = path.join(ROOT, 'results', `${name}.log`);
  if (!fs.existsSync(p)) return {};
    // ★ utf8 로 읽어야 한다. latin1 로 읽으면 한글이 깨져 정규식이 전부 안 맞는다.
  //   (공백도 지우면 안 된다 — 아래 정규식들이 공백을 포함해 쓰였다.)
  const t = fs.readFileSync(p, 'utf8');
  const grab = (re) => { const m = t.match(re); return m ? m[1] : null; };
  return {
    rps: grab(/평균 ([\d.]+) RPS/),
    fail: grab(/실패율\s*:\s*([\d.]+)/),
    p50: grab(/med=([\d.]+)ms/),
    p99: grab(/p99=([\d.]+)ms/),
    noResp: grab(/status 0 \(응답 없음\)\s+(\d+)/),
    e503: grab(/503 Unavailable\s+(\d+)/),
    e504: grab(/504 Gateway Timeout\s+(\d+)/),
  };
}

async function measure(name) {
  const metaPath = path.join(ROOT, 'results', `${name}.meta.json`);
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sumPath = path.join(ROOT, 'results', `${name}.json`);

  let from; let to;
  if (fs.existsSync(sumPath)) {
    const s = JSON.parse(fs.readFileSync(sumPath, 'utf8')).schedule[0];
    from = meta.startEpoch + s.holdStart + SKIP_HEAD;
    to = meta.startEpoch + s.holdEnd - SKIP_TAIL;
  } else {
    from = meta.startEpoch + 30 + SKIP_HEAD;
    to = meta.endEpoch - SKIP_TAIL;
  }
  const w = Math.max(1, to - from);
  const r = `route="${ROUTE}"`;

  const [ok, acqP99, acqErr, poolTotal, poolWait] = await Promise.all([
    q(`sum(increase(http_request_duration_seconds_count{${r},status=~"2.."}[${w}s]))`, to),
    q(`histogram_quantile(0.99, sum by (le) (increase(db_pool_acquire_wait_seconds_bucket{job="app"}[${w}s])))`, to),
    q(`sum(increase(db_pool_acquire_error_total{job="app"}[${w}s]))`, to),
    q(`avg_over_time(sum(db_pool_connections{job="app",state="total"})[${w}s:2s])`, to),
    q(`avg_over_time(sum(db_pool_connections{job="app",state="waiting"})[${w}s:2s])`, to),
  ]);

  return {
    name, meta, w,
    okRps: ok === null ? null : ok / w,
    acqP99, acqErr, poolTotal, poolWait,
    // .pg.csv:  ts,total,active,idle,idle_in_tx,waiting_locks,vmrss_kb,rssanon_kb
    pg: csvStats(name, 'pg', from, to, { conn: 1, active: 2, idle: 3, idleTx: 4, rssAnon: 7 }),
    // .pgb.csv: ts,cl_active,cl_waiting,sv_active,sv_idle,sv_used,maxwait_us
    pgb: csvStats(name, 'pgb', from, to, { clActive: 1, clWaiting: 2, svActive: 3, svIdle: 4, maxwait: 6 }),
    k6: k6Stats(name),
  };
}

const names = process.argv.slice(2);
const rows = [];
for (const n of names) { const m = await measure(n); if (m) rows.push(m); }

const g = (x, grp, k, d = 0, s = 1) => (x[grp] && x[grp][k] != null ? (x[grp][k] * s).toFixed(d) : '—');

const out = [
  '### Phase 06 커넥션 풀러(PgBouncer) 측정',
  '',
  `유지구간 앞 ${SKIP_HEAD}s / 뒤 ${SKIP_TAIL}s 제외. **총 앱 CPU 를 2.4 로 고정**(3대×0.8 = 6대×0.4).`,
  '',
  '#### 커넥션 접힘 — 이 Phase 의 핵심',
  '',
  '| 실험 | 앱 | 앱풀 상한 | 프록시 | **앱이 연 커넥션** | **DB 실제 커넥션** | 접힘비 | DB 사적메모리 | Phase05 식 추정 |',
  '|---|--:|--:|:--|--:|--:|--:|--:|--:|',
  ...rows.map((x) => {
    const dbConn = x.pg ? x.pg.connAvg : null;
    // 샘플러 psql 2개는 앱과 무관하다. 표기만 하고 빼지 않는다(빼면 자의적이 된다).
    const appConn = x.meta.useProxy ? (x.pgb ? x.pgb.clActiveAvg : null) : dbConn;
    const ratio = appConn && dbConn ? appConn / dbConn : null;
    const est = dbConn ? MEM_BASE_MB + MEM_PER_CONN_MB * dbConn : null;
    return `| ${[
      x.name,
      x.meta.apps,
      x.meta.appPoolTotal,
      x.meta.useProxy ? `${x.meta.pgbPoolMode}/${x.meta.pgbDefaultPoolSize}` : '없음',
      f(appConn, 1),
      f(dbConn, 1),
      ratio ? `${ratio.toFixed(2)}:1` : '—',
      `${g(x, 'pg', 'rssAnonAvg', 0, 1 / 1024)}MB`,
      est ? `${est.toFixed(0)}MB` : '—',
    ].join(' | ')} |`;
  }),
  '',
  '#### 처리량·지연',
  '',
  '| 실험 | k6 RPS | k6 p50 | k6 p99 | 실패율 | 503 | 504 | 무응답 | 앱 획득대기 p99 | 앱 획득실패 |',
  '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
  ...rows.map((x) => `| ${[
    x.name,
    x.k6.rps ?? '—',
    x.k6.p50 ? `${x.k6.p50}ms` : '—',
    x.k6.p99 ? `${x.k6.p99}ms` : '—',
    x.k6.fail ? `${x.k6.fail}%` : '—',
    x.k6.e503 ?? '—',
    x.k6.e504 ?? '—',
    x.k6.noResp ?? '—',
    `${f(x.acqP99, 1, 1000)}ms`,
    f(x.acqErr, 0),
  ].join(' | ')} |`),
  '',
  '#### PgBouncer 내부 (SHOW POOLS, 2초 샘플)',
  '',
  '| 실험 | cl_active avg/max | **cl_waiting avg/max** | sv_active avg | sv_idle avg | **maxwait max** |',
  '|---|--:|--:|--:|--:|--:|',
  ...rows.filter((x) => x.pgb).map((x) => `| ${[
    x.name,
    `${g(x, 'pgb', 'clActiveAvg', 1)}/${g(x, 'pgb', 'clActiveMax')}`,
    `${g(x, 'pgb', 'clWaitingAvg', 1)}/${g(x, 'pgb', 'clWaitingMax')}`,
    g(x, 'pgb', 'svActiveAvg', 1),
    g(x, 'pgb', 'svIdleAvg', 1),
    `${g(x, 'pgb', 'maxwaitMax', 1, 1 / 1000)}ms`,
  ].join(' | ')} |`),
  '',
  '판독:',
  '- **접힘비** = 앱이 연 커넥션 / DB 실제 커넥션. 프록시의 존재 이유가 이 숫자다.',
  '  session 모드면 1:1 에 가깝고, transaction 모드면 크게 벌어져야 한다.',
  '- **cl_waiting > 0** 이면 프록시 쪽 풀이 좁아 클라이언트가 서버 커넥션을 기다린다.',
  '  이때 병목은 DB 가 아니라 `default_pool_size` 다.',
  '- **Phase05 식 추정** = 10MB + 3.1MB × DB커넥션수. 실측과 맞으면 그 회귀식이 재확인된 것이다.',
].join('\n');

console.log(out);
fs.writeFileSync(path.join(ROOT, 'results', 'phase06-summary.md'), `${out}\n`);
