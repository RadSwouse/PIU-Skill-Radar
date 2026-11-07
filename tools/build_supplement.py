"""Builds data/supplement.json: technique tags added where ArcadeStat voters left a tech out.

    python3 tools/build_supplement.py data/catalog.json <piuscores-export.json> <stepfiles-dir> [-o data/supplement.json]

Inputs
  catalog.json          the site's ArcadeStat chart catalog (tags + tier votes).
  piuscores-export.json PIU Scores (Arrow Eclipse) Phoenix 2 data: {"charts": [...], "skills": [...]}, where charts are
                        the api/v2 /charts rows (id, songName, songType, type, level, difficulty) and skills the
                        /charts/skills rows (chartId, skills: [{name, fraction}]).
  stepfiles-dir         the step files PIU Scores publishes (github.com/DrMurloc/PiuScoresStepfiles, piucenter snapshot):
                        one JSON per chart with the arrows and the predicted foot for each.

Rules (a tag is only added when the chart has no ArcadeStat vote for that tech)
  Jack / Jump / Stair / Switch / High-angle twist: the chart shows the matching Arrow Eclipse skill chip. Chips are
      approximated from skill coverage: a chart needs coverage at or above its folder's bar (same style, level +-1), and
      footswitch chips need >= 5% repeated single-panel rows, bracket chips >= 3% bracket rows.
  Side, Singles: share of stances with the feet stacked (>= 89 deg) in the top 10% of its folder.
  Side, Doubles: same-facing travel. Facing is tracked step by step (enter at >= 80 deg, hold while >= 35 deg toward the
      same side, fully crossed steps keep it, forward dips of <= 2 steps between same-facing runs are ignored). A
      section counts when it is >= 8 steps, at least half its stances are >= 80 deg, it reaches >= 4 panels and earns
      >= 6 credit. Credit: 1 per single-panel step that is not a jack or a backwards (>= 150 deg) stance; stairs (>= 4
      alternating steps through consecutive panels) earn 0.5 when the section stays on one pad. Runs of >= 12 steps on
      <= 3 panels (vertical drills, anchors) end a section and earn nothing. Score = credit / steps; tagged when in the
      top 10% of Doubles charts within one level.
  Weight (share of the chart's top tag) = min(typical ArcadeStat share for that tech, the chart's weakest ArcadeStat
      share), so an added tag is always a minor one. Rarity discounts keep counting ArcadeStat votes only.
"""
import argparse, glob, json, math, os, re, statistics, unicodedata

UI = ['Drill', 'Gimmick', 'Twist', 'Bracket', 'Side', 'Run', 'Stamina', 'Half', 'Crossover', 'Mash',
      'High-angle twist', 'Horizontal twist', 'Hold', 'No bar', 'Fast', 'Slow', 'Cheat', 'Jack', '3 beat', 'Stair',
      'Switch', 'Jump', 'Leg split', '12 beat', '24 beat', '32 beat', 'Double stairs', 'Gallop', 'Micro-desync', 'Spin']
CHIPS = {'Jack': {'jack'}, 'Jump': {'jump', 'bracket_jump'}, 'Stair': {'5-stair', '10-stair'},
         'Switch': {'footswitch', 'hold_footswitch'}, 'High-angle twist': {'twist_over90'}}
BRACKETS = {'bracket', 'bracket_run', 'bracket_drill', 'bracket_jump', 'bracket_twist', 'staggered_bracket'}
LIMB = {'footswitch', 'hold_footswitch', 'hold_footslide'}
SP = [(-1, -1), (-1, 1), (0, 0), (1, 1), (1, -1)]
DP = [(-2.5, -1), (-2.5, 1), (-1.5, 0), (-0.5, 1), (-0.5, -1), (0.5, -1), (0.5, 1), (1.5, 0), (2.5, 1), (2.5, -1)]


def norm(s):
    s = unicodedata.normalize('NFKC', str(s or '')).lower()
    return re.sub(r"[\s\-_~!?.,:;'\"‘’“”`()\[\]{}<>/\\|☆★♥・·*#&+=]+", '', s)


