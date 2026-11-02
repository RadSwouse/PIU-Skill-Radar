// Skill Radar UI.
import { SPOKES, MIN_CLEARS, buildCatalog, discounts, compute, buildHistory } from './engine.js';
import { importFromPiuScores, PiuScoresError } from './sources/piuscores.js';
import { readArcadeStatFile } from './sources/arcadestat.js';

const STORE = 'skillRadar.v2', TOKEN_KEY = 'skillRadar.piuToken';
let baseCatalog = null;                 // data/catalog.json rows
let data = null;                        // { catalog, plays, player, source, loadedAt, stats }
let result = null, histData = null, histOpen = false, mode = 'Double', selected = null;

const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v.toFixed(d);
const fmtScore = s => s.toLocaleString('en-US');
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}
function latestDate(plays) { let m = ''; for (const p of plays) if (p[4] > m) m = p[4]; return m; }

function render() {
  const res = result[mode], skills = SPOKES[mode];
  $('btn-single').setAttribute('aria-pressed', mode === 'Single');
  $('btn-double').setAttribute('aria-pressed', mode === 'Double');
  document.body.classList.toggle('mode-single', mode === 'Single');
  document.body.classList.toggle('mode-double', mode === 'Double');
  const shown = skills.filter(s => res.skills[s].level != null);
  $('sub').textContent = `${data.player || 'Player'} · Phoenix 2 · scores through ${latestDate(data.plays) || '—'}`;
  if (!selected || !res.skills[selected]) {
    selected = shown.slice().sort((a, b) => res.skills[b].level - res.skills[a].level)[0] || skills[0];
  }
  if (replay.open) { drawTimeline(); drawReplayFrame(); } else drawRadar(res, skills);
  $('list-level-head').textContent = replay.open ? 'Now' : 'Level';
  drawList(res, skills);
  drawDetail(res);
}

// One scale for both play styles (and every replay frame) so shapes compare directly.
function radarScale() {
  const vals = [];
  for (const m of Object.keys(SPOKES)) for (const s of SPOKES[m]) { const v = result[m].skills[s].level; if (v != null) vals.push(v); }
  let lo = 12, hi = 24;
  if (vals.length) {
    lo = Math.max(0, Math.min(12, Math.floor((Math.min(...vals) - 2) / 4) * 4));
    hi = Math.max(lo + 8, Math.ceil((Math.max(...vals) + 1) / 4) * 4);
  }
  return { lo, hi };
}

