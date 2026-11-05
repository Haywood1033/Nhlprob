// lib/slate.js — one day's slate: every game with both lineups (who dressed last game), the
// projected or confirmed starting goalies, team and player state as of that morning, the
// simulation, and every number the tabs show — moneyline, puck line, totals and their leans,
// each skater's anytime / 2+ / first goal and shots, each starter's saves. Cached per date so
// every product prices from the same simulated games.

const { fetchSchedule, fetchScores, fetchBoxscore, fetchStandings, fetchRosterGoalies } = require('./nhl');
const { loadHistory, saveSnapshotsSafely, etDate, loadStarters, loadDailyPick, saveDailyPick, loadCalibration, loadSnapshots } = require('./store');
const db = require('./db');
const { prepare, leagueAt, sideFor, teamGoalies } = require('./ratings');
const { simulateGame, summarizeGame, summarizePlayer, summarizeSaves, calibrateWins } = require('./simulator');
const { mapLimit } = require('./http');
const { hashSeed } = require('./rng');
const { signalsFor, tierRank } = require('./signals');
const { isSharp } = require('./sharp');
const { mlTier, totalLean } = require('./lean');
const { daysBetween } = require('./ratings');

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

// Leans with no prices: the side the model makes more likely (books hang 5.5 or 6.5 totals; ±1.5
// puck lines). The total only leans when it clears that line's base rate by a clear margin
// (lib/lean totalLean); otherwise side is null and the card shows "No lean" with the model total.
function leansFor(s, home, away) {
  const fav = s.pHome >= 0.5 ? { side: 'home', team: home, p: s.pHome } : { side: 'away', team: away, p: s.pAway };
  const tl = totalLean(s.total.over, s.total.mean);
  const favPl = fav.side === 'home' ? s.puckLine.homeMinus : s.puckLine.awayMinus;
  return {
    moneyline: { side: fav.side, team: fav.team, prob: fav.p, fair: american(fav.p), tier: mlTier(s.pHome) },
    total: { ...tl, fair: tl.side ? american(tl.prob) : null, mean: s.total.mean },
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
    season: p.season, last10: p.last10, raw: p.raw, oppGoalie: oppGoalie ? { id: oppGoalie.id, name: oppGoalie.name, svPct: +oppGoalie.svPct.toFixed(4) } : null,
    ...s, fair: { anytime: american(s.anytime), first: american(s.first) },
  };
}

// "PHI:8478971,BOS:8471695" → Map(team → { id, source: 'manual' }) — a viewer's own starter picks.
function parseStarters(v) {
  const m = new Map();
  for (const part of String(v || '').split(',')) { const [t, id] = part.split(':'); if (/^[A-Z]{2,4}$/.test(t || '') && Number(id) > 0) m.set(t, { id: Number(id), source: 'manual' }); }
  return m;
}
const startersKey = m => [...(m || new Map()).entries()].sort().map(([t, x]) => `${t}:${x.id}`).join(',');

