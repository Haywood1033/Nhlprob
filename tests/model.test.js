// Parsers, ratings, simulator and market tests over the synthetic world (tests/fixtures.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { installMockFetch } = require('./fixtures');
const nhl = require('../lib/nhl');
const { gameRow } = require('../lib/store');
const { prepare, leagueAt, skaterAt, projectStarter, sideFor } = require('../lib/ratings');
const { simulateGame, summarizeGame, summarizePlayer, summarizeSaves } = require('../lib/simulator');
const { makeBook, priceTicket, legSeries } = require('../lib/markets');
const { parseBook } = require('../lib/book');
const { simSide } = require('../lib/slate');

const NOW = '2026-11-03T15:00:00Z';
const realNow = Date.now;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; });
test.after(() => { Date.now = realNow; });

async function history(w, days = 120) {
  const rows = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(Date.parse(`${w.today}T12:00:00Z`) - i * 864e5).toISOString().slice(0, 10);
    for (const sc of (await nhl.fetchScores(d)).filter(g => g.state === 'post')) rows.push(gameRow(d, sc, await nhl.fetchBoxscore(sc.id)));
  }
  return rows;
}

test('parsers: schedule, goals in order, box scores in both goalie formats', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const sched = await nhl.fetchSchedule(w.today);
    assert.equal(sched.length, w.days.get(w.today).length);
    assert.ok(sched.every(g => g.state === 'pre' && g.home.abbrev && g.away.name));
    const day = [...w.days.keys()].filter(d => d < w.today).at(-1);
    const scores = await nhl.fetchScores(day);
    const g = scores.find(x => x.goals.length >= 3);
    assert.ok(g.goals.every((x, i, a) => !i || (a[i - 1].period - 1) * 20 + a[i - 1].time <= (x.period - 1) * 20 + x.time), 'goals in order');
    assert.ok(g.goals.every(x => typeof x.team === 'string'), 'teamAbbrev as string or { default }');
    const src = w.byId.get(g.id).res;
    assert.equal(g.home.score, src.sc[0]);
    assert.equal(g.goals.filter(x => x.emptyNet).length, src.goals.filter(x => x.en).length);
    // Older format: "saves/shots" and no starter flag; the parser fills both.
    const old = [...w.byId.values()].find(x => x.res && Number(x.id.slice(-1)) % 5 === 0);
    const box = await nhl.fetchBoxscore(old.id);
    const gh = box.players.home.goalies[0];
    assert.equal(gh.shotsAgainst, old.res.faced[0]); assert.equal(gh.saves, old.res.saved[0]); assert.equal(gh.starter, true);
    assert.equal(box.players.home.skaters.length, 18);
    assert.equal(nhl.minutes('18:42'), 18.7);
    assert.equal(nhl.stateOf('OFF'), 'post'); assert.equal(nhl.stateOf('CRIT'), 'in'); assert.equal(nhl.stateOf('FUT'), 'pre');
  } finally { w.restore(); }
});

test('ratings are leak-free; back-to-back starts the backup', async () => {
  const w = installMockFetch({ now: NOW });
  try {
    const games = await history(w, 60);
    const prep = prepare(games), g = games.at(-1), p = g.skaters[0];
    const lg = leagueAt(prep, g.date);
    const before = skaterAt(prep, p.id, g.date, lg), after = skaterAt(prep, p.id, '2099-01-01', lg);
    assert.equal(after.games, before.games + 1);
    assert.ok(before.last10.every(r => r.date < g.date));
    assert.ok(lg.svPct > 0.85 && lg.svPct < 0.95 && lg.sogPerTeam > 20);
    // Fallback record from history: overtime and shootout losses are their own column.
    const { teamAt } = require('../lib/ratings');
    const t = teamAt(prep, g.home, '2099-01-01', lg).record, mine = games.filter(x => x.home === g.home || x.away === g.home);
    const otl = mine.filter(x => x.outcome !== 'REG' && (x.home === g.home ? x.homeScore < x.awayScore : x.awayScore < x.homeScore)).length;
    assert.equal(t.otl, otl); assert.equal(t.w + t.l + t.otl, t.gp); assert.equal(t.pts, 2 * t.w + t.otl);
    // A team that played yesterday with its usual starter projects the backup today.
    const today = w.today, yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
    const b2b = (w.days.get(yesterday) || []).flatMap(x => [x.home.abbrev, x.away.abbrev]).find(t => (w.days.get(today) || []).some(x => x.home.abbrev === t || x.away.abbrev === t));
    if (b2b) { const s = projectStarter(prep, b2b, today); if (s?.b2b && s.reason.includes('back-to-back')) assert.notEqual(s.id, prep.teams.get(b2b).at(-1).starter); }
  } finally { w.restore(); }
});