function drawRadar(res, skills, inReplay = false) {
  const svg = $('radar');
  while (svg.lastChild && svg.lastChild.nodeName !== 'title') svg.removeChild(svg.lastChild);
  const narrow = (svg.clientWidth || 560) < 520;
  svg.classList.toggle('narrow', narrow);
  const cx = 280, cy = 268, R = narrow ? 142 : 178, n = skills.length;
  const { lo, hi } = radarScale();
  const rad = v => R * Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const ang = i => -Math.PI / 2 + i * 2 * Math.PI / n;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  $('radar-title').textContent = `${mode} skill radar, levels ${lo} to ${hi}`;
  // rings
  const g = el('g', {}, svg);
  for (let v = lo + 4; v <= hi; v += 4) {
    const pts = skills.map((_, i) => pt(i, rad(v)).map(x => x.toFixed(1)).join(',')).join(' ');
    el('polygon', { points: pts, fill: 'none', stroke: 'var(--grid)', 'stroke-width': 1 }, g);
    const t = el('text', { x: cx + 5, y: cy + rad(v) - 4, class: 'ring-label' }, g); t.textContent = v;
  }
  // spokes
  skills.forEach((s, i) => {
    const [x, y] = pt(i, R), off = res.skills[s].level == null;
    el('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: off ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1,
                 'stroke-dasharray': off ? '3 4' : 'none' }, g);
  });
  // polygon through shown skills (hidden ones are skipped)
  const idx = skills.map((s, i) => i).filter(i => res.skills[skills[i]].level != null);
  if (idx.length >= 3) {
    const pts = idx.map(i => pt(i, rad(res.skills[skills[i]].level)).map(x => x.toFixed(1)).join(',')).join(' ');
    el('polygon', { points: pts, fill: 'var(--series-1-fill)', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  }
  // vertices + hit areas
  const tip = $('tip'), card = $('radar-card');
  idx.forEach(i => {
    const s = skills[i], d = res.skills[s], [x, y] = pt(i, rad(d.level));
    el('circle', { cx: x, cy: y, r: s === selected ? 6 : 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
    const hit = el('circle', { cx: x, cy: y, r: 14, fill: 'transparent', class: 'ax-hit', tabindex: 0,
                               role: 'button', 'aria-label': `${s}: level ${fmt(d.level, 2)}` }, svg);
    const show = () => {
      tip.replaceChildren(h('strong', { text: 'Lv.' + fmt(d.level, 2) }), h('br'), h('span', { class: 'k', text: s }));
      const box = svg.getBoundingClientRect(), cb = card.getBoundingClientRect(), k = box.width / 560;
      tip.style.left = Math.min(cb.width - 170, Math.max(4, (box.left - cb.left) + x * k + 12)) + 'px';
      tip.style.top = ((box.top - cb.top) + y * k - 46) + 'px';
      tip.style.opacity = 1;
    };
    hit.addEventListener('pointerenter', show); hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => tip.style.opacity = 0); hit.addEventListener('blur', () => tip.style.opacity = 0);
    hit.addEventListener('click', () => select(s));
    hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s); } });
  });
  // axis labels
  skills.forEach((s, i) => {
    const d = res.skills[s], off = d.level == null, a = ang(i), [x, y] = pt(i, R + 26);
    const c = Math.cos(a), anchor = Math.abs(c) < 0.25 ? 'middle' : (c > 0 ? 'start' : 'end');
    const dy = Math.sin(a) > 0.6 ? 10 : (Math.sin(a) < -0.6 ? -8 : 0);
    const lg = el('g', { class: 'ax-hit' }, svg);
    const t1 = el('text', { x, y: y + dy, 'text-anchor': anchor, class: 'ax-name' + (off ? ' off' : '') + (s === selected ? ' sel' : '') }, lg);
    t1.textContent = s;
    const t2 = el('text', { x, y: y + dy + (narrow ? 22 : 15), 'text-anchor': anchor, class: 'ax-val' + (off ? ' off' : '') }, lg);
    t2.textContent = off ? (inReplay ? '—' : `${d.qualifying}/${MIN_CLEARS} clears`) : fmt(d.level, 1);
    lg.addEventListener('click', () => select(s));
  });
}

function drawList(res, skills) {
  const list = $('list'); list.replaceChildren();
  const shown = skills.filter(s => res.skills[s].level != null).sort((a, b) => res.skills[b].level - res.skills[a].level);
  const hidden = skills.filter(s => res.skills[s].level == null);
  const row = (s, off) => {
    const d = res.skills[s];
    const r = h('div', { class: 'row' + (off ? ' hidden' : ''), role: 'option', tabindex: 0, 'aria-selected': s === selected,
                         onclick: () => select(s), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s); } } },
      h('span', { class: 'name', text: s }),
      h('span', { class: 'lv', text: off ? '—' : 'Lv.' + fmt(d.level, 1) }));
    list.appendChild(r);
  };
  shown.forEach(s => row(s, false));
  if (hidden.length) { list.appendChild(h('div', { class: 'divider' })); hidden.forEach(s => row(s, true)); }
}

