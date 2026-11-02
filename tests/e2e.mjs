// End-to-end test: serves the site, mocks the PIU Scores API, loads scores through the token form,
// and checks every skill level against levels computed by tools/engine_reference.py.
//
//   node tests/e2e.mjs <catalog.json> <arcadestat record_all.json> <expected.json> [screenshotDir]
//
// The mock answers like PIU Scores' api/v2: Basic auth, cursor pages with an absolute `next` link
// (deliberately on http:// to check the client keeps requests on the API's https origin), one 429
// with Retry-After, cut songs listed without their suffix, plus co-op charts and an unknown chart.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [catalogPath, recordsPath, expectedPath, shots] = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-123';
const API = 'https://piuscores.arroweclip.se/api/v2';

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).charts;
const records = JSON.parse(fs.readFileSync(recordsPath, 'utf8')).list.filter(p => !p.isUnknownScore);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

// ---- mock data ----
const guid = id => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const charts = catalog.map(([id, title, chart], k) => {
  let songName = title, songType = 'Arcade';
  if (/ - SHORT CUT -$/.test(title)) { songType = 'ShortCut'; if (k % 2) songName = title.replace(/ - SHORT CUT -$/, ''); }
  if (/ - FULL SONG -$/.test(title)) { songType = 'FullSong'; if (k % 2) songName = title.replace(/ - FULL SONG -$/, ''); }
  if (k % 7 === 0) songName = songName.toUpperCase();
  return { id: guid(id), songName, songType, type: chart[0] === 'S' ? 'Single' : 'Double', level: +chart.slice(1), difficulty: chart };
});
charts.push({ id: guid(999999001), songName: 'Some Co-op Song', songType: 'Arcade', type: 'CoOp', level: 2, difficulty: 'CoOp x2' });
charts.push({ id: guid(999999002), songName: 'Not On ArcadeStat', songType: 'Arcade', type: 'Double', level: 21, difficulty: 'D21' });

const at = d => d.slice(0, 10) + 'T20:00:00+09:00';
const best = new Map();
for (const p of records) {
  const b = best.get(p.stepId), cand = { clear: p.isBreakOn, score: p.totalScore, date: p.date };
  if (!b || (cand.clear && !b.clear) || (cand.clear === b.clear && cand.score > b.score)) best.set(p.stepId, cand);
}
const scores = [...best].map(([id, b]) => ({ chartId: guid(id), recordedAt: at(b.date), score: b.score, isBroken: !b.clear, plate: null }));
scores.push({ chartId: guid(999999002), recordedAt: at('2026-10-01'), score: 990000, isBroken: false });
const journal = records.map(p => ({ occurredAt: at(p.date), chartId: guid(p.stepId), isBest: false, score: p.totalScore,
                                    isBroken: !p.isBreakOn, isStageBroken: false }));
journal.push({ occurredAt: at('2026-10-20'), chartId: guid(catalog.find(r => r[2] === 'D22')[0]), isBest: false,
               score: 1000000, isBroken: false, isStageBroken: true });   // must be ignored

let throttled = false, nonHttpsHits = 0;
function page(rows, url) {
  const limit = Math.min(500, +(url.searchParams.get('limit') || 100)), from = +(url.searchParams.get('cursor') || 0);
  const next = from + limit < rows.length ? new URL(url) : null;
  if (next) { next.protocol = 'http:'; next.searchParams.set('cursor', String(from + limit)); }
  return { data: rows.slice(from, from + limit), limit, next: next ? next.toString() : null };
}
async function apiRoute(route) {
  const req = route.request(), url = new URL(req.url());
  if (url.protocol !== 'https:') nonHttpsHits++;
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  if (req.headers()['authorization'] !== 'Basic ' + Buffer.from('skill-radar:' + TOKEN).toString('base64'))
    return route.fulfill({ status: 401, headers: cors, body: '{}' });
  const p = url.pathname.replace('/api/v2', '');
  if (p === '/players/me') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ username: 'testplayer', gameTag: 'TESTPLAYER#0001' }) });
  if (p === '/charts') {
    if (url.searchParams.get('cursor') && !throttled) { throttled = true; return route.fulfill({ status: 429, headers: { ...cors, 'retry-after': '1' }, body: '{}' }); }
    const types = (url.searchParams.get('type') || '').split(',');
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(page(charts.filter(c => !types[0] || types.includes(c.type)), url)) });
  }
  if (p === '/players/me/scores') {
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(page(scores, url)) });
  }
  if (p === '/players/me/journal') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(page(journal, url)) });
  return route.fulfill({ status: 404, headers: cors, body: '{}' });
}