function toyGame(over = {}) {
  const sk = (base, n) => Array.from({ length: n }, (_, i) => ({ id: base + i, w: 1 + (i < 6 ? 1 : 0), sh: 0.1, toi: 16 }));
  return { id: 'g1', playoff: false, home: { rate: 31, skaters: sk(100, 18), goalie: { id: 1, sv: 0.91 } }, away: { rate: 28, skaters: sk(200, 18), goalie: { id: 2, sv: 0.9 } }, lg: { svPct: 0.905, en: { 1: 0.3, 2: 0.22 }, pOT: 0.6, dispK: 60 }, ...over };
}

test('simulator: outcomes add up, first scorer, saves only while in net', () => {
  const sim = simulateGame(toyGame(), { sims: 8000, seed: 3 });
  const s = summarizeGame(sim);
  assert.ok(Math.abs(s.pHome + s.pAway - 1) < 1e-9);
  assert.ok(s.pHome > 0.5, 'stronger home side favoured');
  assert.ok(Math.abs(s.regulation.home + s.regulation.away + s.regulation.tie - 1) < 1e-9);
  assert.ok(Math.abs(s.total.dist.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  let first = s.firstTeam.none; for (let i = 0; i < sim.players.length; i++) first += summarizePlayer(sim, i).first;
  assert.ok(Math.abs(first - 1) < 1e-9, 'first-goal chances + no goal = 1');
  for (let k = 0; k < 500; k++) { assert.ok(sim.svH[k] <= sim.saH[k]); assert.ok(sim.hg[k] + sim.ag[k] >= sim.regH[k] + sim.regA[k]); if (sim.ending[k] === 0) assert.notEqual(sim.hg[k], sim.ag[k]); }
  const sv = summarizeSaves(sim, true);
  assert.ok(sv.p10 <= sv.p50 && sv.p50 <= sv.p90 && sv.lines.length >= 4);
  const po = summarizeGame(simulateGame(toyGame({ playoff: true }), { sims: 4000, seed: 4 }));
  assert.equal(po.shootout, 0, 'no shootouts in the playoffs');
});

test('markets: correlated inside a game, independent across games', () => {
  const g1 = simulateGame(toyGame(), { sims: 10000, seed: 5 }), g2 = simulateGame({ ...toyGame(), id: 'g2' }, { sims: 10000, seed: 6 });
  const book = makeBook(new Map([['g1', g1], ['g2', g2]]));
  const ml = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }]).joint, mla = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'away' }]).joint;
  assert.ok(Math.abs(ml + mla - 1) < 1e-9);
  const pl = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }, { game: 'g1', market: 'pl', side: 'home', line: -1.5 }]);
  assert.ok(Math.abs(pl.joint - pl.legs[1].prob) < 1e-9, 'winning by 2+ implies winning');
  const o = legSeries(book, { game: 'g1', market: 'total', side: 'over', line: 5.5 }).prob, u = legSeries(book, { game: 'g1', market: 'total', side: 'under', line: 5.5 }).prob;
  assert.ok(Math.abs(o + u - 1) < 1e-9);
  const fa = priceTicket(book, [{ game: 'g1', market: 'first', player: 100 }, { game: 'g1', market: 'goal', player: 100 }]);
  assert.ok(Math.abs(fa.joint - fa.legs[0].prob) < 1e-9, 'first goal implies anytime');
  const sgp = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }, { game: 'g1', market: 'goal', player: 100 }]);
  assert.ok(sgp.lift > 1.05, 'a team winning and its scorer scoring move together');
  const sv = priceTicket(book, [{ game: 'g1', market: 'saves', team: 'home', side: 'under', line: 22.5 }, { game: 'g1', market: 'total', side: 'under', line: 5.5 }]);
  assert.ok(sv.joint > 0);
  const cross = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }, { game: 'g2', market: 'ml', side: 'home' }]);
  assert.ok(Math.abs(cross.lift - 1) < 0.05, 'different games are independent');
  assert.ok(priceTicket(book, [{ game: 'g1', market: 'goal', player: 999 }]).error);
});

