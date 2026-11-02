"""Skill Radar v1 — reference engine (Phoenix 2, Singles/Doubles, clears only).

chart level   = level + community tier vote (vote missing -> level)
score adj     = piecewise-linear table anchored at SS (980,000) = 0
share r       = tech weight / chart's top tag weight (0..1]
discount a_t  = 3.0 * min(1, n18_t / 50)   (n18_t = tagged charts at Lv18+ in the catalog)
chart value   = chart level + score adj - a_t * (1 - r)
spoke         = slot-weighted mean of best values: 10 slots, a value v fills 1 + max(0, v - 22) slots
shown if      = >= 5 qualifying clears (share >= 0.25; rare techs: any share)
"""
import json

UI = ['Drill', 'Gimmick', 'Twist', 'Bracket', 'Side', 'Run', 'Stamina', 'Half', 'Crossover', 'Mash',
      'High-angle twist', 'Horizontal twist', 'Hold', 'No bar', 'Fast', 'Slow', 'Cheat', 'Jack', '3 beat',
      'Stair', 'Switch', 'Jump', 'Leg split', '12 beat', '24 beat', '32 beat', 'Double stairs', 'Gallop',
      'Micro-desync', 'Spin']
SPOKES = {
    'Double': ['Run', 'Twist', 'Hi-Angle', 'Crossover', 'Half', 'Bracket', 'Drill', 'Stamina',
               'Hold', 'Fast', 'Jack', 'Jump', 'Stairs', 'Switch', 'Leg split', 'Side'],
    'Single': ['Run', 'Twist', 'Hi-Angle', 'Side', 'Bracket', 'Drill', 'Stamina', 'Hold',
               'Fast', 'Jack', 'Jump', 'Stairs'],
}
SPOKE_TAG = {'Hi-Angle': 'High-angle twist', 'Stairs': 'Stair'}
GRADES = [(1_000_000, 0.20), (995_000, 0.15), (990_000, 0.10), (985_000, 0.05), (980_000, 0.0),
          (975_000, -0.10), (970_000, -0.20), (960_000, -0.35), (950_000, -0.50), (925_000, -0.70),
          (900_000, -0.90), (825_000, -1.20), (750_000, -1.60), (450_000, -2.10), (0, -2.60)]
CUTS = [(995_000, 'SSS+'), (990_000, 'SSS'), (985_000, 'SS+'), (980_000, 'SS'), (975_000, 'S+'),
        (970_000, 'S'), (960_000, 'AAA+'), (950_000, 'AAA'), (925_000, 'AA+'), (900_000, 'AA'),
        (825_000, 'A+'), (750_000, 'A'), (700_000, 'B'), (600_000, 'C'), (450_000, 'D'), (0, 'F')]
BASE_DISCOUNT, RARE_N, SLOTS, SLOT_FROM, MIN_CLEARS, MAIN_SHARE = 3.0, 50, 10, 22.0, 5, 0.25


def grade(score):
    return next(g for c, g in CUTS if score >= c)


def score_adj(s):
    pts = sorted(GRADES)
    for (s0, a0), (s1, a1) in zip(pts, pts[1:]):
        if s <= s1:
            return a0 + (a1 - a0) * (s - s0) / (s1 - s0)
    return pts[-1][1]


def build_catalog(song_all):
    cat = {}
    for c in song_all:
        d = c['difficulty']
        if d[0] not in 'SD' or not d[1:].isdigit():
            continue
        tags = {UI[i]: v for i, v in zip(c['topTag']['n'], c['topTag']['v']) if v > 0 and i < len(UI)}
        lvl = int(d[1:])
        cat[c['stepId']] = dict(id=c['stepId'], title=c['titleEn'] or c['title'], chart=d,
                                mode='Single' if d[0] == 'S' else 'Double', level=lvl,
                                clevel=lvl + (c['voteDifficulty'] or 0.0), tags=tags,
                                deleted=bool(c['deleted']))
    return cat


def discounts(cat):
    out = {}
    for mode, spokes in SPOKES.items():
        for sk in spokes:
            t = SPOKE_TAG.get(sk, sk)
            n18 = sum(1 for c in cat.values() if c['mode'] == mode and not c['deleted']
                      and c['level'] >= 18 and t in c['tags'])
            out[(mode, sk)] = (BASE_DISCOUNT * min(1.0, n18 / RARE_N), n18 < RARE_N, n18)
    return out


def best_clears(records):
    best = {}
    for p in records:
        if p.get('isUnknownScore') or not p.get('isBreakOn'):
            continue
        k = p['stepId']
        if k not in best or p['totalScore'] > best[k]['score']:
            best[k] = dict(score=p['totalScore'], date=p['date'][:10])
    return best


def compute(cat, records):
    disc = discounts(cat)
    best = best_clears(records)
    out = {}
    for mode, spokes in SPOKES.items():
        clears = [(cat[k], b) for k, b in best.items() if k in cat and cat[k]['mode'] == mode]
        out[mode] = {}
        for sk in spokes:
            t = SPOKE_TAG.get(sk, sk)
            a, rare, n18 = disc[(mode, sk)]
            vals = []
            for c, b in clears:
                if t not in c['tags']:
                    continue
                r = c['tags'][t] / max(c['tags'].values())
                adj = score_adj(b['score'])
                vals.append(dict(id=c['id'], chart=c['chart'], title=c['title'], score=b['score'],
                                 grade=grade(b['score']), clevel=c['clevel'], adj=adj, share=r,
                                 value=c['clevel'] + adj - a * (1 - r)))
            vals.sort(key=lambda d: -d['value'])
            qual = sum(1 for d in vals if rare or d['share'] >= MAIN_SHARE - 1e-3)
            used, filled, acc = [], 0.0, 0.0
            for d in vals:
                if filled >= SLOTS:
                    break
                w = min(1 + max(0.0, d['value'] - SLOT_FROM), SLOTS - filled)
                acc += d['value'] * w
                filled += w
                used.append(dict(d, slots=w))
            level = acc / filled if filled else None
            out[mode][sk] = dict(level=level if qual >= MIN_CLEARS else None, raw=level, qualifying=qual,
                                 tagged=len(vals), discount=a, rare=rare, used=used)
    return out


if __name__ == '__main__':
    # python3 tools/engine_reference.py data/catalog.json <arcadestat record/all JSON>
    import sys
    rows = json.load(open(sys.argv[1], encoding='utf-8'))['charts']
    cat = {r[0]: dict(id=r[0], title=r[1], chart=r[2], mode='Single' if r[2][0] == 'S' else 'Double', level=int(r[2][1:]),
                      clevel=int(r[2][1:]) + (r[3] or 0.0), tags={UI[i]: v for i, v in zip(r[5], r[6])}, deleted=bool(r[4]))
           for r in rows}
    rec = json.load(open(sys.argv[2], encoding='utf-8'))['list']
    for mode, d in compute(cat, rec).items():
        print(mode)
        for sk, v in sorted(d.items(), key=lambda kv: -(kv[1]['level'] or 0)):
            print(f"  {sk:10} {'hidden' if v['level'] is None else 'Lv.%.2f' % v['level']:>9}  ({v['qualifying']} qualifying)")
