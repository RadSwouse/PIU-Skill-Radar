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
  drawRadar(res, skills);
  drawList(res, skills);
  drawDetail(res);
}

function drawRadar(res, skills) {
  const svg = $('radar');
  while (svg.lastChild && svg.lastChild.nodeName !== 'title') svg.removeChild(svg.lastChild);
  const narrow = (svg.clientWidth || 560) < 520;
  svg.classList.toggle('narrow', narrow);
  const cx = 280, cy = 268, R = narrow ? 142 : 178, n = skills.length;
  // one scale for both play styles so Single and Double shapes compare directly
  const vals = [];
  for (const m of Object.keys(SPOKES)) for (const s of SPOKES[m]) { const v = result[m].skills[s].level; if (v != null) vals.push(v); }
  let lo = 12, hi = 24;
  if (vals.length) {
    lo = Math.max(0, Math.min(12, Math.floor((Math.min(...vals) - 2) / 4) * 4));
    hi = Math.max(lo + 8, Math.ceil((Math.max(...vals) + 1) / 4) * 4);
  }
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
    t2.textContent = off ? `${d.qualifying}/${MIN_CLEARS} clears` : fmt(d.level, 1);
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
  result = compute(cat, data.plays, disc);
  histData = buildHistory(cat, data.plays, disc);
}

function show() {
  const has = !!(data && data.plays && data.plays.length);
  $('app').classList.toggle('app-hidden', !has);
  $('hero').classList.toggle('app-hidden', has);
  $('seg').classList.toggle('app-hidden', !has);
  if (has) { recomputeAll(); render(); }
  else { document.body.classList.remove('mode-single', 'mode-double'); $('sub').textContent = 'Pump It Up Phoenix 2'; }
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
  const savedRaw = store.get(STORE);
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
    const nw = $('radar').clientWidth < 520; if (nw !== lastNarrow) { lastNarrow = nw; if (data) render(); } }, 120); });
}
start();
window.__skillRadar = { get result() { return result; }, get history() { return histData; }, get data() { return data; } };