function drawDetail(res) {
  const d = res.skills[selected], box = $('detail'); box.replaceChildren();
  const off = d.level == null;
  const title = h('h2', {}, `${mode} ${selected} — `);
  title.appendChild(off ? document.createTextNode(`${d.qualifying} / ${MIN_CLEARS} clears`)
                        : h('span', { class: 'lv', text: 'Lv.' + fmt(d.level, 2) }));
  box.appendChild(title);
  const rows = off ? d.qualList : d.used, extra = off ? [] : d.rest.slice(0, 5);
  if (!rows.length) {
    box.appendChild(h('p', { class: 'note', text: `No ${mode.toLowerCase()} clears tagged ${selected} yet.` }));
  } else {
    const head = h('tr', {}, ...['Chart', 'Song', 'Score', 'Grade', 'Chart lv', 'Score adj', 'Share', 'Value']
      .map((t, i) => h('th', { class: i >= 2 && i !== 3 ? 'num' : '', text: t })));
    const tbody = h('tbody');
    const line = (u, grey) => tbody.appendChild(h('tr', { class: grey ? 'extra' : '' },
      h('td', { text: u.chart }), h('td', { class: 'song', text: u.title }),
      h('td', { class: 'num', text: fmtScore(u.score) }), h('td', { text: u.grade }),
      h('td', { class: 'num', text: fmt(u.clevel, 2) }), h('td', { class: 'num', text: (u.adj >= 0 ? '+' : '') + fmt(u.adj, 2) }),
      h('td', { class: 'num', text: Math.round(u.share * 100) + '%' }), h('td', { class: 'num', text: fmt(u.value, 2) })));
    rows.forEach(u => line(u, false));
    extra.forEach(u => line(u, true));
    box.appendChild(h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, head), tbody)));
  }
  drawHistory(box, d);
}

