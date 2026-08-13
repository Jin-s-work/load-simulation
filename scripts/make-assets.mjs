#!/usr/bin/env node
// README 용 SVG 에셋 생성기.
//
// 왜 스크립트로 만드나:
//   라이트/다크 두 벌이 필요한데(GitHub 은 <picture> + prefers-color-scheme 로 고른다),
//   손으로 두 파일을 관리하면 반드시 어긋난다. 색만 다른 같은 도형이므로 토큰만 바꿔 찍는다.
//
// 숫자를 바꿀 일이 생기면 아래 STATS / PHASES 만 고치고 다시 돌린다.
//   node scripts/make-assets.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');

// 한글이 들어가므로 폰트 스택에 한글 시스템 폰트를 반드시 포함한다.
// SVG 가 <img> 로 로드되면 외부 폰트를 못 받으므로 시스템 폰트만 쓴다.
const FONT = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', system-ui, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";

// 색 토큰. Apple 의 시스템 컬러를 기준으로 하되 GitHub 배경에 얹히므로 배경은 투명으로 둔다.
const THEMES = {
  light: {
    fg: '#1d1d1f',     // 거의 검정. 순수 #000 은 눈이 아프다
    fg2: '#6e6e73',    // 보조 텍스트
    fg3: '#86868b',    // 3차 텍스트
    line: '#d2d2d7',   // 헤어라인
    accent: '#0071e3', // 완료 표시
    track: '#e8e8ed',  // 미완료 트랙
  },
  dark: {
    fg: '#f5f5f7',
    fg2: '#a1a1a6',
    fg3: '#86868b',
    line: '#38383d',
    accent: '#0a84ff',
    track: '#2c2c2e',
  },
};

// ── 헤더에 세울 숫자 ────────────────────────────────────────────────
// 전부 실측값이다. 추측한 숫자를 여기 넣지 않는다.
const STATS = [
  { value: '10', label: '완료한 단계' },
  { value: '1,005', label: 'RPS · 10분 지속' },
  { value: '105ms', label: 'p99 (목표 200ms)' },
  { value: '7.9×', label: '처리량 개선 (Phase 05)' },
];

const PHASES = [
  { no: '01', name: '기준선', done: true },
  { no: '02', name: 'TLS', done: true },
  { no: '03', name: '로드밸런서', done: true },
  { no: '04', name: '앱서버', done: true },
  { no: '05', name: '커넥션 풀', done: true },
  { no: '06', name: 'DB 프록시', done: true },
  { no: '07', name: '캐시', done: true },
  { no: '08', name: 'MQ', done: true },
  { no: '09', name: '최종 검증', done: true },
  { no: '10', name: '클라우드 설계', done: true },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 헤더 배너.
 *
 * 레이아웃 근거(§16 craft — 모든 간격은 설명 가능해야 한다):
 *   제목 54px  → 자간 -1.6px. 큰 글자는 좁혀야 뭉쳐 보인다 (§15)
 *   설명 17px  → 자간 0. 본문 크기는 건드리지 않는다
 *   라벨 12px  → 자간 +0.4px. 작은 글자는 벌려야 읽힌다 (§15)
 *   구분선은 박스가 아니라 헤어라인. 통계는 가두지 않는다 (§16 simplicity)
 */
function hero(t) {
  const W = 1200; const H = 300;
  const cx = W / 2;
  const colW = 232;
  const startX = cx - (STATS.length * colW) / 2;

  const cols = STATS.map((s, i) => {
    const x = startX + colW * i + colW / 2;
    return `
    <text x="${x}" y="228" font-family="${FONT}" font-size="40" font-weight="600"
          letter-spacing="-0.8" fill="${t.fg}" text-anchor="middle">${esc(s.value)}</text>
    <text x="${x}" y="256" font-family="${FONT}" font-size="12" font-weight="500"
          letter-spacing="0.4" fill="${t.fg3}" text-anchor="middle">${esc(s.label)}</text>`;
  }).join('');

  // 통계 사이 헤어라인. 양 끝에는 긋지 않는다.
  const seps = STATS.slice(1).map((_, i) => {
    const x = startX + colW * (i + 1);
    return `<line x1="${x}" y1="204" x2="${x}" y2="252" stroke="${t.line}" stroke-width="1"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="loadtest-sim — 하나의 라우트를 10단계에 걸쳐 터뜨리며 백엔드 병목을 해부한 기록">
  <title>loadtest-sim</title>
  <text x="${cx}" y="112" font-family="${FONT}" font-size="54" font-weight="700"
        letter-spacing="-1.6" fill="${t.fg}" text-anchor="middle">loadtest&#8203;-sim</text>
  <text x="${cx}" y="150" font-family="${FONT}" font-size="17" font-weight="400"
        fill="${t.fg2}" text-anchor="middle">하나의 라우트를 10단계에 걸쳐 터뜨리며 백엔드 병목을 해부한 기록</text>
  <line x1="${cx - 24}" y1="176" x2="${cx + 24}" y2="176" stroke="${t.accent}" stroke-width="2" stroke-linecap="round"/>
${seps}${cols}
</svg>
`;
}

/**
 * 로드맵 스트립.
 *
 * 진행률 막대를 하나로 그리지 않고 9칸으로 쪼갠 이유:
 *   "몇 % 했나" 보다 "어느 계층까지 갔나" 가 이 프로젝트에서 의미 있는 정보다.
 *   칸마다 이름이 붙어야 그걸 읽을 수 있다 (§16 — 라벨은 구체적으로).
 */
function roadmap(t) {
  const W = 1200; const H = 96;
  const n = PHASES.length;
  const gap = 10;
  const pad = 20;
  const segW = (W - pad * 2 - gap * (n - 1)) / n;

  const segs = PHASES.map((p, i) => {
    const x = pad + (segW + gap) * i;
    const mid = x + segW / 2;
    const fill = p.done ? t.accent : t.track;
    const noColor = p.done ? t.fg : t.fg3;
    const nameColor = p.done ? t.fg2 : t.fg3;
    return `
    <rect x="${x}" y="18" width="${segW}" height="7" rx="3.5" fill="${fill}"/>
    <text x="${mid}" y="52" font-family="${MONO}" font-size="13" font-weight="600"
          letter-spacing="0.3" fill="${noColor}" text-anchor="middle">${p.no}</text>
    <text x="${mid}" y="72" font-family="${FONT}" font-size="11.5" font-weight="400"
          letter-spacing="0.2" fill="${nameColor}" text-anchor="middle">${esc(p.name)}</text>`;
  }).join('');

  // 대체 텍스트는 PHASES 에서 파생시킨다. 손으로 적으면 반드시 낡는다.
  const done = PHASES.filter((p) => p.done);
  const todo = PHASES.filter((p) => !p.done);
  const label = `Phase 로드맵: ${done.map((p) => `${p.no} ${p.name}`).join(', ')} 완료`
    + `${todo.length ? ` / ${todo.map((p) => `${p.no} ${p.name}`).join(', ')} 예정` : ''}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
  <title>Phase 로드맵 — ${n}단계 중 ${done.length}단계 완료</title>
${segs}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(OUT, `hero-${name}.svg`), hero(t));
  fs.writeFileSync(path.join(OUT, `roadmap-${name}.svg`), roadmap(t));
}
console.log(`생성 완료 → ${OUT}`);
for (const f of fs.readdirSync(OUT).sort()) {
  console.log(`  ${f}  ${fs.statSync(path.join(OUT, f)).size}B`);
}
