#!/usr/bin/env python3
"""Refresh data/catalog.json from an ArcadeStat export.

Usage:  python3 tools/build_catalog.py <arcadestat.har | song_all.json> [--date YYYY-MM-DD]

Export a HAR from any arcadestat.app Pump It Up page while signed in (DevTools > Network > Fetch/XHR,
reload, then "Export HAR"). The file must include the POST /pump/song/all response for Phoenix 2
(versionId 8). Only Single and Double charts are kept.
"""
import base64, datetime, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'data', 'catalog.json')


def find_song_list(doc):
    if isinstance(doc, dict) and 'log' in doc:
        for e in doc['log']['entries']:
            if '/pump/song/all' not in e['request'].get('url', ''):
                continue
            try:
                req = json.loads((e['request'].get('postData') or {}).get('text') or '{}')
            except ValueError:
                req = {}
            if req.get('versionId', 8) != 8:
                continue
            c = e['response']['content']
            text = c.get('text') or ''
            if c.get('encoding') == 'base64':
                text = base64.b64decode(text).decode('utf-8')
            return json.loads(text)['list']
        raise SystemExit('No Phoenix 2 /pump/song/all response in that HAR.')
    if isinstance(doc, dict) and isinstance(doc.get('list'), list):
        return doc['list']
    raise SystemExit('Not an ArcadeStat HAR or song/all JSON file.')


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    songs = find_song_list(json.load(open(sys.argv[1], encoding='utf-8')))
    date = sys.argv[sys.argv.index('--date') + 1] if '--date' in sys.argv else datetime.date.today().isoformat()
    rows = []
    for c in songs:
        d = c.get('difficulty') or ''
        if not d or d[0] not in 'SD' or not d[1:].isdigit():
            continue
        pairs = [(i, round(v, 6)) for i, v in zip(c['topTag']['n'], c['topTag']['v']) if v > 0 and i < 30]
        vote = c.get('voteDifficulty')
        rows.append([c['stepId'], c.get('titleEn') or c.get('title'), d, None if vote is None else round(vote, 6),
                     1 if c.get('deleted') else 0, [a for a, _ in pairs], [b for _, b in pairs]])
    out = {'source': 'ArcadeStat (arcadestat.app) community tags and tier votes, Phoenix 2', 'exportedAt': date,
           'format': '[stepId, title, chart, tierVote, deleted, tagIndexes, tagWeights]', 'charts': rows}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Wrote {len(rows)} charts ({sum(1 for r in rows if r[5])} tagged) to data/catalog.json')


if __name__ == '__main__':
    main()