// Starter precedence: the box score (game under way) > the viewer's own pick > a pick saved to the
// database (shared) > the projection.
async function buildSlate({ date = etDate(), starters = null } = {}) {
  const [sched, scores, standings] = await Promise.all([fetchSchedule(date), fetchScores(date).catch(() => []), fetchStandings(date).catch(() => null)]);
  const byId = new Map(scores.map(g => [g.id, g]));
  const games = sched.map(g => ({ ...g, ...(byId.get(g.id) ? { state: byId.get(g.id).state, period: byId.get(g.id).period, clock: byId.get(g.id).clock, intermission: byId.get(g.id).intermission, outcome: byId.get(g.id).outcome, home: { ...g.home, score: byId.get(g.id).home.score, sog: byId.get(g.id).home.sog }, away: { ...g.away, score: byId.get(g.id).away.score, sog: byId.get(g.id).away.sog }, goals: byId.get(g.id).goals } : { goals: [] }) }));
  const hist = await loadHistory({ before: date });
  const prep = prepare(hist.games), lg = leagueAt(prep, date);
  const confirmed = await mapLimit(games, 6, confirmedFor);
  const shared = await loadStarters(date);
  const cal = await loadCalibration(); // backtest-fitted moneyline stretch (k = 1 if none yet)
  const kML = cal && Number.isFinite(cal.k) ? cal.k : 1;
  const picks = new Map([...shared, ...(starters || new Map())]);
  const teams = [...new Set(games.flatMap(g => [g.home.abbrev, g.away.abbrev]))];
  const rosters = new Map(await mapLimit(teams, 8, async t => [t, await fetchRosterGoalies(t).catch(() => [])]));
  // Starter options: the current roster's goalies plus anyone who has played for the team lately.
  const optionsFor = t => { const used = teamGoalies(prep, t, date), out = new Map(); for (const x of [...(rosters.get(t) || []), ...used]) { const prev = out.get(x.id) || {}; out.set(x.id, { id: x.id, name: prev.name || x.name, starts: Math.max(prev.starts || 0, x.starts || 0), last: prev.last || x.last || null }); } return [...out.values()].filter(x => x.name).sort((a, b) => b.starts - a.starts); };
  const nameOf = (t, id) => optionsFor(t).find(x => x.id === id)?.name || null;

  const out = [], snaps = [];
  games.forEach((g, gi) => {
    const conf = confirmed[gi];
    const pickFor = (t, box) => (box ? { id: box, source: 'boxscore' } : picks.get(t) ? { ...picks.get(t), name: picks.get(t).name || nameOf(t, picks.get(t).id) } : null);
    // Once a game starts, the box score's lineup (who actually dressed) replaces the projection.
    const H = sideFor(prep, g.home.abbrev, g.away.abbrev, date, lg, { starter: pickFor(g.home.abbrev, conf?.home.starter), lineup: conf?.home.skaters });
    const A = sideFor(prep, g.away.abbrev, g.home.abbrev, date, lg, { starter: pickFor(g.away.abbrev, conf?.away.starter), lineup: conf?.away.skaters });
    if (!H.skaters.length || !A.skaters.length) { out.push({ id: g.id, start: g.start, state: g.state, home: g.home, away: g.away, unavailable: 'Not enough history for one of these teams yet.' }); return; }
    const input = { id: g.id, playoff: g.gameType === 3, home: simSide(H, A, lg, true), away: simSide(A, H, lg, false), lg };
    const sim = simulateGame(input, { sims: SIMS, seed: hashSeed(`${date}|${g.id}|${hist.games.length}|${H.goalie?.id}|${A.goalie?.id}`) });
    calibrateWins(sim, kML);
    const s = summarizeGame(sim);
    const players = [...H.skaters.map((p, i) => playerView(p, sim, i, g.home.abbrev, g.away.abbrev, A.goalie)), ...A.skaters.map((p, i) => playerView(p, sim, H.skaters.length + i, g.away.abbrev, g.home.abbrev, H.goalie))];
    // Signals and tags: each skater against the side he's facing tonight.
    const b2b = side => !!side.team.last && daysBetween(side.team.last.date, date) <= 1.01;
    for (const p of players) {
      const opp = p.team === g.home.abbrev ? A : H;
      Object.assign(p, signalsFor(p, { lg, oppSaPerGame: opp.team.saPerGame, oppGoalieSv: opp.goalie ? opp.goalie.svPct : null, gameTotal: s.total.mean, oppB2b: b2b(opp) }));
    }
    const goalieView = (G, home) => (G ? { id: G.id, name: G.name, team: home ? g.home.abbrev : g.away.abbrev, options: optionsFor(home ? g.home.abbrev : g.away.abbrev).slice(0, 5), shared: shared.has(home ? g.home.abbrev : g.away.abbrev), svPct: +G.svPct.toFixed(4), season: G.season, last10: G.last10, projection: G.projection, saves: summarizeSaves(sim, home) } : null);
    const teamView = (side, head, rate) => ({ ...head, record: standings?.get(head.abbrev) ? { ...standings.get(head.abbrev), source: 'standings' } : side.team.record, sfPerGame: +side.team.sfPerGame.toFixed(1), saPerGame: +side.team.saPerGame.toFixed(1), gfPerGame: +side.team.gfPerGame.toFixed(2), gaPerGame: +side.team.gaPerGame.toFixed(2), recent: side.team.recent, expectedShots: +rate.toFixed(1) });
    const result = g.state === 'post' ? { home: g.home.score, away: g.away.score, outcome: g.outcome, firstScorer: g.goals[0] ? { id: g.goals[0].playerId, name: g.goals[0].name, team: g.goals[0].team } : null, scorers: [...new Set(g.goals.map(x => x.playerId))] } : null;
    const view = {
      id: g.id, start: g.start, state: g.state, playoff: g.gameType === 3, venue: g.venue,
      home: teamView(H, g.home, input.home.rate), away: teamView(A, g.away, input.away.rate),
      live: g.state !== 'pre' ? { period: g.period, clock: g.clock, intermission: g.intermission, home: g.home.score, away: g.away.score, sogHome: g.home.sog, sogAway: g.away.sog, goals: g.goals } : null,
      result, ...s, fair: { home: american(s.pHome), away: american(s.pAway) }, leans: leansFor(s, g.home.abbrev, g.away.abbrev),
      goalies: { home: goalieView(H.goalie, true), away: goalieView(A.goalie, false) },
      players: players.sort((a, b) => b.anytime - a.anytime),
      lineupSource: conf ? `Lineups and starting goalies confirmed from the NHL box score (game ${g.state === 'post' ? 'final' : 'started'})` : `Lineups projected from each team's last game (${A.team.abbrev} on ${A.team.last?.date || '—'}, ${H.team.abbrev} on ${H.team.last?.date || '—'}); starting goalies projected until puck drop`,
    };
    out.push(view);
    out[out.length - 1]._sim = sim;
    // A viewer's own picks don't become the graded projection; shared (database) picks do.
    if (g.state === 'pre' && !(starters && starters.size)) snaps.push({ game: { id: g.id, date, home: g.home, away: g.away }, payload: snapshotOf(view) });
  });
  // Started games: freeze to the saved pre-game projection when there is one.
  const saved = out.some(g => !g.unavailable && g.state !== 'pre') ? await loadSnapshots(date) : new Map();
  for (const v of out) {
    if (v.unavailable || v.state === 'pre') continue;
    const snap = saved.get(v.id);
    if (snap) freezeToSnapshot(v, snap.payload, snap.savedAt); else v.frozen = null;
  }
  const ready = out.filter(g => !g.unavailable);
  const sims = new Map(ready.map(g => [g.id, g._sim]));
  ready.forEach(g => delete g._sim);
  const payload = {
    date, generatedAt: new Date().toISOString(), sims: SIMS, startersShared: db.hasDb,
    calibration: cal ? { k: kML, kFit: cal.kFit, n: cal.n, fittedAt: cal.fittedAt } : { k: 1, note: 'No calibration yet: run a 40- or 60-day backtest with the database connected.' },
    history: { source: hist.source, games: hist.games.length, latest: hist.games.at(-1)?.date || null },
    league: { sogPerTeam: +lg.sogPerTeam.toFixed(1), shPct: lg.shPct, svPct: +lg.svPct.toFixed(4), goalsPerGame: +lg.goalsPerGame.toFixed(2), en: lg.en, pOT: +lg.pOT.toFixed(3), homeShotEdge: +lg.homeShotEdge.toFixed(3) },
    games: out, ...(await dailyPick(date, ready, !(starters && starters.size))),
  };
  payload.snapshot = snaps.length ? await saveSnapshotsSafely(snaps) : { saved: 0, reason: ready.length ? 'every game has started' : 'no games' };
  return { payload, sims };
}

