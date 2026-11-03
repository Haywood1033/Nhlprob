// lib/slate.js — one day's slate: every game with both lineups (who dressed last game), the
// projected or confirmed starting goalies, team and player state as of that morning, the
// simulation, and every number the tabs show — moneyline, puck line, totals and their leans,
// each skater's anytime / 2+ / first goal and shots, each starter's saves. Cached per date so
// every product prices from the same simulated games.

const { fetchSchedule, fetchScores, fetchBoxscore } = require('./nhl');
const { loadHistory, saveSnapshotsSafely, etDate } = require('./store');
const { prepare, leagueAt, sideFor } = require('./ratings');
const { simulateGame, summarizeGame, summarizePlayer, summarizeSaves } = require('./simulator');
const { mapLimit } = require('./http');
const { hashSeed } = require('./rng');

const SIMS = Number(process.env.NHL_SIMS || 15000), CACHE_MS = 5 * 60 * 1000, LIVE_CACHE_MS = 45 * 1000;
const cache = new Map();
const american = p => (!p || p <= 0 || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);

// Simulator input for one side.
function simSide(side, opp, lg, home) {
  const L = lg.sogPerTeam, edge = home ? lg.homeShotEdge : 1 / lg.homeShotEdge;
  return {
    rate: L * (side.team.sfPerGame / L) * (opp.team.saPerGame / L) * edge,
    skaters: side.skaters.map(p => ({ id: p.id, w: Math.max(0.05, p.expShots), sh: p.shPct, toi: p.toi })),
    goalie: side.goalie ? { id: side.goalie.id, sv: side.goalie.svPct } : null,
  };
}

// Leans with no prices: the side the model makes more likely, at the standard line nearest the
// model's own number (books hang 5.5 or 6.5 totals; ±1.5 puck lines).
function leansFor(s, home, away) {
  const fav = s.pHome >= 0.5 ? { side: 'home', team: home, p: s.pHome } : { side: 'away', team: away, p: s.pAway };
  const line = Math.abs(s.total.mean - 5.5) <= Math.abs(s.total.mean - 6.5) ? 5.5 : 6.5;
  const pOver = s.total.over[line];
  const favPl = fav.side === 'home' ? s.puckLine.homeMinus : s.puckLine.awayMinus;
  return {
    moneyline: { side: fav.side, team: fav.team, prob: fav.p, fair: american(fav.p) },
    total: { line, side: pOver >= 0.5 ? 'over' : 'under', prob: Math.max(pOver, 1 - pOver), fair: american(Math.max(pOver, 1 - pOver)), mean: s.total.mean },
    puckLine: { side: fav.side, team: fav.team, line: -1.5, prob: favPl, fair: american(favPl) },
    firstToScore: s.firstTeam.home >= s.firstTeam.away ? { side: 'home', team: home, prob: s.firstTeam.home } : { side: 'away', team: away, prob: s.firstTeam.away },
  };
}

// Starters and lineups from the box score once a game is under way.
async function confirmedFor(g) {
  if (g.state === 'pre') return null;
  try {
    const box = await fetchBoxscore(g.id, { live: g.state === 'in' });
    const pick = side => ({ starter: box.players[side].goalies.find(x => x.starter)?.id || null, skaters: box.players[side].skaters.map(p => p.id) });
    return { home: pick('home'), away: pick('away'), box };
  } catch { return null; }
}

function playerView(p, sim, idx, teamAbbrev, oppAbbrev, oppGoalie) {
  const s = summarizePlayer(sim, idx);
  return {
    id: p.id, name: p.name, team: teamAbbrev, opp: oppAbbrev, pos: p.pos, idx,
    toi: +p.toi.toFixed(1), shots60: +p.shots60.toFixed(2), shPct: +p.shPct.toFixed(4), expShots: +p.expShots.toFixed(2), games: p.games,
    season: p.season, last10: p.last10, oppGoalie: oppGoalie ? { id: oppGoalie.id, name: oppGoalie.name, svPct: +oppGoalie.svPct.toFixed(4) } : null,
    ...s, fair: { anytime: american(s.anytime), first: american(s.first) },
  };
}

