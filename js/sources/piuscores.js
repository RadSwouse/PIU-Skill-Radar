// Reads a player's Phoenix 2 scores from the PIU Scores API (piuscores.arroweclip.se) with their
// personal API token, and matches PIU Scores charts to ArcadeStat charts by title, play style and level.
// The token is sent only to PIU Scores, in the Authorization header.

export const PIU_SCORES_API = 'https://piuscores.arroweclip.se/api/v2';
const MIX = 'Phoenix2';
const PAGE = 500;
const MAX_PAGES = 400;

export class PiuScoresError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function request(url, token) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: 'Basic ' + btoa('skill-radar:' + token.trim()), Accept: 'application/json' } });
    } catch (e) {
      throw new PiuScoresError('network', 'Could not reach PIU Scores. Check your connection and try again.');
    }
    if (res.status === 429 && attempt < 4) {
      const wait = Math.min(60, parseInt(res.headers.get('Retry-After') || '5', 10) || 5);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new PiuScoresError('auth', 'PIU Scores did not accept that token. Copy it again from your PIU Scores account page.');
    }
    if (!res.ok) {
      let detail = '';
      try { const p = await res.json(); detail = p.detail || p.title || ''; } catch (e) {}
      throw new PiuScoresError('http', `PIU Scores answered ${res.status}${detail ? ': ' + detail : ''}.`);
    }
    return res.json();
  }
}

// The API returns the next page as an absolute link; keep it on the API's own origin.
function sameOrigin(next) {
  const base = new URL(PIU_SCORES_API), u = new URL(next, base);
  return base.origin + u.pathname + u.search;
}

async function fetchAll(path, token, onPage) {
  let url = PIU_SCORES_API + path, rows = [], pages = 0;
  while (url && pages < MAX_PAGES) {
    const body = await request(url, token);
    rows = rows.concat(body.data || []);
    pages++;
    if (onPage) onPage(rows.length);
    url = body.next ? sameOrigin(body.next) : null;
  }
  return rows;
}

// Titles are compared without case, spacing or punctuation.
export const normTitle = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[\s\-_~!?.,:;'"‘’“”`()[\]{}<>/\\|☆★♥・·*#&+=]+/g, '');

const SUFFIX = { ShortCut: 'shortcut', FullSong: 'fullsong' };

export function matchCharts(piuCharts, catalogRows) {
  const index = new Map();
  for (const row of catalogRows) {
    const [id, title, chart] = row;
    const key = `${normTitle(title)}|${chart}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(id);
  }
  const map = new Map(), unmatched = new Map();
  for (const c of piuCharts) {
    const p = c.type === 'Single' ? 'S' : c.type === 'Double' ? 'D' : null;
    if (!p || c.level == null) continue;
    // A cut song whose name lacks its suffix tries the suffixed title first, so it never lands on
    // the arcade cut of the same song at the same level.
    const base = normTitle(c.songName), suf = SUFFIX[c.songType], lv = `|${p}${c.level}`, keys = [];
    if (suf && !base.endsWith(suf)) keys.push(base + suf + lv);
    keys.push(base + lv);
    if (suf && base.endsWith(suf)) keys.push(base.slice(0, -suf.length) + lv);
    let hit = null;
    for (const k of keys) { const ids = index.get(k); if (ids && ids.length === 1) { hit = ids[0]; break; } }
    if (hit != null) map.set(c.id, hit); else unmatched.set(c.id, `${c.songName} ${p}${c.level}`);
  }
  return { map, unmatched };
}

const day = iso => String(iso || '').slice(0, 10);

export async function importFromPiuScores(token, catalogRows, onProgress = () => {}) {
  if (!token || !token.trim()) throw new PiuScoresError('auth', 'Paste your PIU Scores API token first.');
  onProgress('Checking your token…');
  const me = await request(PIU_SCORES_API + '/players/me', token);
  onProgress('Reading the Phoenix 2 chart list…');
  const charts = await fetchAll(`/charts?mix=${MIX}&type=Single,Double&limit=${PAGE}`, token,
    n => onProgress(`Reading the Phoenix 2 chart list… ${n}`));
  onProgress('Reading your scores…');
  const scores = await fetchAll(`/players/me/scores?mix=${MIX}&limit=${PAGE}`, token,
    n => onProgress(`Reading your scores… ${n}`));
  onProgress('Reading your play history…');
  const journal = await fetchAll(`/players/me/journal?mix=${MIX}&limit=${PAGE}`, token,
    n => onProgress(`Reading your play history… ${n}`));

  const { map, unmatched } = matchCharts(charts, catalogRows);
  const plays = [], missed = new Map();
  const add = (chartId, score, broken, when) => {
    if (score == null) return;
    const id = map.get(chartId);
    if (id == null) { if (unmatched.has(chartId)) missed.set(chartId, unmatched.get(chartId)); return; }
    plays.push([id, score, broken ? 0 : 1, 0, day(when)]);
  };
  for (const s of scores) add(s.chartId, s.score, s.isBroken, s.recordedAt);
  for (const j of journal) if (!j.isStageBroken) add(j.chartId, j.score, j.isBroken, j.occurredAt);

  const playedCharts = new Set(scores.map(s => s.chartId));
  return {
    player: me.gameTag || me.username || 'You',
    plays,
    stats: { scores: scores.length, journal: journal.length,
             matched: [...playedCharts].filter(id => map.has(id)).length,
             unmatched: [...missed.values()].sort() },
  };
}