const tOf = d => Date.parse(d + 'T00:00:00Z');
const fmtDate = d => new Date(tOf(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function drawHistory(box, d) {
  const outer = h('div', { class: 'hist' });
  const btn = h('button', { type: 'button', class: 'hist-toggle', 'aria-expanded': String(histOpen), 'aria-controls': 'hist-body' },
    h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }), histOpen ? 'Hide history' : 'Show history');
  outer.appendChild(btn); box.appendChild(outer);
  btn.addEventListener('click', () => { histOpen = !histOpen; drawDetail(result[mode]); const b = document.querySelector('.hist-toggle'); if (b) b.focus(); });
  if (!histOpen) return;
  const sec = h('div', { class: 'hist-body', id: 'hist-body' });
  outer.appendChild(sec);
  const levels = histData[mode][selected], dates = histData.dates;
  const pts = dates.map((date, i) => ({ date, v: levels[i] })).filter(q => q.v != null);
  if (pts.length < 2) {
    sec.appendChild(h('p', { class: 'note', text: pts.length ? 'Only one day of history so far.' : 'History starts once this skill has a level.' }));
    return;
  }
  // keep only the days the level moved (plus the first and last), so the line steps where it changed
  const steps = pts.filter((q, i) => i === 0 || i === pts.length - 1 || Math.abs(q.v - pts[i - 1].v) > 1e-9);
  const W = 900, H = 230, ml = 46, mr = 18, mt = 12, mb = 28;
  const t0 = tOf(pts[0].date), t1 = Math.max(tOf(dates[dates.length - 1]), t0 + 86400000);
  const vs = pts.map(q => q.v);
  const vmin = Math.min(...vs) - 0.2, vmax = Math.max(...vs) + 0.2;
  const ystep = (vmax - vmin) > 2.5 ? 1 : 0.5;
  const y0 = Math.floor(vmin / ystep) * ystep, y1 = Math.max(Math.ceil(vmax / ystep) * ystep, y0 + 1);
  const X = t => ml + (W - ml - mr) * (t - t0) / (t1 - t0), Y = v => mt + (H - mt - mb) * (1 - (v - y0) / (y1 - y0));
  const wrap = h('div', { class: 'hist-wrap' }); sec.appendChild(wrap);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  wrap.appendChild(svg);
  const first = pts[0], last = pts[pts.length - 1];
  el('title', {}, svg).textContent = `${mode} ${selected} level over time: Lv.${fmt(first.v, 2)} on ${fmtDate(first.date)} to Lv.${fmt(last.v, 2)} on ${fmtDate(last.date)}`;
  for (let v = y0; v <= y1 + 1e-9; v += ystep) {
    el('line', { x1: ml, x2: W - mr, y1: Y(v), y2: Y(v), stroke: v === y0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    const t = el('text', { x: ml - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg); t.textContent = fmt(v, ystep < 1 ? 1 : 0);
  }
  const nT = Math.min(6, pts.length);
  for (let k = 0; k < nT; k++) {
    const q = pts[Math.round(k * (pts.length - 1) / Math.max(1, nT - 1))];
    const t = el('text', { x: X(tOf(q.date)), y: H - 8, 'text-anchor': k === 0 ? 'start' : (k === nT - 1 ? 'end' : 'middle'), class: 'tick' }, svg);
    t.textContent = fmtDate(q.date);
  }
  let path = `M${X(tOf(steps[0].date)).toFixed(1)},${Y(steps[0].v).toFixed(1)}`;
  for (let i = 1; i < steps.length; i++) path += `H${X(tOf(steps[i].date)).toFixed(1)}V${Y(steps[i].v).toFixed(1)}`;
  path += `H${X(t1).toFixed(1)}`;
  el('path', { d: path, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  el('circle', { cx: X(tOf(last.date)), cy: Y(last.v), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
  // crosshair + tooltip
  const cross = el('line', { y1: mt, y2: H - mb, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0 }, svg);
  const dot = el('circle', { r: 4, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 }, svg);
  const over = el('rect', { x: ml, y: mt, width: W - ml - mr, height: H - mt - mb, fill: 'transparent', tabindex: 0,
                            'aria-label': 'Level history; use left and right arrows to step through days' }, svg);
  const tip = h('div', { class: 'tip' }); wrap.appendChild(tip);
  let cur = pts.length - 1;
  const show = i => {
    cur = Math.max(0, Math.min(pts.length - 1, i));
    const q = pts[cur], x = X(tOf(q.date)), y = Y(q.v);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', 1);
    tip.replaceChildren(h('strong', { text: 'Lv.' + fmt(q.v, 2) }), h('br'), h('span', { class: 'k', text: fmtDate(q.date) }));
    const k = svg.getBoundingClientRect().width / W;
    tip.style.left = Math.min(wrap.clientWidth - 110, Math.max(0, x * k + 10)) + 'px';
    tip.style.top = Math.max(0, y * k - 50) + 'px'; tip.style.opacity = 1;
  };
  const hide = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.style.opacity = 0; };
  over.addEventListener('pointermove', e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width;
    let best = 0, bd = Infinity;
    pts.forEach((q, i) => { const dd = Math.abs(X(tOf(q.date)) - x); if (dd < bd) { bd = dd; best = i; } });
    show(best);
  });
  over.addEventListener('pointerleave', hide); over.addEventListener('blur', hide);
  over.addEventListener('focus', () => show(cur));
  over.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); }
  });
  const ch = last.v - first.v;
  sec.appendChild(h('p', { class: 'note', text: `${ch >= 0 ? '+' : '−'}${fmt(Math.abs(ch), 2)} since ${fmtDate(first.date)}, when this skill first had a level.` }));
}


// ---------- replay ----------
const DAY = 86400000, DAYS_PER_SECOND = 4;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const replay = { open: false, playing: false, t: 0, speed: 1, raf: 0, last: 0, dragging: false };
let catMap = null;
const replayTimes = () => histData.dates.map(tOf);
const longDate = t => new Date(t).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

// Where a not-yet-rated spoke crosses the radar outline on play day i, as a level. A new skill
// starts there, so it appears on the existing shape instead of pinching it from the centre.
function outlineCrossing(H, i, k, skills, lo, hi) {
  const n = skills.length, span = hi - lo;
  const rn = v => Math.max(0, Math.min(1, (v - lo) / span));
  const rated = j => H[skills[j]][i] != null;
  let p = -1, q = -1;
  for (let s = 1; s < n; s++) { const j = (k - s + n) % n; if (rated(j)) { p = j; break; } }
  for (let s = 1; s < n; s++) { const j = (k + s) % n; if (rated(j)) { q = j; break; } }
  if (p < 0 || p === q) return lo;                       // no outline to sit on yet
  const ang = j => -Math.PI / 2 + j * 2 * Math.PI / n;
  const r1 = rn(H[skills[p]][i]), r2 = rn(H[skills[q]][i]);
  const P = [r1 * Math.cos(ang(p)), r1 * Math.sin(ang(p))], Q = [r2 * Math.cos(ang(q)), r2 * Math.sin(ang(q))];
  const d = [Math.cos(ang(k)), Math.sin(ang(k))], E = [Q[0] - P[0], Q[1] - P[1]];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0], den = cross(d, E);
  if (Math.abs(den) > 1e-12) {
    const dist = cross(P, E) / den, tt = cross(P, d) / den;   // ray length, position along the edge
    if (dist > 1e-9 && tt >= -1e-9 && tt <= 1 + 1e-9) return lo + dist * span;
  }
  // The outline meets this spoke at the centre or behind it (its rated neighbours are half the
  // circle or more apart), so the skill grows out from the centre.
  return lo;
}