async function buildSlate({ date = etDate() } = {}) {
  const [sched, scores] = await Promise.all([fetchSchedule(date), fetchScores(date).catch(() => [])]);
  const byId = new Map(scores.map(g => [g.id, g]));
  const games = sched.map(g => ({ ...g, ...(byId.get(g.id) ? { state: byId.get(g.id).state, period: byId.get(g.id).period, clock: byId.get(g.id).clock, intermission: byId.get(g.id).intermission, outcome: byId.get(g.id).outcome, home: { ...g.home, score: byId.get(g.id).home.score, sog: byId.get(g.id).home.sog }, away: { ...g.away, score: byId.get(g.id).away.score, sog: byId.get(g.id).away.sog }, goals: byId.get(g.id).goals } : { goals: [] }) }));
  const hist = await loadHistory({ before: date });
  const prep = prepare(hist.games), lg = leagueAt(prep, date);
  const confirmed = await mapLimit(games, 6, confirmedFor);

  const out = [], snaps = [];
  games.forEach((g, gi) => {
    const conf = confirmed[gi];
    const H = sideFor(prep, g.home.abbrev, g.away.abbrev, date, lg, { starterId: conf?.home.starter });
    const A = sideFor(prep, g.away.abbrev, g.home.abbrev, date, lg, { starterId: conf?.away.starter });
    if (!H.skaters.length || !A.skaters.length) { out.push({ id: g.id, start: g.start, state: g.state, home: g.home, away: g.away, unavailable: 'Not enough history for one of these teams yet.' }); return; }
    const input = { id: g.id, playoff: g.gameType === 3, home: simSide(H, A, lg, true), away: simSide(A, H, lg, false), lg };
    const sim = simulateGame(input, { sims: SIMS, seed: hashSeed(`${date}|${g.id}|${hist.games.length}`) });
    const s = summarizeGame(sim);
    const players = [...H.skaters.map((p, i) => playerView(p, sim, i, g.home.abbrev, g.away.abbrev, A.goalie)), ...A.skaters.map((p, i) => playerView(p, sim, H.skaters.length + i, g.away.abbrev, g.home.abbrev, H.goalie))];
    const goalieView = (G, home) => (G ? { id: G.id, name: G.name, team: home ? g.home.abbrev : g.away.abbrev, svPct: +G.svPct.toFixed(4), season: G.season, last10: G.last10, projection: G.projection, saves: summarizeSaves(sim, home) } : null);
    const teamView = (side, head, rate) => ({ ...head, record: side.team.record, sfPerGame: +side.team.sfPerGame.toFixed(1), saPerGame: +side.team.saPerGame.toFixed(1), gfPerGame: +side.team.gfPerGame.toFixed(2), gaPerGame: +side.team.gaPerGame.toFixed(2), recent: side.team.recent, expectedShots: +rate.toFixed(1) });
    const result = g.state === 'post' ? { home: g.home.score, away: g.away.score, outcome: g.outcome, firstScorer: g.goals[0] ? { id: g.goals[0].playerId, name: g.goals[0].name, team: g.goals[0].team } : null, scorers: [...new Set(g.goals.map(x => x.playerId))] } : null;
    const view = {
      id: g.id, start: g.start, state: g.state, playoff: g.gameType === 3, venue: g.venue,
      home: teamView(H, g.home, input.home.rate), away: teamView(A, g.away, input.away.rate),
      live: g.state !== 'pre' ? { period: g.period, clock: g.clock, intermission: g.intermission, home: g.home.score, away: g.away.score, sogHome: g.home.sog, sogAway: g.away.sog, goals: g.goals } : null,
      result, ...s, fair: { home: american(s.pHome), away: american(s.pAway) }, leans: leansFor(s, g.home.abbrev, g.away.abbrev),
      goalies: { home: goalieView(H.goalie, true), away: goalieView(A.goalie, false) },
      players: players.sort((a, b) => b.anytime - a.anytime),
      lineupSource: conf ? 'Box score (game under way or final)' : `Projected from each team's last game (${H.team.last?.date || '—'} / ${A.team.last?.date || '—'})`,
    };
    out.push(view);
    out[out.length - 1]._sim = sim;
    if (g.state === 'pre') snaps.push({ game: { id: g.id, date, home: g.home, away: g.away }, payload: snapshotOf(view) });
  });
  const ready = out.filter(g => !g.unavailable);
  const sims = new Map(ready.map(g => [g.id, g._sim]));
  ready.forEach(g => delete g._sim);
  const payload = {
    date, generatedAt: new Date().toISOString(), sims: SIMS,
    history: { source: hist.source, games: hist.games.length, latest: hist.games.at(-1)?.date || null },
    league: { sogPerTeam: +lg.sogPerTeam.toFixed(1), shPct: lg.shPct, svPct: +lg.svPct.toFixed(4), goalsPerGame: +lg.goalsPerGame.toFixed(2), en: lg.en, pOT: +lg.pOT.toFixed(3), homeShotEdge: +lg.homeShotEdge.toFixed(3) },
    games: out, best: bestGoalscorer(ready),
  };
  payload.snapshot = snaps.length ? await saveSnapshotsSafely(snaps) : { saved: 0, reason: ready.length ? 'every game has started' : 'no games' };
  return { payload, sims };
}

