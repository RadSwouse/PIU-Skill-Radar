# Skill Radar — Pump It Up Phoenix 2

A skill radar for Pump It Up Phoenix 2. Each technique (Run, Twist, Bracket, Drill, Half, …) gets a decimal
level, like **Lv.20.7**, based on the hardest charts with that tech you've cleared and how well you scored on
them. It also shows how each level changed over time, and **Watch radar progress over time** replays
the whole radar day by day: drag the timeline or press **Play replay** and the shape grows as your scores improve.

- **Doubles:** 16 techs: Run, Twist, Hi-Angle, Crossover, Half, Bracket, Drill, Stamina, Hold, Fast, Jack, Jump, Stairs, Switch, Leg split, Side
- **Singles:** 12 techs: Run, Twist, Hi-Angle, Side, Bracket, Drill, Stamina, Hold, Fast, Jack, Jump, Stairs

## Where the data comes from

| What | Source |
|---|---|
| Your scores and play history | [PIU Scores](https://piuscores.arroweclip.se) API, with your personal API token, or an ArcadeStat HAR export |
| Technique tags and tier votes | [ArcadeStat](https://arcadestat.app) community data, bundled in `data/catalog.json` |
| Extra technique tags | Added where voters left a tech out, bundled in `data/supplement.json` (see below) |

Your PIU Scores token goes only to `piuscores.arroweclip.se`, in the `Authorization` header. It is
saved in your browser only if you tick **Remember on this device**. Nothing is sent anywhere else; the
site is static and has no server of its own.

## How a level is calculated

1. **Chart level** = the chart's level + its ArcadeStat tier vote (Top ≈ +1.25 … Bottom ≈ −0.25).
2. **Score adjustment** = weighted around SS ±0 (SSS+ = +0.15 … A = −1.6). Scores between cutoffs are interpolated; 1,000,000 = +0.20.
3. **Side-tech discount**: value = level + adjustment − discount × (1 − share), where *share* is the tech's
   tag weight ÷ the chart's top tag weight. The discount is 3 levels, scaled down for rare techs:
   3 × (tagged charts at Lv18+ ÷ 50), capped at 3.
4. **Your level** = weighted average of your best values over 10 slots. A value above 22 fills
   1 + (value − 22) slots, so hard clears weigh more.
5. A skill appears once you have **5 qualifying clears**: charts where the tech is at least 25% of the
   top tag (any share for rare techs).

### Added tags

ArcadeStat lists at most five tags per chart, so some techs are under-tagged. `data/supplement.json`
fills those gaps, but only for techs a chart has no vote for; community votes always win.

- **Jack, Jump, Stairs, Switch, Hi-Angle**: the chart shows the matching PIU Scores (Arrow Eclipse) skill chip.
- **Side, Singles**: the chart is in the top 10% of its folder (same style, level ±1) for stances with the feet
  stacked on two vertical arrows.
- **Side, Doubles**: the chart is in the top 10% of its folder for *sustained same-facing travel*: sections of
  8+ steps where you stay turned the same way while moving across panels (crossovers, chained drills, stairs
  that carry across pads). Vertical drills, anchors and brackets keep you sideways without travelling, so they
  don't count, and stairs that stay on one pad count half.
- An added tag is always a minor tag: its share is the smaller of the tech's typical ArcadeStat share and the
  chart's weakest ArcadeStat tag. It counts as a qualifying clear, and rare-tech discounts are still counted from
  ArcadeStat votes only.

Only Phoenix 2 clears count. Stage breaks and unknown scores are ignored. The rules live in
`js/engine.js`, and `tools/engine_reference.py` is a Python copy that gives the same numbers.

## Project layout

```
index.html               page
css/style.css            styles (light and dark)
js/engine.js             scoring engine (no DOM)
js/app.js                radar, list, detail table, history chart, replay, data loading
js/sources/piuscores.js  PIU Scores API client + chart matching
js/sources/arcadestat.js ArcadeStat HAR / JSON reader
data/catalog.json        ArcadeStat tags + tier votes for every Phoenix 2 Single/Double chart
data/supplement.json     added technique tags (see "Added tags")
tools/build_catalog.py   rebuilds data/catalog.json from a fresh ArcadeStat export
tools/build_supplement.py  rebuilds data/supplement.json
tools/engine_reference.py  Python reference engine
tests/                   end-to-end test against a mock PIU Scores API
```

## Run it locally

ES modules need a web server (opening `index.html` from disk won't load them):

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, pick **Deploy from a branch**, then branch `main`, folder `/ (root)`.
3. The site goes live at `https://<your-username>.github.io/<repository>/`.

`.nojekyll` tells GitHub Pages to serve the files as they are.

## Update the chart tags

The community tags and tier votes change over time. To refresh them:

1. On arcadestat.app (Pump It Up, Phoenix 2), open DevTools → **Network** → **Fetch/XHR**, reload, then export a HAR.
2. Run `python3 tools/build_catalog.py path/to/export.har`.
3. Run `python3 tools/build_supplement.py data/catalog.json <piuscores-export.json> <stepfiles-dir>` to rebuild
   the added tags (the inputs are described at the top of the script).
4. Commit the new `data/catalog.json` and `data/supplement.json`.

Add `?dev` to the page URL for developer tools: a switch for the added tags, a dashed outline of the
ArcadeStat-only radar, the change per skill, and "added" markers in the chart table.

## Tests

`tests/e2e.mjs` serves the site, mocks the PIU Scores API with Playwright, loads a player's scores
through the token form, and checks every skill level against `tools/engine_reference.py`.

```
npm install playwright        # once
node tests/e2e.mjs <catalog.json> <record_all.json> <expected.json>
```

## Credits

- Technique tags and tier votes: the ArcadeStat community (arcadestat.app).
- Score import and skill data: PIU Scores by DrMurloc (piuscores.arroweclip.se), whose published step files
  (from piucenter) feed the Side analysis.
- Pump It Up is a trademark of Andamiro. This is an unofficial fan project.
