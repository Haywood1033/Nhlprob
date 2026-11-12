// lib/props.js — DraftKings' player-prop lines, from ESPN's public odds feed (no key, no account).
// Read ONLY as prices to compare against: they never feed the simulation, a lean or a pick. They
// fill the price boxes (a price the reader types still wins), rank Model picks by value, and are
// saved with the pre-game snapshot so the Accuracy tab can grade our numbers against the book's.
//
//   Anytime Goalscorer / First Goalscorer / To Score 2+ Goals   one price per player
//   Total Shots on Goal / Total Saves                            a line with two prices
//
// The feed doesn't label over and under: the pair for one player and line lists the over first
// (checked on points, shots and saves: depth players' overs at plus money first, unders at heavy
// minus second). A group that isn't exactly one pair is skipped rather than guessed. The Accuracy
// tab grades the book's over side too, so a flipped order would show up as a book worse than chance.
//
// Requests: the scoreboard (shared with lib/market, cached 10 min), one prop list per game (10 min),
// and each team's roster for names (6 hours). Only games not yet started are fetched: a started
// game keeps the pre-game lines saved in its snapshot.

const { fetchJson, mapLimit } = require('./http');
const { SB, nhlAbbr } = require('./market');
const { toDecimal } = require('./book');
const { buildMatcher, AMBIGUOUS } = require('./names');

const CORE = 'https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl';
const ROSTER = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams';
const DK = '100', PROVIDER = 'DraftKings';
const https = u => String(u || '').replace(/^http:/, 'https:');
const TEN_MIN = 10 * 60 * 1000, SIX_H = 6 * 3600 * 1000;
const ONE_SIDED = { 'Anytime Goalscorer': 'goal', 'First Goalscorer': 'first', 'To Score 2+ Goals': 'goal2' };
const PAIRED = { 'Total Shots on Goal': 'sog', 'Total Saves': 'saves' };
const athleteId = ref => (String(ref || '').match(/athletes\/(\d+)/) || [])[1] || null;

// ESPN athlete id → name, from a team roster (grouped by position or flat; both handled).
async function rosterNames(teamId) {
  const raw = await fetchJson(`${ROSTER}/${teamId}/roster`, { ttlMs: SIX_H, timeoutMs: 8000, retries: 0 }).catch(() => null);
  const out = new Map();
  const walk = x => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.id && (x.fullName || x.displayName)) out.set(String(x.id), { name: x.fullName || x.displayName, first: x.firstName || null, last: x.lastName || null });
    for (const k of ['athletes', 'items', 'entries']) if (x[k]) walk(x[k]);
  };
  walk(raw?.athletes || []);
  return out;
}

// One game's lines, matched to our players. g: a slate game view (players, goalies, home, away).
function matchLines(items, names, g) {
  const skaters = g.players.map(p => ({ name: p.name, id: p.id, team: p.team, pos: p.pos }));
  const goalies = ['home', 'away'].filter(k => g.goalies[k]).map(k => ({ name: g.goalies[k].name, id: g.goalies[k].id, team: g.goalies[k].team, pos: 'G', side: k }));
  const mS = buildMatcher(skaters), mG = buildMatcher(goalies);
  const find = (m, a) => {
    if (!a) return null;
    for (const n of [a.name, a.first && a.last ? `${a.first[0]}. ${a.last}` : null, a.name && a.name.split(' ').length > 1 ? `${a.name[0]}. ${a.name.split(' ').slice(1).join(' ')}` : null]) {
      if (!n) continue;
      const hit = m(n);
      if (hit && hit !== AMBIGUOUS) return hit;
    }
    return null;
  };
  const rows = [], pairs = new Map();
  let unmatched = 0;
  for (const it of items) {
    const type = it.type?.name, dec = toDecimal(it.odds?.american?.value), raw = it.odds?.american?.value;
    if (!dec || !(ONE_SIDED[type] || PAIRED[type])) continue;
    const a = names.get(athleteId(it.athlete?.$ref));
    if (ONE_SIDED[type]) {
      const p = find(mS, a); if (!p) { unmatched++; continue; }
      rows.push({ game: g.id, market: ONE_SIDED[type], player: p.id, dec, raw });
    } else {
      const line = Number(it.current?.target?.value ?? it.odds?.total?.value);
      if (!Number.isFinite(line)) continue;
      const key = `${type}|${athleteId(it.athlete?.$ref)}|${line}`;
      if (!pairs.has(key)) pairs.set(key, { type, a, line, legs: [] });
      pairs.get(key).legs.push({ dec, raw });
    }
  }
  for (const { type, a, line, legs } of pairs.values()) {
    if (legs.length !== 2) continue; // can't tell over from under: skip, never guess
    const sides = [['over', legs[0]], ['under', legs[1]]];
    if (PAIRED[type] === 'sog') {
      const p = find(mS, a); if (!p) { unmatched++; continue; }
      for (const [side, l] of sides) rows.push({ game: g.id, market: 'sog', player: p.id, side, line, dec: l.dec, raw: l.raw });
    } else {
      const G = find(mG, a); if (!G) { unmatched++; continue; } // not our projected starter
      for (const [side, l] of sides) rows.push({ game: g.id, market: 'saves', team: G.side, side, line, dec: l.dec, raw: l.raw });
    }
  }
  return { rows, unmatched };
}

// games: slate views. → Map(gameId → { provider, fetchedAt, rows, unmatched }) for pre-game games
// ESPN has DraftKings props for. Never throws: no lines is just an empty map.
async function fetchProps(date, games) {
  try {
    const pre = games.filter(g => !g.unavailable && g.state === 'pre');
    if (!pre.length) return new Map();
    const sb = await fetchJson(`${SB}?dates=${date.replace(/-/g, '')}`, { ttlMs: TEN_MIN, timeoutMs: 10000, retries: 0 });
    const byTeams = new Map();
    for (const ev of sb.events || []) {
      const c = ev.competitions?.[0]; if (!c) continue;
      const h = c.competitors?.find(x => x.homeAway === 'home'), a = c.competitors?.find(x => x.homeAway === 'away');
      if (h && a) byTeams.set(`${nhlAbbr(a.team?.abbreviation)}@${nhlAbbr(h.team?.abbreviation)}`, { ev: ev.id, comp: c.id || ev.id, teams: [h.team?.id, a.team?.id] });
    }
    const out = new Map();
    await mapLimit(pre, 3, async g => {
      const e = byTeams.get(`${g.away.abbrev}@${g.home.abbrev}`); if (!e) return;
      const pb = await fetchJson(`${CORE}/events/${e.ev}/competitions/${e.comp}/odds/${DK}/propBets?limit=1000`, { ttlMs: TEN_MIN, timeoutMs: 12000, retries: 0 }).catch(() => null);
      const items = pb?.items || []; if (!items.length) return;
      const names = new Map();
      for (const t of e.teams.filter(Boolean)) for (const [k, v] of await rosterNames(t)) names.set(k, v);
      const { rows, unmatched } = matchLines(items, names, g);
      if (rows.length) out.set(g.id, { provider: PROVIDER, fetchedAt: new Date().toISOString(), rows, unmatched });
    });
    return out;
  } catch { return new Map(); }
}

module.exports = { fetchProps, matchLines, PROVIDER };