// Today's best goalscorer play with no prices: the highest anytime chance among games not yet
// started, with the numbers behind it (value ranking needs pasted prices: Best plays tab).
function bestGoalscorer(games) {
  const pool = games.filter(g => g.state === 'pre').flatMap(g => g.players.map(p => ({ p, g })));
  if (!pool.length) return null;
  const { p, g } = pool.sort((a, b) => b.p.anytime - a.p.anytime)[0];
  return { gameId: g.id, playerId: p.id, ...reasonsFor(p, g) };
}

function reasonsFor(p, g) {
  const opp = p.team === g.home.abbrev ? g.away : g.home, oppG = p.team === g.home.abbrev ? g.goalies.away : g.goalies.home;
  const reasons = [
    `${p.expShots.toFixed(1)} expected shots: ${p.shots60.toFixed(1)} per 60 over ${p.toi.toFixed(1)} minutes a night`,
    `Finishes ${(p.shPct * 100).toFixed(1)}% of shots (regressed); ${p.season.goals} goals on ${p.season.shots} shots in ${p.season.gp} games this season`,
    `${opp.abbrev} allow ${opp.saPerGame} shots a game${oppG ? `; ${oppG.name} saves ${(oppG.svPct * 100).toFixed(1)}%` : ''}`,
  ];
  const l10 = p.last10.slice(0, 10), g10 = l10.reduce((s, x) => s + x.goals, 0), s10 = l10.reduce((s, x) => s + x.shots, 0);
  if (l10.length >= 5) reasons.push(`Last ${l10.length}: ${g10} goals, ${s10} shots`);
  return { name: p.name, team: p.team, opp: opp.abbrev, anytime: p.anytime, first: p.first, fair: p.fair.anytime, reasons };
}

function snapshotOf(v) {
  return {
    id: v.id, home: v.home.abbrev, away: v.away.abbrev, pHome: v.pHome, total: v.total, puckLine: v.puckLine, firstTeam: v.firstTeam,
    players: v.players.map(p => ({ id: p.id, name: p.name, team: p.team, pos: p.pos, anytime: p.anytime, first: p.first, shots: p.shots.mean })),
    goalies: Object.fromEntries(['home', 'away'].map(k => [k, v.goalies[k] ? { id: v.goalies[k].id, name: v.goalies[k].name, mean: v.goalies[k].saves.mean, p10: v.goalies[k].saves.p10, p90: v.goalies[k].saves.p90 } : null])),
  };
}

async function getSlateContext({ date = etDate() } = {}) {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const p = buildSlate({ date });
  cache.set(date, { at: Date.now(), ttl: CACHE_MS, value: p });
  try {
    const v = await p;
    if (v.payload.games.some(g => g.state === 'in')) cache.set(date, { at: Date.now(), ttl: LIVE_CACHE_MS, value: p });
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return v;
  } catch (err) { cache.delete(date); throw err; }
}
function clearSlateCache() { cache.clear(); }

module.exports = { buildSlate, getSlateContext, clearSlateCache, reasonsFor, leansFor, simSide, snapshotOf, american, SIMS };