// ---- static server ----
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
  await ctx.route(/piuscores\.arroweclip\.se/, apiRoute);
  const pg = await ctx.newPage();
  const errors = []; pg.on('pageerror', e => errors.push(e.message));
  await pg.goto(base);
  check(await pg.isVisible('#hero'), 'empty state shows the intro card');
  check(!(await pg.isVisible('#app')), 'radar hidden before any scores load');
  if (shots) await pg.screenshot({ path: path.join(shots, 'e2e-empty.png'), fullPage: true });

  await pg.fill('#token', 'wrong-token'); await pg.click('#load');
  await pg.waitForFunction(() => document.getElementById('status').classList.contains('err'));
  check(/did not accept/.test(await pg.textContent('#status')), 'a bad token shows the token error');

  await pg.fill('#token', TOKEN); await pg.check('#remember'); await pg.click('#load');
  await pg.waitForFunction(() => document.getElementById('status').classList.contains('ok'), null, { timeout: 30000 });
  const status = await pg.textContent('#status');
  check(/Loaded \d+ charts from PIU Scores for TESTPLAYER#0001/.test(status), 'status after load: ' + status);
  check(nonHttpsHits === 0, 'every API request stayed on https (next links rewritten)');
  check(throttled, 'a 429 was answered and retried');
  check(/1 played chart couldn.t be matched/.test(await pg.textContent('#unmatched')), 'the unknown chart is reported as unmatched');
  check(await pg.inputValue('#token') === '', 'token field cleared after loading');

  const got = await pg.evaluate(() => { const R = window.__skillRadar.result, o = {};
    for (const m in R) { o[m] = {}; for (const s in R[m].skills) o[m][s] = R[m].skills[s].level; } return o; });
  let maxd = 0; const bad = [];
  for (const m in expected) for (const s in expected[m]) {
    const a = expected[m][s], b = got[m][s];
    if ((a == null) !== (b == null)) bad.push(`${m} ${s}`); else if (a != null) maxd = Math.max(maxd, Math.abs(a - b));
  }
  check(bad.length === 0 && maxd < 1e-6, `levels match the Python reference (max diff ${maxd.toExponential(1)}${bad.length ? ', mismatched: ' + bad : ''})`);
  if (shots) await pg.screenshot({ path: path.join(shots, 'e2e-loaded.png'), fullPage: true });

  // ---- replay ----
  await pg.click('#replay-toggle');
  check(await pg.isVisible('#timeline'), 'replay panel opens');
  const replayBad = await pg.evaluate(() => {
    const S = window.__skillRadar, H = S.history, bad = [];
    H.dates.forEach((d, i) => {
      const v = S.replayValuesAt(Date.parse(d + 'T00:00:00Z'));
      for (const sk in v) { const a = v[sk].level, b = H.Double[sk][i];
        if ((a == null) !== (b == null) || (a != null && Math.abs(a - b) > 1e-9)) bad.push(d + ' ' + sk); }
    });
    return bad;
  });
  check(replayBad.length === 0, 'replay shows exactly the history values on every play day' + (replayBad.length ? ': ' + replayBad.slice(0, 5) : ''));
  const endMatches = await pg.evaluate(() => { const S = window.__skillRadar, R = S.result.Double.skills,
    v = S.replayValuesAt(S.replay.t); return Object.keys(R).every(k => (R[k].level == null) === (v[k].level == null) && (R[k].level == null || Math.abs(R[k].level - v[k].level) < 1e-9)); });
  check(endMatches, 'replay opens on the current radar');
  const between = await pg.evaluate(() => {
    const S = window.__skillRadar, H = S.history, t0 = Date.parse(H.dates[10] + 'T00:00:00Z'), t1 = Date.parse(H.dates[11] + 'T00:00:00Z');
    const mid = S.replayValuesAt((t0 + t1) / 2);
    return Object.keys(mid).every(k => { const a = H.Double[k][10], b = H.Double[k][11], m = mid[k].level;
      if (a == null || b == null) return true; return m >= Math.min(a, b) - 1e-9 && m <= Math.max(a, b) + 1e-9; });
  });
  check(between, 'in-between frames sit between the neighbouring days');
  await pg.focus('#timeline'); await pg.keyboard.press('Home');
  check(/Play day 1 of \d+/.test(await pg.textContent('#replay-day')), 'Home jumps to the first play day');
  await pg.keyboard.press('ArrowRight'); await pg.keyboard.press('ArrowRight');
  check(/Play day 3 of/.test(await pg.textContent('#replay-day')), 'arrow keys step between play days');
  const labelsOk = await pg.evaluate(() => {
    const S = window.__skillRadar, H = S.history, vals = [...document.querySelectorAll('#radar .ax-val')].map(t => t.textContent);
    const names = [...document.querySelectorAll('#radar .ax-name')].map(t => t.textContent);
    return names.every((n, i) => { const v = H.Double[n][2]; return v == null ? vals[i] === '—' : vals[i] === v.toFixed(1); });
  });
  check(labelsOk, 'radar labels show that day\u2019s levels');
  if (shots) await pg.screenshot({ path: path.join(shots, 'e2e-replay-day3.png'), fullPage: false });
  await pg.selectOption('#replay-speed', '4');
  const before = await pg.innerHTML('#radar');
  await pg.click('#replay-play');
  await pg.waitForTimeout(700);
  const midState = await pg.evaluate(() => window.__skillRadar.replay);
  const during = await pg.innerHTML('#radar');
  check(midState.playing && during !== before, 'Play animates the radar');
  if (shots) await pg.screenshot({ path: path.join(shots, 'e2e-replay-playing.png'), fullPage: false });
  await pg.waitForFunction(() => !window.__skillRadar.replay.playing, null, { timeout: 20000 });
  const lastDay = await pg.evaluate(() => { const H = window.__skillRadar.history; return H.dates.length; });
  check(new RegExp(`Play day ${lastDay} of ${lastDay}`).test(await pg.textContent('#replay-day')), 'playback stops on the last play day');
  await pg.click('#btn-single');
  check(/Play day/.test(await pg.textContent('#replay-day')), 'switching to Single keeps the replay working');
  await pg.click('#btn-double');
  await pg.click('#replay-toggle');
  check(!(await pg.isVisible('#timeline')), 'replay panel closes');

  await pg.reload();
  await pg.waitForSelector('#app:not(.app-hidden)');
  check(/Showing .* from PIU Scores/.test(await pg.textContent('#status')), 'scores reload from this device after a refresh');
  check(await pg.isVisible('text=Refresh from PIU Scores'), 'remembered token offers Refresh');
  await pg.click('text=Forget my token');
  check(!(await pg.isVisible('text=Refresh from PIU Scores')), 'Forget my token removes the Refresh button');
  await pg.click('text=Clear my scores');
  check(await pg.isVisible('#hero'), 'Clear my scores returns to the empty state');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
} finally {
  await browser.close(); server.close();
}
console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
