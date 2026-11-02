// Skill Radar scoring engine. Pure functions, no DOM.
// A Python reference with the same rules lives in tools/engine_reference.py.

// ArcadeStat tag indexes, in the order of its tag filter list.
export const TAGS = ['Drill', 'Gimmick', 'Twist', 'Bracket', 'Side', 'Run', 'Stamina', 'Half', 'Crossover', 'Mash',
  'High-angle twist', 'Horizontal twist', 'Hold', 'No bar', 'Fast', 'Slow', 'Cheat', 'Jack', '3 beat', 'Stair',
  'Switch', 'Jump', 'Leg split', '12 beat', '24 beat', '32 beat', 'Double stairs', 'Gallop', 'Micro-desync', 'Spin'];

export const SPOKES = {
  Double: ['Run', 'Twist', 'Hi-Angle', 'Crossover', 'Half', 'Bracket', 'Drill', 'Stamina', 'Hold', 'Fast', 'Jack', 'Jump',
           'Stairs', 'Switch', 'Leg split', 'Side'],
  Single: ['Run', 'Twist', 'Hi-Angle', 'Side', 'Bracket', 'Drill', 'Stamina', 'Hold', 'Fast', 'Jack', 'Jump', 'Stairs'],
};
const SPOKE_TAG = { 'Hi-Angle': 'High-angle twist', 'Stairs': 'Stair' };
export const tagOf = sk => SPOKE_TAG[sk] || sk;

// Score -> level adjustment, anchored at SS (980,000) = 0. Linear between points.
export const GRADES = [[0, -2.6], [450000, -2.1], [750000, -1.6], [825000, -1.2], [900000, -0.9], [925000, -0.7],
  [950000, -0.5], [960000, -0.35], [970000, -0.2], [975000, -0.1], [980000, 0], [985000, 0.05], [990000, 0.10],
  [995000, 0.15], [1000000, 0.20]];
const CUTS = [[995000, 'SSS+'], [990000, 'SSS'], [985000, 'SS+'], [980000, 'SS'], [975000, 'S+'], [970000, 'S'],
  [960000, 'AAA+'], [950000, 'AAA'], [925000, 'AA+'], [900000, 'AA'], [825000, 'A+'], [750000, 'A'], [700000, 'B'],
  [600000, 'C'], [450000, 'D'], [0, 'F']];

export const BASE_DISCOUNT = 3.0;  // levels lost by a tech that is a trace of a chart
export const RARE_N = 50;          // techs tagged on fewer Lv18+ charts than this get a gentler discount
export const SLOTS = 10;           // the average fills 10 slots
export const SLOT_FROM = 22.0;     // each level above this adds a slot
export const MIN_CLEARS = 5;       // qualifying clears before a skill is shown
export const MAIN_SHARE = 0.25;    // a clear qualifies when the tech is at least this share of the top tag

export const grade = s => CUTS.find(([c]) => s >= c)[1];

export function scoreAdj(s) {
  for (let i = 0; i < GRADES.length - 1; i++) {
    const [s0, a0] = GRADES[i], [s1, a1] = GRADES[i + 1];
    if (s <= s1) return a0 + (a1 - a0) * (s - s0) / (s1 - s0);
  }
  return GRADES[GRADES.length - 1][1];
}

// compact rows: [stepId, title, chart, tierVote, deleted, tagIndexes, tagWeights]
export function buildCatalog(rows) {
  const cat = new Map();
  for (const [id, title, chart, vote, deleted, idx, w] of rows) {
    const level = parseInt(chart.slice(1), 10);
    const tags = {};
    idx.forEach((i, k) => { if (w[k] > 0 && i < TAGS.length) tags[TAGS[i]] = w[k]; });
    cat.set(id, { id, title, chart, mode: chart[0] === 'S' ? 'Single' : 'Double', level,
                  clevel: level + (vote || 0), tags, deleted: !!deleted });
  }
  return cat;
}

export function discounts(cat) {
  const out = {};
  for (const mode of Object.keys(SPOKES)) for (const sk of SPOKES[mode]) {
    const t = tagOf(sk); let n18 = 0;
    for (const c of cat.values()) if (c.mode === mode && !c.deleted && c.level >= 18 && t in c.tags) n18++;
    out[mode + '|' + sk] = { a: BASE_DISCOUNT * Math.min(1, n18 / RARE_N), rare: n18 < RARE_N, n18 };
  }
  return out;
}

// plays: [stepId, score, cleared(1/0), unknownScore(1/0), 'YYYY-MM-DD']
export function bestClears(plays) {
  const best = new Map();
  for (const [id, score, clear, unknown, date] of plays) {
    if (unknown || !clear || score == null) continue;
    const b = best.get(id);
    if (!b || score > b.score) best.set(id, { score, date });
  }
  return best;
}

export function compute(cat, plays, disc) {
  disc = disc || discounts(cat);
  const best = bestClears(plays), out = {};
  for (const mode of Object.keys(SPOKES)) {
    const clears = [];
    for (const [id, b] of best) { const c = cat.get(id); if (c && c.mode === mode) clears.push([c, b]); }
    out[mode] = { clears: clears.length, skills: {} };
    for (const sk of SPOKES[mode]) {
      const t = tagOf(sk), { a, rare, n18 } = disc[mode + '|' + sk], vals = [];
      for (const [c, b] of clears) {
        if (!(t in c.tags)) continue;
        const top = Math.max(...Object.values(c.tags)), r = c.tags[t] / top, adj = scoreAdj(b.score);
        vals.push({ id: c.id, chart: c.chart, title: c.title, score: b.score, grade: grade(b.score),
                    clevel: c.clevel, adj, share: r, value: c.clevel + adj - a * (1 - r) });
      }
      vals.sort((x, y) => y.value - x.value);
      const qualList = vals.filter(d => rare || d.share >= MAIN_SHARE - 1e-3), qual = qualList.length;
      let filled = 0, acc = 0; const used = [];
      for (const d of vals) {
        if (filled >= SLOTS) break;
        const w = Math.min(1 + Math.max(0, d.value - SLOT_FROM), SLOTS - filled);
        acc += d.value * w; filled += w; used.push(Object.assign({ slots: w }, d));
      }
      const raw = filled ? acc / filled : null;
      out[mode].skills[sk] = { level: qual >= MIN_CLEARS ? raw : null, raw, qualifying: qual, tagged: vals.length,
                               discount: a, rare, n18, used, rest: vals.slice(used.length), qualList };
    }
  }
  return out;
}

// Level of every skill at the end of each day that has plays.
export function buildHistory(cat, plays, disc) {
  disc = disc || discounts(cat);
  const dates = [...new Set(plays.map(p => p[4]))].filter(Boolean).sort();
  const out = { dates, Single: {}, Double: {} };
  for (const m of Object.keys(SPOKES)) for (const sk of SPOKES[m]) out[m][sk] = [];
  for (const date of dates) {
    const r = compute(cat, plays.filter(p => p[4] <= date), disc);
    for (const m of Object.keys(SPOKES)) for (const sk of SPOKES[m]) out[m][sk].push(r[m].skills[sk].level);
  }
  return out;
}