// The day's best goalscorer play: the highest anytime chance on the whole slate, locked once the
// first game starts so it doesn't drift to a later game's player as earlier games get under way.
// Before any puck drop it's recomputed (and, with a database, saved) on every load; after, the
// saved pick is used, or without a database the best across all of the day's games (started ones
// still carry their pre-game numbers). `bestRemaining` is the best among games still to start.
async function dailyPick(date, games, canSave) {
  const started = games.some(g => g.state !== 'pre');
  const fresh = bestGoalscorer(games, () => true);
  let best = fresh;
  if (!started) { if (canSave && fresh) await saveDailyPick(date, fresh); }
  else {
    const stored = await loadDailyPick(date);
    if (stored) best = { ...stored, lockedFrom: 'database' };
    else if (canSave) {
      // Nothing was saved before the first puck drop (e.g. the database was connected mid-slate):
      // lock now, picking only from games not yet started so the pick can't be hindsight, and
      // keep it from here on instead of re-picking on every load.
      const late = bestGoalscorer(games, g => g.state === 'pre') || fresh;
      if (late) { const saved = { ...late, lockedLate: new Date().toISOString() }; if (await saveDailyPick(date, saved)) best = { ...saved, lockedFrom: 'database' }; else best = late; }
    }
  }
  if (best) best = { ...best, locked: started };
  const remaining = started ? bestGoalscorer(games, g => g.state === 'pre') : null;
  return { best, bestRemaining: remaining && best && remaining.playerId !== best.playerId ? remaining : null };
}

// Highest anytime chance among the games `keep` lets through, with the numbers behind it
// (a model pick, not a value call: value needs pasted prices on Best plays).
function bestGoalscorer(games, keep) {
  const pool = games.filter(keep).flatMap(g => g.players.map(p => ({ p, g })));
  if (!pool.length) return null;
  // A Sharp play first (lib/sharp: tag + workload + matchup + form converging, the top of the Best
  // plays tab), then the strongest tag (Elite, All-Star, Value), then signals, then the chance.
  const sharp = x => (isSharp(x.p, x.p.anytime) ? 1 : 0);
  const { p, g } = pool.sort((a, b) => sharp(b) - sharp(a) || tierRank(b.p.badge) - tierRank(a.p.badge) || (b.p.count ?? 0) - (a.p.count ?? 0) || b.p.anytime - a.p.anytime)[0];
  return { gameId: g.id, playerId: p.id, sharp: !!sharp({ p }), ...reasonsFor(p, g) };
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
  return { name: p.name, team: p.team, opp: opp.abbrev, anytime: p.anytime, first: p.first, fair: p.fair.anytime, badge: p.badge || null, count: p.count ?? null, signals: p.signals || [], reasons };
}