// Radar values at time t: exact on each play day, eased between them. A skill that gets its first
// level starts on the radar outline and moves in or out to its level.
function replayValues(t) {
  const ts = replayTimes(), H = histData[mode], last = ts.length - 1, skills = {};
  let i = 0;
  while (i < last && ts[i + 1] <= t) i++;
  const span = i < last ? ts[i + 1] - ts[i] : 1;
  const f = i < last ? Math.max(0, Math.min(1, (t - ts[i]) / span)) : 0;
  const e = reduceMotion() ? 0 : f * f * (3 - 2 * f);
  const { lo, hi } = radarScale(), skillList = SPOKES[mode];
  skillList.forEach((sk, k) => {
    const a = H[sk][i], b = i < last ? H[sk][i + 1] : a;
    let v;
    if (a != null && b != null) v = a + (b - a) * e;
    else if (a == null && b != null) {
      if (e > 0) { const v0 = outlineCrossing(H, i, k, skillList, lo, hi); v = v0 + (b - v0) * e; } else v = null;
    }
    else v = a;
    skills[sk] = { level: v, qualifying: 0 };
  });
  return { skills, dayIndex: i };
}

function drawReplayFrame() {
  const frame = replayValues(replay.t);
  drawRadar(frame, SPOKES[mode], true);
  const dates = histData.dates;
  $('replay-date').textContent = longDate(replay.t);
  $('replay-day').textContent = `Play day ${frame.dayIndex + 1} of ${dates.length}`;
  const tl = $('timeline');
  if (tl.__x) {
    const x = tl.__x(replay.t);
    tl.querySelector('.scrub').setAttribute('x1', x); tl.querySelector('.scrub').setAttribute('x2', x);
    tl.querySelector('.scrub-knob').setAttribute('cx', x);
    tl.querySelectorAll('.tl-bar').forEach(b => b.setAttribute('opacity', +b.dataset.t <= replay.t + 1 ? 1 : 0.35));
    tl.setAttribute('aria-valuenow', String(frame.dayIndex + 1));
    tl.setAttribute('aria-valuetext', longDate(replay.t));
  }
}

