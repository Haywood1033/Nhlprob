// lib/nhl.js — the NHL's public web API (api-web.nhle.com): the day's schedule, the day's scores
// with every goal in order (scorer, period, time, empty-net), and each game's box score (skater
// shots, goals, ice time; goalie shots faced, saves, who started). Undocumented, so every field is
// read defensively and older field names are accepted alongside current ones.

const { fetchJson, TTL } = require('./http');

const BASE = process.env.NHL_API_BASE || 'https://api-web.nhle.com/v1';
const URLS = {
  schedule: date => `${BASE}/schedule/${date}`,
  score: date => `${BASE}/score/${date}`,
  boxscore: id => `${BASE}/gamecenter/${id}/boxscore`,
  gameLog: (id, season, type = 2) => `${BASE}/player/${id}/game-log/${season}/${type}`,
};

const txt = v => (v && typeof v === 'object' ? v.default ?? Object.values(v)[0] ?? null : v ?? null);
// "18:42" → 18.7 minutes; "--" or missing → 0.
const minutes = s => { const m = String(s || '').match(/^(\d+):(\d\d)$/); return m ? Number(m[1]) + Number(m[2]) / 60 : 0; };
const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// FUT / PRE → pre; LIVE / CRIT → in; FINAL / OFF → post.
function stateOf(gameState) {
  const s = String(gameState || '').toUpperCase();
  if (s === 'LIVE' || s === 'CRIT') return 'in';
  if (s === 'FINAL' || s === 'OFF') return 'post';
  return 'pre';
}

function team(t = {}) {
  const abbrev = txt(t.abbrev) || null;
  const place = txt(t.placeName) || txt(t.placeNameWithPreposition) || null, common = txt(t.commonName) || txt(t.name) || null;
  return { id: num(t.id), abbrev, name: place && common ? `${place} ${common}` : common || place || abbrev, short: common || abbrev, score: num(t.score), sog: num(t.sog) };
}

function gameHead(g) {
  return {
    id: String(g.id), season: num(g.season), gameType: num(g.gameType) ?? 2, start: g.startTimeUTC || null,
    state: stateOf(g.gameState), gameState: g.gameState || null, venue: txt(g.venue),
    away: team(g.awayTeam), home: team(g.homeTeam),
    period: num(g.periodDescriptor?.number ?? g.period), periodType: g.periodDescriptor?.periodType || null,
    clock: g.clock?.timeRemaining || null, intermission: !!g.clock?.inIntermission,
    outcome: g.gameOutcome?.lastPeriodType || null, // REG | OT | SO
  };
}

// The day's games (schedule's gameWeek holds seven days; keep the one asked for).
async function fetchSchedule(date, { live = false } = {}) {
  const raw = await fetchJson(URLS.schedule(date), { ttlMs: live ? 60 * 1000 : TTL.short, timeoutMs: 12000 });
  const day = (raw.gameWeek || []).find(d => d.date === date);
  const games = day ? day.games || [] : (raw.games || []);
  return games.map(gameHead).filter(g => g.gameType === 2 || g.gameType === 3);
}

// Goals in the order they were scored. Shootout "goals" are excluded: they aren't goals for
// scorer markets. teamAbbrev is a string or { default }.
function parseGoals(g) {
  return (g.goals || []).map(x => {
    const pType = x.periodDescriptor?.periodType || (Number(x.period) > 3 ? 'OT' : 'REG');
    return {
      period: num(x.periodDescriptor?.number ?? x.period), periodType: pType, time: minutes(x.timeInPeriod),
      playerId: num(x.playerId), name: txt(x.name) || [txt(x.firstName), txt(x.lastName)].filter(Boolean).join(' ') || null,
      team: txt(x.teamAbbrev), strength: String(x.strength || '').toLowerCase() || null,
      emptyNet: /empty/i.test(x.goalModifier || '') || x.emptyNet === true,
    };
  }).filter(x => x.periodType !== 'SO' && x.playerId);
}

// Scores and goals for every game on a date (one request covers the whole day).
async function fetchScores(date, { live = false } = {}) {
  const raw = await fetchJson(URLS.score(date), { ttlMs: live ? 30 * 1000 : TTL.short, timeoutMs: 12000 });
  return (raw.games || []).map(g => ({ ...gameHead(g), goals: parseGoals(g) })).filter(g => g.gameType === 2 || g.gameType === 3);
}

function skater(p, teamAbbrev) {
  return {
    id: num(p.playerId), name: txt(p.name) || [txt(p.firstName), txt(p.lastName)].filter(Boolean).join(' '), team: teamAbbrev,
    pos: String(p.position || p.positionCode || '').toUpperCase().slice(0, 1) || 'F',
    toi: +minutes(p.toi).toFixed(2), shots: num(p.sog ?? p.shots) ?? 0, goals: num(p.goals) ?? 0, assists: num(p.assists) ?? 0, ppg: num(p.powerPlayGoals) ?? 0,
  };
}
function goalie(p, teamAbbrev) {
  let sa = num(p.shotsAgainst), sv = num(p.saves);
  const pair = String(p.saveShotsAgainst || '').match(/(\d+)\/(\d+)/); // older format "25/27"
  if ((sa === null || sv === null) && pair) { sv = Number(pair[1]); sa = Number(pair[2]); }
  return {
    id: num(p.playerId), name: txt(p.name) || [txt(p.firstName), txt(p.lastName)].filter(Boolean).join(' '), team: teamAbbrev,
    toi: +minutes(p.toi).toFixed(2), shotsAgainst: sa ?? 0, saves: sv ?? 0, goalsAgainst: num(p.goalsAgainst) ?? Math.max(0, (sa ?? 0) - (sv ?? 0)),
    starter: p.starter === true, decision: p.decision || null,
  };
}

// Per-player lines from a box score.
async function fetchBoxscore(id, { live = false } = {}) {
  const raw = await fetchJson(URLS.boxscore(id), { ttlMs: live ? 30 * 1000 : TTL.long, timeoutMs: 12000 });
  const head = gameHead(raw);
  const side = (k, abbrev) => {
    const t = raw.playerByGameStats?.[k] || {};
    const sk = [...(t.forwards || []), ...(t.defense || [])].map(p => skater(p, abbrev)).filter(p => p.id);
    const gs = (t.goalies || []).map(p => goalie(p, abbrev)).filter(p => p.id);
    // Older box scores don't flag the starter: the goalie with the most ice time started.
    if (gs.length && !gs.some(g => g.starter)) gs.reduce((a, b) => (b.toi > a.toi ? b : a)).starter = true;
    return { skaters: sk, goalies: gs };
  };
  return { ...head, players: { away: side('awayTeam', head.away.abbrev), home: side('homeTeam', head.home.abbrev) } };
}

async function fetchGameLog(playerId, season, type = 2) {
  const raw = await fetchJson(URLS.gameLog(playerId, season, type), { ttlMs: TTL.short, timeoutMs: 10000 });
  return (raw.gameLog || []).map(g => ({ gameId: String(g.gameId), date: g.gameDate, opp: txt(g.opponentAbbrev), home: g.homeRoadFlag === 'H', goals: num(g.goals) ?? 0, shots: num(g.shots) ?? 0, toi: minutes(g.toi), assists: num(g.assists) ?? 0 }));
}

// Season id for a date: 20252026 runs from September 2025 through August 2026.
function seasonFor(date) { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); const s = m >= 9 ? y : y - 1; return Number(`${s}${s + 1}`); }

module.exports = { BASE, URLS, fetchSchedule, fetchScores, fetchBoxscore, fetchGameLog, parseGoals, gameHead, stateOf, minutes, seasonFor, txt };