# ---------- step files ----------
def read_rows(path):
    """-> (pad, rows) with rows = [(time, [(panel, limb)])] in time order; None if no arrows."""
    d = json.load(open(path, encoding='utf-8'))
    arrows = []
    for i in range(min(2, len(d))):
        for n in d[i]:
            if isinstance(n, list) and len(n) >= 3 and isinstance(n[-1], str) and n[-1]:
                arrows.append((int(n[0]), round(float(n[1]), 6), n[-1]))
    if not arrows:
        return None
    pad = DP if any(p > 4 for p, _, _ in arrows) else SP
    rows = {}
    for p, t, l in arrows:
        rows.setdefault(t, []).append((p, l))
    return pad, [(t, rows[t]) for t in sorted(rows)]


def row_shares(rows):
    br = rep = 0; prev = None
    for _, ns in rows:
        limbs = {}
        for p, l in ns:
            limbs.setdefault(l, set()).add(p)
        if any(len(v) >= 2 for v in limbs.values()):
            br += 1
        ps = sorted({p for p, _ in ns})
        if prev is not None and len(prev) == 1 and len(ps) == 1 and prev[0] == ps[0]:
            rep += 1
        prev = ps
    return br / len(rows), rep / len(rows)


def stances(pad, rows):
    """Yield (row, angle or None): angle of the left->right foot vector after each row (+90 = facing left)."""
    L = R = None
    for t, ns in rows:
        by = {}
        for p, l in ns:
            if 0 <= p < len(pad):
                by.setdefault(l[0].lower(), []).append(p)
        for k, ps in by.items():
            spot = (sum(pad[p][0] for p in ps) / len(ps), sum(pad[p][1] for p in ps) / len(ps))
            if k == 'l': L = spot
            else: R = spot
        yield (t, ns), (math.degrees(math.atan2(R[1] - L[1], R[0] - L[0])) if L and R and L != R else None)


def sideways_share(pad, rows):
    st = side = 0
    for _, th in stances(pad, rows):
        if th is not None:
            st += 1; side += abs(th) >= 89
    return side / max(1, st)


def doubles_side(pad, rows, enter=80, stay=35, N=8, M=6, P=4, static_k=12, static_p=3, full_share=0.5, gap=2):
    side = None; lab = []; one = []; back = []; full = []
    for (t, ns), th in stances(pad, rows):
        b = fs = False
        if th is not None:
            s = 'L' if th > 0 else 'R'; b = abs(th) >= 150; fs = abs(th) >= 80
            if abs(th) >= 170: pass
            elif side == s and abs(th) >= stay: pass
            elif abs(th) >= enter: side = s
            else: side = None
        lab.append(side); back.append(b); full.append(fs)
        ps = {p for p, _ in ns}; ft = {l[0].lower() for _, l in ns}
        one.append((next(iter(ps)), next(iter(ft))) if len(ps) == 1 and len(ft) == 1 else None)
    n = len(lab)
    i = 0
    while i < n:   # forward dips of <= gap steps between runs facing the same side
        if lab[i] is None and i > 0 and lab[i - 1]:
            j = i
            while j < n and lab[j] is None: j += 1
            if j < n and j - i <= gap and lab[j] == lab[i - 1]:
                for k in range(i, j): lab[k] = lab[i - 1]
            i = j
        else:
            i += 1
    cred = [0.0 if (o is None or back[i] or (i and one[i - 1] and one[i - 1][0] == o[0])) else 1.0
            for i, o in enumerate(one)]
    stair = [False] * n; i = 0
    while i < n:
        j = i
        while j + 1 < n and one[j] and one[j + 1] and one[j + 1][1] != one[j][1] and abs(one[j + 1][0] - one[j][0]) == 1 \
                and (j == i or one[j + 1][0] - one[j][0] == one[j][0] - one[j - 1][0]):
            j += 1
        if j - i + 1 >= 4:
            for k in range(i, j + 1): stair[k] = True
        i = max(j, i + 1)
    i = 0
    while i < n:   # long 2-panel drills end a section
        j = i
        while j + 1 < n and one[j] and one[j + 1] and one[j + 1][1] != one[j][1] and one[j + 1][0] != one[j][0] \
                and (j == i or one[j + 1][0] == one[j - 1][0]):
            j += 1
        if j - i + 1 > 8:
            for k in range(i, j + 1): lab[k] = None
        i = max(j, i + 1)
    i = 0
    while i < n:   # static stretches: >= static_k single steps on <= static_p panels
        if not one[i]:
            i += 1; continue
        j = i; used = set()
        while j < n and one[j] and len(used | {one[j][0]}) <= static_p:
            used.add(one[j][0]); j += 1
        if j - i >= static_k:
            for k in range(i, j): lab[k] = None
            i = j
        else:
            i += 1
    total = 0.0; cur = None; start = 0
    for i, s in enumerate(lab + [None]):
        if s != cur:
            if cur and i - start >= N:
                idx = range(start, i); panels = {one[k][0] for k in idx if one[k]}
                pads = {0 if p < 5 else 1 for p in panels}
                W = sum(cred[k] * (0.5 if stair[k] and len(pads) == 1 else 1.0) for k in idx)
                if len(panels) >= P and W >= M and sum(full[k] for k in idx) / (i - start) >= full_share:
                    total += W
            cur = s; start = i
    return total / max(1, n)