function drawTimeline() {
  const svg = $('timeline'); svg.replaceChildren();
  // drawn at its on-screen width so bars, the knob and the dates keep their size on any screen
  const W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 1000), H = 92, ml = 12, mr = 12, mt = 10, mb = 22;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.__W = W;
  const ts = replayTimes(), t0 = ts[0], t1 = Math.max(ts[ts.length - 1], t0 + DAY);
  const X = t => ml + (W - ml - mr) * (t - t0) / (t1 - t0);
  svg.__x = X; svg.__t = x => t0 + (Math.max(ml, Math.min(W - mr, x)) - ml) / (W - ml - mr) * (t1 - t0);
  // plays per day on this play style's charts
  const counts = new Map();
  for (const p of data.plays) { const c = catMap.get(p[0]); if (c && c.mode === mode) counts.set(p[4], (counts.get(p[4]) || 0) + 1); }
  const max = Math.max(1, ...counts.values());
  const bw = Math.max(3, Math.min(14, (W - ml - mr) / ((t1 - t0) / DAY + 1) * 0.7));
  el('line', { x1: ml, x2: W - mr, y1: H - mb, y2: H - mb, stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  for (const [d, n] of counts) {
    const x = X(tOf(d)), hgt = Math.max(2, (H - mt - mb) * n / max);
    const r = el('rect', { x: x - bw / 2, y: H - mb - hgt, width: bw, height: hgt, rx: 2, fill: 'var(--series-1)', class: 'tl-bar' }, svg);
    r.dataset.t = tOf(d);
    el('title', {}, r).textContent = `${fmtDate(d)}: ${n} play${n === 1 ? '' : 's'}`;
  }
  const first = histData.dates[0], lastD = histData.dates[histData.dates.length - 1];
  const a = el('text', { x: ml, y: H - 5, class: 'tick' }, svg); a.textContent = fmtDate(first);
  const b = el('text', { x: W - mr, y: H - 5, 'text-anchor': 'end', class: 'tick' }, svg); b.textContent = fmtDate(lastD);
  el('line', { class: 'scrub', y1: mt - 4, y2: H - mb, stroke: 'var(--text-primary)', 'stroke-width': 2 }, svg);
  el('circle', { class: 'scrub-knob', cy: mt - 2, r: 6, fill: 'var(--text-primary)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
  svg.setAttribute('aria-valuemin', '1'); svg.setAttribute('aria-valuemax', String(ts.length));
}

function setReplayTime(t) {
  const ts = replayTimes();
  replay.t = Math.max(ts[0], Math.min(ts[ts.length - 1], t));
  drawReplayFrame();
}
function stepDay(dir) {
  const ts = replayTimes();
  let i = 0; while (i < ts.length - 1 && ts[i + 1] <= replay.t) i++;
  const onDay = ts[i] === replay.t;
  setReplayTime(ts[Math.max(0, Math.min(ts.length - 1, dir > 0 ? i + 1 : (onDay ? i - 1 : i)))]);
}
function setPlaying(on) {
  replay.playing = on;
  const btn = $('replay-play');
  btn.replaceChildren(h('span', { 'aria-hidden': 'true', text: on ? '❚❚ ' : '▶ ' }), on ? 'Pause' : 'Play replay');
  cancelAnimationFrame(replay.raf);
  if (!on) return;
  const ts = replayTimes();
  if (replay.t >= ts[ts.length - 1]) replay.t = ts[0];
  replay.last = performance.now();
  const tick = now => {
    const dt = Math.min(100, now - replay.last); replay.last = now;
    const end = ts[ts.length - 1];
    replay.t = Math.min(end, replay.t + dt / 1000 * DAYS_PER_SECOND * replay.speed * DAY);
    drawReplayFrame();
    if (replay.t >= end) { setPlaying(false); return; }
    replay.raf = requestAnimationFrame(tick);
  };
  replay.raf = requestAnimationFrame(tick);
}
function setReplayOpen(open) {
  replay.open = open;
  $('replay-toggle').setAttribute('aria-expanded', String(open));
  $('replay-body').hidden = !open;
  if (open) { const ts = replayTimes(); replay.t = ts[ts.length - 1]; }
  else setPlaying(false);
  render();
}
$('replay-toggle').addEventListener('click', () => setReplayOpen(!replay.open));
$('replay-play').addEventListener('click', () => setPlaying(!replay.playing));
$('replay-speed').addEventListener('change', e => { replay.speed = parseFloat(e.target.value) || 1; });
(() => {
  const tl = $('timeline');
  const toT = e => { const r = tl.getBoundingClientRect(); return tl.__t((e.clientX - r.left) * tl.__W / r.width); };
  tl.addEventListener('pointerdown', e => { replay.dragging = true; setPlaying(false); tl.setPointerCapture(e.pointerId); setReplayTime(toT(e)); });
  tl.addEventListener('pointermove', e => { if (replay.dragging) setReplayTime(toT(e)); });
  tl.addEventListener('pointerup', () => { replay.dragging = false; });
  tl.addEventListener('pointercancel', () => { replay.dragging = false; });
  tl.addEventListener('keydown', e => {
    const ts = replayTimes();
    if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); stepDay(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); stepDay(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setPlaying(false); setReplayTime(ts[0]); }
    else if (e.key === 'End') { e.preventDefault(); setPlaying(false); setReplayTime(ts[ts.length - 1]); }
    else if (e.key === ' ') { e.preventDefault(); setPlaying(!replay.playing); }
  });
})();

function select(s) { selected = s; render(); }
function setMode(m) { mode = m; selected = null; try { history.replaceState(null, '', '#' + m.toLowerCase()); } catch (e) {} render(); }
$('btn-single').addEventListener('click', () => setMode('Single'));
$('btn-double').addEventListener('click', () => setMode('Double'));
window.addEventListener('hashchange', () => { const m = location.hash === '#single' ? 'Single' : 'Double'; if (m !== mode) { mode = m; selected = null; render(); } });

// ---------- data ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
function setStatus(text, kind = '') { const s = $('status'); s.className = 'status' + (kind ? ' ' + kind : ''); s.textContent = text; }

function recomputeAll() {
  const cat = buildCatalog(data.catalog), disc = discounts(cat);
  catMap = cat;
  result = compute(cat, data.plays, disc);
  histData = buildHistory(cat, data.plays, disc);
}

function show() {
  const has = !!(data && data.plays && data.plays.length);
  $('app').classList.toggle('app-hidden', !has);
  $('hero').classList.toggle('app-hidden', has);
  $('seg').classList.toggle('app-hidden', !has);
  if (has) { recomputeAll(); render(); }
  else { if (replay.open) setReplayOpen(false); document.body.classList.remove('mode-single', 'mode-double'); $('sub').textContent = 'Pump It Up Phoenix 2'; }
  drawDataActions();
}

function saveData() {
  const keep = { plays: data.plays, player: data.player, source: data.source, loadedAt: data.loadedAt, stats: data.stats,
                 catalog: data.catalog === baseCatalog ? null : data.catalog };
  return store.set(STORE, JSON.stringify(keep));
}

function drawDataActions() {
  const box = $('data-actions'); box.replaceChildren();
  const token = store.get(TOKEN_KEY);
  if (token) box.appendChild(h('button', { type: 'button', class: 'btn', text: 'Refresh from PIU Scores', onclick: () => loadPiu(token) }));
  if (token) box.appendChild(h('button', { type: 'button', class: 'btn', text: 'Forget my token', onclick: () => {
    store.del(TOKEN_KEY); $('remember').checked = false; setStatus('Token removed from this device.'); drawDataActions(); } }));
  if (data) box.appendChild(h('button', { type: 'button', class: 'btn', text: 'Clear my scores', onclick: () => {
    store.del(STORE); data = null; $('unmatched').replaceChildren(); setStatus('Scores cleared from this device.'); show(); } }));
}

function drawUnmatched(list) {
  const box = $('unmatched'); box.replaceChildren();
  if (!list || !list.length) return;
  const det = h('details', { class: 'unmatched' }, h('summary', { text: `${list.length} played chart${list.length === 1 ? '' : 's'} couldn’t be matched to ArcadeStat` }));
  const ul = h('ul'); list.forEach(n => ul.appendChild(h('li', { text: n }))); det.appendChild(ul);
  box.appendChild(det);
}

let busy = false;
async function loadPiu(token) {
  if (busy) return; busy = true; $('load').disabled = true;
  try {
    const r = await importFromPiuScores(token, baseCatalog, msg => setStatus(msg));
    data = { catalog: baseCatalog, plays: r.plays, player: r.player, source: 'PIU Scores', loadedAt: new Date().toISOString().slice(0, 10), stats: r.stats };
    const saved = saveData();
    if ($('remember').checked || store.get(TOKEN_KEY)) store.set(TOKEN_KEY, token.trim());
    $('token').value = '';
    setStatus(`Loaded ${r.stats.matched} charts from PIU Scores for ${r.player}.` + (saved ? '' : ' This browser won’t keep them after you close it.'), 'ok');
    drawUnmatched(r.stats.unmatched);
    show();
  } catch (e) {
    setStatus(e instanceof PiuScoresError ? e.message : 'Something went wrong reading from PIU Scores: ' + e.message, 'err');
  } finally { busy = false; $('load').disabled = false; }
}

$('piu-form').addEventListener('submit', e => { e.preventDefault(); loadPiu($('token').value); });

async function importFile(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const r = await readArcadeStatFile(file);
    const catalog = r.songs || (data ? data.catalog : baseCatalog);
    const plays = r.plays || (data ? data.plays : null);
    if (!plays) { setStatus('That file has chart tags but no scores. Export the HAR from your Records page so it includes your scores.', 'err'); return; }
    data = { catalog, plays, player: r.player || (data && data.player) || 'You', source: 'ArcadeStat export',
             loadedAt: new Date().toISOString().slice(0, 10), stats: null };
    const saved = saveData();
    drawUnmatched(null);
    setStatus(`Loaded from ${file.name}: ${r.plays ? plays.length + ' plays' : 'scores unchanged'}${r.songs ? ', updated chart tags' : ''}.` +
              (saved ? '' : ' This browser won’t keep them after you close it.'), 'ok');
    show();
  } catch (e) { setStatus(e.message, 'err'); }
}
const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) importFile(f); });
$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });

