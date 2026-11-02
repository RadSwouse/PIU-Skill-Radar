// Reads an ArcadeStat HAR export (or a saved song/all or record/all JSON response).
// song/all carries the community tags and tier votes; record/all carries a player's plays.
import { TAGS } from '../engine.js';

function decodeBody(content) {
  if (!content || !content.text) return null;
  try {
    if (content.encoding === 'base64') {
      const bin = atob(content.text), bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return JSON.parse(content.text);
  } catch (e) { return null; }
}

export function compactSongs(list) {
  const out = [];
  for (const c of list) {
    const d = c.difficulty || '';
    if (!/^[SD]\d+$/.test(d)) continue;
    const idx = [], w = [];
    if (c.topTag) c.topTag.n.forEach((i, k) => { const v = c.topTag.v[k]; if (v > 0 && i < TAGS.length) { idx.push(i); w.push(v); } });
    out.push([c.stepId, c.titleEn || c.title, d, c.voteDifficulty == null ? null : c.voteDifficulty, c.deleted ? 1 : 0, idx, w]);
  }
  return out;
}

function compactPlays(list) {
  return list.filter(p => p.versionId === 8 || p.versionId == null)
    .map(p => [p.stepId, p.totalScore, p.isBreakOn ? 1 : 0, p.isUnknownScore ? 1 : 0, String(p.date || '').slice(0, 10)]);
}

// Returns { songs, plays, player } with whichever parts the file contained, or throws with a message.
export async function readArcadeStatFile(file) {
  let j;
  try { j = JSON.parse(await file.text()); } catch (e) { throw new Error('That file is not valid JSON or HAR.'); }
  let songs = null, plays = null, player = null, skippedP1 = false;
  const take = (url, req, body) => {
    if (!body) return;
    const v = req && req.versionId;
    if (/\/pump\/song\/all/.test(url) && Array.isArray(body.list)) { if (v == null || v === 8) songs = body.list; else skippedP1 = true; }
    if (/\/pump\/record\/all/.test(url) && Array.isArray(body.list)) { if (v == null || v === 8) plays = body.list; else skippedP1 = true; }
    if (/\/pump\/user\/me/.test(url) && body.user) player = body.user.nickname || body.user.piuNickname || null;
  };
  if (j && j.log && Array.isArray(j.log.entries)) {
    for (const e of j.log.entries) {
      let req = null; try { req = JSON.parse((e.request.postData && e.request.postData.text) || '{}'); } catch (x) {}
      take(e.request.url || '', req, decodeBody(e.response && e.response.content));
    }
  } else if (j && Array.isArray(j.list) && j.list.length) {
    if ('topTag' in j.list[0]) songs = j.list; else if ('totalScore' in j.list[0]) plays = j.list;
  }
  if (!songs && !plays) {
    throw new Error(skippedP1 ? 'That export is Phoenix 1 data. Switch ArcadeStat to Phoenix 2 and export again.'
                              : 'No ArcadeStat song/all or record/all response found in that file.');
  }
  return { songs: songs ? compactSongs(songs) : null, plays: plays ? compactPlays(plays) : null, player };
}