def link_stepfiles(charts, step_dir):
    """PIU Scores chart id -> (pad, rows). Same title/cut/style; same level, else one level apart."""
    idx = {}
    for f in glob.glob(os.path.join(step_dir, '*.json')):
        try:
            d = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(d, list):
            continue
        meta = [x for x in d if isinstance(x, dict)]
        if not meta:
            continue
        m = meta[0]; sl = m.get('sord_chartlevel') or ''
        if not re.fullmatch(r'[SD]\d+', sl):
            continue
        key = (norm(m.get('TITLE')), (m.get('SONGTYPE') or '').upper(), sl[0])
        idx.setdefault(key, []).append((int(sl[1:]), m['shortname'], f))
    out = {}
    for c in charts.values():
        L = idx.get((norm(c['songName']), (c['songType'] or '').upper(), c['type'][0]), [])
        hit = [x for x in L if x[0] == c['level']] or [x for x in L if abs(x[0] - c['level']) == 1]
        if len(hit) == 1:
            r = read_rows(hit[0][2])
            if r:
                out[c['id']] = r
    return out


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('catalog'); ap.add_argument('export'); ap.add_argument('stepfiles')
    ap.add_argument('-o', '--out', default='data/supplement.json')
    a = ap.parse_args()
    cat = json.load(open(a.catalog, encoding='utf-8'))['charts']
    asr = [dict(id=r[0], title=r[1], chart=r[2], tags={UI[i]: w for i, w in zip(r[5], r[6]) if w > 0}) for r in cat]
    exp = json.load(open(a.export, encoding='utf-8'))
    charts = {c['id']: c for c in exp['charts'] if c.get('type') in ('Single', 'Double')}
    prof = {p['chartId']: p for p in exp['skills']}
    cov = {cid: {s['name']: (s['fraction'] or 0.0) for s in prof[cid]['skills']} for cid in charts if cid in prof}

    # pair PIU Scores charts with ArcadeStat charts (normalized title + difficulty, unique matches only)
    by = {}
    for x in asr:
        by.setdefault(f"{norm(x['title'])}|{x['chart']}", []).append(x)
    pairs = []
    for c in charts.values():
        L = by.get(f"{norm(c['songName'])}|{c['difficulty']}")
        if c['id'] in prof and L and len(L) == 1:
            pairs.append((c, L[0]))

    steps = link_stepfiles(charts, a.stepfiles)
    shares = {cid: row_shares(r[1]) for cid, r in steps.items()}

    # Arrow Eclipse chips
    def folder(c):
        return [x for x in charts.values() if x['type'] == c['type'] and abs(x['level'] - c['level']) <= 1 and x['id'] in cov]
    bars = {}

    def bar(c, b):
        k = (c['type'], c['level'], b)
        if k not in bars:
            vals = sorted((cov[x['id']].get(b, 0.0) for x in folder(c)), reverse=True)
            p = sum(v > 0 for v in vals) / max(1, len(vals))
            if p == 0: bars[k] = None
            else:
                allowed = min(p, 0.10 / p)
                bars[k] = 1e-9 if allowed >= p else vals[max(1, int(round(allowed * len(vals)))) - 1]
        return bars[k]

    def vetoed(cid, b):
        s = shares.get(cid)
        if b in LIMB: return None if s is None else s[1] < 0.05
        if b in BRACKETS: return None if s is None else s[0] < 0.03
        return False

    def chips(c):
        out = set()
        for b, f in cov[c['id']].items():
            if f > 0 and not vetoed(c['id'], b):
                cut = bar(c, b)
                if cut is not None and f >= cut: out.add(b)
        return out

    # Side scores and folder cutoffs
    side_s = {c['id']: sideways_share(*steps[c['id']]) for c, _ in pairs if c['type'] == 'Single' and c['id'] in steps}
    side_d = {c['id']: doubles_side(*steps[c['id']]) for c, _ in pairs if c['type'] == 'Double' and c['id'] in steps}
    lvl = {c['id']: c['level'] for c, _ in pairs}

    def cutoff(scores, L):
        v = sorted(s for k, s in scores.items() if abs(lvl[k] - L) <= 1)
        return v[int(0.9 * len(v))] if v else math.inf

    shown = {c['id']: chips(c) for c, _ in pairs}

    def has(c, t):
        if t == 'Side':
            if c['type'] == 'Single':
                return c['id'] in side_s and side_s[c['id']] >= cutoff(side_s, c['level'])
            return side_d.get(c['id'], 0) > 0 and side_d[c['id']] >= cutoff(side_d, c['level'])
        return bool(CHIPS[t] & shown[c['id']])

    def share(x, t):
        return x['tags'].get(t, 0) / max(x['tags'].values()) if x['tags'] else 0

    techs = list(CHIPS) + ['Side']
    typ = {}
    for t in techs:   # typical ArcadeStat share where voters and the detector agree
        v = [share(x, t) for c, x in pairs if x['tags'] and share(x, t) > 0 and has(c, t)]
        typ[t] = statistics.median(v) if v else 0.3
    added = {}; counts = {}
    for c, x in pairs:
        for t in techs:
            if t in x['tags'] or not has(c, t):
                continue
            low = min(x['tags'].values()) / max(x['tags'].values()) if x['tags'] else 1.0
            added.setdefault(x['id'], []).append([t, round(min(typ[t], low), 4), 'steps' if t == 'Side' else 'ae'])
            counts[(c['type'], t)] = counts.get((c['type'], t), 0) + 1
    doc = {'source': 'Tags added where ArcadeStat voters have not tagged a tech: Jack/Jump/Stair/Switch/High-angle twist '
                     'from PIU Scores (Arrow Eclipse) skill chips; Side from step-pattern analysis of the chart (Singles: '
                     'sideways stance; Doubles: sustained same-facing travel). Weight = min(typical ArcadeStat weight, '
                     "the chart's weakest ArcadeStat tag share). Built by tools/build_supplement.py.",
           'format': '{stepId: [[tag, share, source]]}; source ae = Arrow Eclipse chip, steps = step analysis',
           'charts': {str(k): v for k, v in sorted(added.items())}}
    json.dump(doc, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f"{len(pairs)} charts paired, {len(steps)} with step files; tags added on {len(added)} charts")
    for (ty, t), n in sorted(counts.items()):
        print(f"  {ty:6} {t:17} {n}")
    print('typical shares:', {t: round(v, 2) for t, v in typ.items()})


if __name__ == '__main__':
    main()