// ---------- start ----------
async function start() {
  mode = location.hash === '#single' ? 'Single' : 'Double';
  try {
    const res = await fetch('data/catalog.json');
    baseCatalog = (await res.json()).charts;
  } catch (e) { setStatus('Could not load the chart data (data/catalog.json).', 'err'); return; }
  // A build can point at a sample-scores file (used for previews); it is never used once a player loads their own.
  const sample = document.querySelector('meta[name="sample-scores"]');
  const savedRaw = store.get(STORE);
  if (!savedRaw && sample) {
    try {
      const s = await (await fetch(sample.content)).json();
      data = { catalog: baseCatalog, plays: s.plays, player: s.player, source: 'sample scores', loadedAt: s.loadedAt, stats: null };
      setStatus(`Showing sample scores (${s.player}). Load your own above.`);
    } catch (e) {}
  }
  if (savedRaw) {
    try {
      const s = JSON.parse(savedRaw);
      if (s && Array.isArray(s.plays)) {
        data = { catalog: s.catalog || baseCatalog, plays: s.plays, player: s.player, source: s.source, loadedAt: s.loadedAt, stats: s.stats };
        setStatus(`Showing ${data.player || 'your'} scores from ${data.source}, loaded ${data.loadedAt}.`);
        if (s.stats) drawUnmatched(s.stats.unmatched);
      }
    } catch (e) {}
  }
  if (store.get(TOKEN_KEY)) $('remember').checked = true;
  show();
  let lastNarrow = null, rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => {
    const nw = $('radar').clientWidth < 520;
    if (nw !== lastNarrow) { lastNarrow = nw; if (data) render(); }
    else if (data && replay.open) { drawTimeline(); drawReplayFrame(); } }, 120); });
}
start();
window.__skillRadar = { get result() { return result; }, get history() { return histData; }, get data() { return data; },
  replayValuesAt: t => replayValues(t).skills, scale: () => radarScale(), get replay() { return { open: replay.open, playing: replay.playing, t: replay.t }; } };