test('signals: each one fires on its own data; tags need the count and a real chance', () => {
  const { signalsFor } = require('../lib/signals');
  const lg = { svPct: 0.905, sogPerTeam: 30, goalsPerGame: 6.1, shPct: { F: 0.11, D: 0.05 } };
  const p = { pos: 'C', expShots: 3.4, toi: 20, shPct: 0.15, raw: { shots: 200 }, season: { gp: 20, shots: 60 }, last10: Array.from({ length: 10 }, (_, i) => ({ goals: i < 3 ? 1 : 0, shots: 4 })), anytime: 0.4 };
  const hot = { lg, oppSaPerGame: 32, oppGoalieSv: 0.898, gameTotal: 6.7, oppB2b: true };
  const all = signalsFor(p, hot);
  assert.equal(all.count, 8); assert.equal(all.badge, 'Elite');
  const cold = signalsFor({ ...p, expShots: 1.2, toi: 12, shPct: 0.1, last10: p.last10.map(x => ({ ...x, goals: 0, shots: 3 })) }, { lg, oppSaPerGame: 29, oppGoalieSv: 0.915, gameTotal: 5.9, oppB2b: false });
  assert.equal(cold.count, 0); assert.equal(cold.badge, null);
  // A finisher needs the sample: 15% on 30 shots doesn't count.
  assert.equal(signalsFor({ ...p, raw: { shots: 30 } }, hot).signals.find(s => s.key === 'finisher').on, false);
  // Six signals but a 10% chance: no tag.
  assert.equal(signalsFor({ ...p, anytime: 0.1 }, hot).badge, null);
  // Defensemen have their own volume and minutes bars.
  const d = signalsFor({ ...p, pos: 'D', expShots: 2.7, toi: 23.5 }, hot).signals;
  assert.ok(d.find(s => s.key === 'volume').on && d.find(s => s.key === 'minutes').on);
});