// The pre-game projection saved for grading, and the version a started game is frozen to. The
// original fields (graded by lib/grading) stay as they were; the rest is what a card shows.
function snapshotOf(v) {
  return {
    id: v.id, home: v.home.abbrev, away: v.away.abbrev, pHome: v.pHome, total: v.total, puckLine: v.puckLine, firstTeam: v.firstTeam,
    pAway: v.pAway, fair: v.fair, leans: v.leans, regulation: v.regulation, overtime: v.overtime, shootout: v.shootout, teamTotal: v.teamTotal, firstPeriod: v.firstPeriod, sog: v.sog,
    expectedShots: { home: v.home.expectedShots, away: v.away.expectedShots },
    players: v.players.map(p => ({ id: p.id, name: p.name, team: p.team, pos: p.pos, anytime: p.anytime, first: p.first, shots: p.shots.mean, twoPlus: p.twoPlus, fairOdds: p.fair, shotsDetail: p.shots, badge: p.badge || null, count: p.count ?? null, signals: p.signals || null })),
    goalies: Object.fromEntries(['home', 'away'].map(k => [k, v.goalies[k] ? { id: v.goalies[k].id, name: v.goalies[k].name, mean: v.goalies[k].saves.mean, p10: v.goalies[k].saves.p10, p90: v.goalies[k].saves.p90, saves: v.goalies[k].saves, projection: v.goalies[k].projection } : null])),
  };
}

// A started game shows exactly what was projected before puck drop: its saved snapshot replaces
// the recalculated numbers (a later calibration, a starter pick or the box score's lineup would
// otherwise rewrite leans after the fact). Live score, goals and status still update. Snapshots
// saved before this change carry fewer fields; whatever they have is used.
function freezeToSnapshot(view, snap, savedAt) {
  const s = snap || {};
  for (const k of ['pHome', 'total', 'puckLine', 'firstTeam', 'regulation', 'overtime', 'shootout', 'teamTotal', 'firstPeriod', 'sog']) if (s[k] !== undefined) view[k] = s[k];
  view.pAway = s.pAway ?? 1 - view.pHome;
  view.fair = s.fair || { home: american(view.pHome), away: american(view.pAway) };
  view.leans = s.leans || leansFor(view, view.home.abbrev, view.away.abbrev);
  if (s.expectedShots) { view.home.expectedShots = s.expectedShots.home; view.away.expectedShots = s.expectedShots.away; }
  const byId = new Map((s.players || []).map(p => [p.id, p]));
  for (const p of view.players) {
    const q = byId.get(p.id);
    if (!q) { p.pregame = false; continue; } // dressed tonight but not in the pre-game lineup
    p.anytime = q.anytime; p.first = q.first;
    if (q.twoPlus !== undefined) p.twoPlus = q.twoPlus;
    p.shots = q.shotsDetail || { ...p.shots, mean: q.shots };
    p.fair = q.fairOdds || { anytime: american(q.anytime), first: american(q.first) };
    if (q.signals) { p.signals = q.signals; p.count = q.count; p.badge = q.badge; }
  }
  view.players.sort((a, b) => b.anytime - a.anytime);
  for (const k of ['home', 'away']) {
    const q = s.goalies?.[k], G = view.goalies[k];
    if (!q || !G) continue;
    if (q.id === G.id) { if (q.saves) G.saves = q.saves; else Object.assign(G.saves, { mean: q.mean, p10: q.p10, p90: q.p90 }); }
    else G.pregameStarter = q.name; // a different goalie started than was projected
  }
  view.frozen = { savedAt, full: !!s.leans };
  return view;
}

// The cache key includes the shared starter picks (database), not only this request's own: a pick
// is saved by /api/starters, a different serverless function whose cache clear can't reach this
// one, so without them here a pick wouldn't show until this function's cache expired.
async function getSlateContext({ date = etDate(), starters = null } = {}) {
  const shared = db.hasDb ? await loadStarters(date) : null;
  const key = `${date}|${startersKey(starters)}|${startersKey(shared)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const p = buildSlate({ date, starters });
  cache.set(key, { at: Date.now(), ttl: CACHE_MS, value: p });
  try {
    const v = await p;
    if (v.payload.games.some(g => g.state === 'in')) cache.set(key, { at: Date.now(), ttl: LIVE_CACHE_MS, value: p });
    if (cache.size > 10) cache.delete(cache.keys().next().value);
    return v;
  } catch (err) { cache.delete(key); throw err; }
}
function clearSlateCache() { cache.clear(); }

module.exports = { freezeToSnapshot, buildSlate, getSlateContext, clearSlateCache, parseStarters, reasonsFor, leansFor, simSide, snapshotOf, american, SIMS };