test('calibration: fit recovers a known stretch; re-weighted games stay consistent', () => {
  const { calibrate, stretch } = require('../lib/calibration');
  const { calibrateWins } = require('../lib/simulator');
  const { makeRng } = require('../lib/rng');
  // Games whose true win chance is the model's stretched by 1.6: the fit should land near 1.6.
  const rng = makeRng(9), rows = [];
  for (let i = 0; i < 4000; i++) { const p = 0.35 + 0.3 * rng.uniform(); rows.push({ p, y: rng.uniform() < stretch(p, 1.6) ? 1 : 0, date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-01` }); }
  const c = calibrate(rows);
  assert.ok(Math.abs(c.kFit - 1.6) <= 0.15, `fitted ${c.kFit}`);
  assert.ok(c.kApplied > 1 && c.kApplied < c.kFit, 'applied is shrunk toward 1');
  assert.ok(c.check.calibrated < c.check.raw, 'helps on held-out games when the stretch is real');
  // Re-weighting a simulated game: weights average 1, the home win share moves to σ(k·logit p),
  // and every market moves consistently with it.
  const g1 = simulateGame(toyGame(), { sims: 10000, seed: 11 });
  const raw = summarizeGame(g1).pHome;
  calibrateWins(g1, 1.5);
  const S = g1.sims; let wsum = 0; for (let k = 0; k < S; k++) wsum += g1.w[k];
  assert.ok(Math.abs(wsum / S - 1) < 1e-6);
  const cal = summarizeGame(g1);
  assert.ok(Math.abs(cal.pHome - stretch(raw, 1.5)) < 1e-6 && cal.pHome > raw);
  assert.ok(cal.puckLine.homeMinus > 0 && cal.puckLine.homeMinus < cal.pHome);
  const book = makeBook(new Map([['g1', g1], ['g2', simulateGame({ ...toyGame(), id: 'g2' }, { sims: 10000, seed: 12 })]]));
  const ml = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }]).joint;
  assert.ok(Math.abs(ml - cal.pHome) < 1e-6, 'market pricing uses the same weights as the summary');
  assert.ok(Math.abs(ml + priceTicket(book, [{ game: 'g1', market: 'ml', side: 'away' }]).joint - 1) < 1e-6);
  const pl = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }, { game: 'g1', market: 'pl', side: 'home', line: -1.5 }]);
  assert.ok(Math.abs(pl.joint - pl.legs[1].prob) < 1e-6);
  const fa = priceTicket(book, [{ game: 'g1', market: 'first', player: 100 }, { game: 'g1', market: 'goal', player: 100 }]);
  assert.ok(Math.abs(fa.joint - fa.legs[0].prob) < 1e-6);
  assert.ok(Math.abs(fa.legs[1].prob - summarizePlayer(g1, 0).anytime) < 1e-6);
  const cross = priceTicket(book, [{ game: 'g1', market: 'ml', side: 'home' }, { game: 'g2', market: 'ml', side: 'home' }]);
  assert.ok(Math.abs(cross.lift - 1) < 0.05, 'games stay independent');
  // A home scorer's chance rises with his team's (calibrated) win chance.
  const g3 = simulateGame(toyGame(), { sims: 10000, seed: 11 });
  assert.ok(summarizePlayer(g1, 0).anytime > summarizePlayer(g3, 0).anytime);
});

test('freeze: a started game shows its pre-game snapshot, including older, smaller snapshots', () => {
  const { freezeToSnapshot } = require('../lib/slate');
  const view = () => ({ id: 'g', state: 'in', home: { abbrev: 'HOM', expectedShots: 31 }, away: { abbrev: 'AWY', expectedShots: 29 }, pHome: 0.7, pAway: 0.3, total: { mean: 6.9, over: { 5.5: 0.7, 6.5: 0.55 } }, puckLine: { homeMinus: 0.4, awayMinus: 0.1 }, firstTeam: { home: 0.6, away: 0.4, none: 0 },
    players: [{ id: 1, anytime: 0.5, first: 0.1, twoPlus: 0.1, shots: { mean: 3, over: {} }, fair: {} }, { id: 2, anytime: 0.3, first: 0.05, twoPlus: 0.05, shots: { mean: 2, over: {} }, fair: {} }],
    goalies: { home: { id: 9, saves: { mean: 30, p10: 20, p90: 40 } }, away: { id: 8, saves: { mean: 25, p10: 15, p90: 35 } } } });
  // Older snapshot shape: core numbers only.
  const old = { pHome: 0.58, total: { mean: 6.1, over: { 5.5: 0.55, 6.5: 0.42 } }, puckLine: { homeMinus: 0.3, awayMinus: 0.15 }, firstTeam: { home: 0.55, away: 0.45, none: 0 },
    players: [{ id: 1, anytime: 0.4, first: 0.09, shots: 2.8 }], goalies: { home: { id: 9, mean: 28, p10: 18, p90: 38 }, away: { id: 7, name: 'Other G', mean: 24, p10: 14, p90: 34 } } };
  const v = freezeToSnapshot(view(), old, '2026-11-03T22:00:00Z');
  assert.equal(v.pHome, 0.58); assert.ok(Math.abs(v.pAway - 0.42) < 1e-12);
  assert.equal(v.leans.moneyline.tier, 'lean'); assert.equal(v.leans.total.line, 6.5, 'a 6.1 total sits nearest the 6.5 line');
  assert.equal(v.players[0].anytime, 0.4); assert.equal(v.players[0].shots.mean, 2.8);
  assert.equal(v.players.find(p => p.id === 2).pregame, false, 'a late addition is flagged, not frozen');
  assert.equal(v.goalies.home.saves.mean, 28);
  assert.equal(v.goalies.away.pregameStarter, 'Other G', 'a different starter than projected is noted');
  assert.equal(v.frozen.full, false);
});

test('book parsing: players, goalies, teams, totals, skipped lines', async () => {
  const games = [{ id: 'g1', home: { abbrev: 'TOR', name: 'Toronto Maple Leafs', short: 'Maple Leafs' }, away: { abbrev: 'MTL', name: 'Montréal Canadiens', short: 'Canadiens' },
    players: [{ id: 1, name: 'Auston Matthews' }, { id: 2, name: 'Nick Suzuki' }], goalies: { home: { id: 9, name: 'Joseph Woll' }, away: { id: 8, name: 'Sam Montembeault' } } }];
  const { rows, skipped } = parseBook(['Auston Matthews, anytime, +120', 'A. Matthews, first, 9.0', 'Nick Suzuki, sog o2.5, -130', 'Joseph Woll, saves u27.5, -110', 'TOR, ml, -150', 'Canadiens, pl +1.5, -180', 'MTL @ TOR, over 6.5, -105', 'Maple Leafs, tt o3.5, +110', 'Nobody, anytime, +300', 'TOR, corners, +100'].join('\n'), games);
  assert.equal(rows.length, 8, JSON.stringify(rows));
  assert.deepEqual(rows[0], { game: 'g1', market: 'goal', player: 1, dec: 2.2, raw: '+120' });
  assert.equal(rows[1].market, 'first');
  assert.deepEqual([rows[2].side, rows[2].line], ['over', 2.5]);
  assert.deepEqual([rows[3].market, rows[3].team, rows[3].side], ['saves', 'home', 'under']);
  assert.deepEqual([rows[5].market, rows[5].side, rows[5].line], ['pl', 'away', 1.5]);
  assert.equal(rows[6].market, 'total');
  assert.deepEqual([rows[7].market, rows[7].team], ['tt', 'home']);
  assert.equal(skipped.length, 2);
});
