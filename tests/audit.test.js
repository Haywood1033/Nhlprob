// Fixes from the November 2026 audit: odds parsing, name matching, the sync completeness rule,
// missing shot totals, and the optional sync lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { toDecimal, parseBook } = require('../lib/book');
const { isComplete } = require('../lib/store');
const { prepare, leagueAt, teamAt } = require('../lib/ratings');

test('odds: bare whole numbers of 100+ are American; EVEN; typos are rejected, not read as decimal', () => {
  assert.equal(toDecimal('150'), 2.5);
  assert.equal(toDecimal('+150'), 2.5);
  assert.ok(Math.abs(toDecimal('-110') - 1.9091) < 1e-4);
  assert.ok(Math.abs(toDecimal('−120') - 1.8333) < 1e-4); // typographic minus
  assert.equal(toDecimal('EVEN'), 2);
  assert.equal(toDecimal('even'), 2);
  assert.equal(toDecimal('2.50'), 2.5);
  assert.equal(toDecimal('11'), 11); // decimal longshot
  assert.equal(toDecimal('80'), null); // neither a sane decimal nor American
  assert.equal(toDecimal('+80'), null);
});

const games = [{
  id: 'g1', home: { abbrev: 'VAN', name: 'Vancouver Canucks', short: 'Canucks' }, away: { abbrev: 'CAR', name: 'Carolina Hurricanes', short: 'Hurricanes' },
  players: [{ id: 1, name: 'Elias Pettersson', team: 'VAN', pos: 'F' }, { id: 2, name: 'Elias Pettersson', team: 'VAN', pos: 'D' }, { id: 3, name: 'Sebastian Aho', team: 'CAR', pos: 'F' }, { id: 4, name: 'Auston Matthews', team: 'VAN', pos: 'F' }],
  goalies: { home: { id: 9, name: 'Thatcher Demko', team: 'VAN' }, away: null },
}];

test('names: duplicates need a qualifier; "Last, First" parses; reasons say what to do', () => {
  const r = parseBook([
    'Elias Pettersson, anytime, +200', // ambiguous
    'Elias Pettersson (D), anytime, 400',
    'Elias Pettersson (VAN F), sog o2.5, -120',
    'Matthews, Auston, anytime, 150',
    'Thatcher Demko, saves o27.5, EVEN',
  ].join('\n'), games);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /More than one skater.*add the team or position/);
  assert.deepEqual(r.rows.map(x => [x.market, x.player ?? x.team, x.dec]), [['goal', 2, 5], ['sog', 1, 1 + 100 / 120], ['goal', 4, 2.5], ['saves', 'home', 2]]);
});

test('sync: a day is complete only when every scheduled game was saved', () => {
  assert.equal(isComplete({ rows: [], listed: 0, scheduled: 0 }), true); // no games that day
  assert.equal(isComplete({ rows: [], listed: 0, scheduled: 7 }), false); // empty feed on a game day
  assert.equal(isComplete({ rows: [1, 2], listed: 2, scheduled: 3 }), false); // one still missing
  assert.equal(isComplete({ rows: [1], listed: 2, scheduled: 2 }), false); // a box score failed
  assert.equal(isComplete({ rows: [1, 2], listed: 2, scheduled: null }), false); // schedule unreadable
  assert.equal(isComplete({ rows: [1, 2], listed: 2, scheduled: 2 }), true);
});

test('ratings: a game with missing shot totals is skipped for shot rates, not counted as zero', () => {
  const g = (id, date, hs, as) => ({ id, date, gameType: 2, home: 'AAA', away: 'BBB', homeName: 'A', awayName: 'B', homeScore: 3, awayScore: 2, homeSog: hs, awaySog: as, outcome: 'REG', goals: [], skaters: [], goalies: [] });
  const games = [g('1', '2026-10-01', 30, 30), g('2', '2026-10-03', 30, 30), g('3', '2026-10-05', null, null)];
  const prep = prepare(games), lg = leagueAt(prep, '2026-10-07');
  assert.ok(Math.abs(lg.sogPerTeam - 30) < 1e-9, 'league rate ignores the game without shots');
  const withGap = teamAt(prep, 'AAA', '2026-10-07', lg), without = teamAt(prepare(games.slice(0, 2)), 'AAA', '2026-10-07', lg);
  assert.ok(Math.abs(withGap.sfPerGame - without.sfPerGame) < 0.2, `${withGap.sfPerGame} vs ${without.sfPerGame}`);
  assert.ok(withGap.sfPerGame > 29, 'not dragged toward zero');
});

test('sync lock: open without CRON_SECRET; with it, only the bearer token or ?key=', async () => {
  const handler = require('../api/sync');
  const call = async (req) => { let status = 0, body = null; await handler({ query: {}, headers: {}, ...req }, { setHeader() {}, status(s) { status = s; return { json(b) { body = b; } }; } }); return { status, body }; };
  const prev = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = 's3cret';
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ query: { key: 'wrong' } })).status, 401);
    // Past the lock: no database in tests, so the sync itself answers 400 (nowhere to save).
    assert.equal((await call({ headers: { authorization: 'Bearer s3cret' } })).status, 400);
    assert.equal((await call({ query: { key: 's3cret' } })).status, 400);
    delete process.env.CRON_SECRET;
    assert.equal((await call({})).status, 400);
  } finally { if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev; }
});

test('market: a one-sided line is de-vigged; both sides use the usual normalisation', () => {
  const { parseOdds, OVERROUND } = require('../lib/market');
  const c = (home, away, details) => ({ odds: [{ homeTeamOdds: { moneyLine: home }, awayTeamOdds: { moneyLine: away }, details, overUnder: 6 }] });
  const both = parseOdds(c(-150, 130), 'TOR', 'MTL');
  assert.ok(Math.abs(both.pHome - (0.6 / (0.6 + 100 / 230))) < 1e-4);
  const one = parseOdds(c(null, null, 'TOR -150'), 'TOR', 'MTL');
  assert.ok(Math.abs(one.pHome - 0.6 / OVERROUND) < 1e-4, `${one.pHome}`);
});

test('value plays must clear the simulation noise as well as 3% EV', () => {
  const { clearsNoise, evSe } = require('../lib/plays');
  // 7% first goal at +1200 (13.0): 3.1% EV but ±2.7% noise at 15,000 runs → not enough.
  const p = 0.0793, dec = 13;
  assert.ok(p * dec - 1 >= 0.03);
  assert.ok(Math.abs(evSe(0.07, 13, 15000) - 0.027) < 0.002);
  assert.equal(clearsNoise(p * dec - 1, p, dec, 15000), false);
  // A 55% side at +100 (2.0): 10% EV, noise ±0.8% → clears.
  assert.equal(clearsNoise(0.1, 0.55, 2, 15000), true);
});

test('empirical-Bayes prior strength recovers a known talent spread', () => {
  const { ebStrength } = require('../lib/ratings');
  const { makeRng } = require('../lib/rng');
  const rng = makeRng(5), items = [];
  // True rates ~ mean .10, sd .02 → prior worth .1·.9/.0004 − 1 ≈ 224 shots.
  for (let i = 0; i < 600; i++) { const p = 0.1 + 0.02 * rng.normal(), n = 60 + Math.floor(rng.uniform() * 200); let x = 0; for (let j = 0; j < n; j++) if (rng.uniform() < p) x++; items.push({ n, x }); }
  const k = ebStrength(items, { minN: 20, minItems: 50, lo: 10, hi: 5000 });
  assert.ok(k > 150 && k < 330, `k = ${k}`);
  assert.equal(ebStrength(items.slice(0, 10), { minN: 20, minItems: 50, lo: 10, hi: 5000 }), null, 'too few players: no fit');
});

test('effects: switched on only by enough held-out evidence; bias fixes stay on by default', () => {
  const { decide, MIN_GAMES } = require('../lib/effects');
  assert.equal(decide('team', { games: 100, dMl: -0.01, dAny: 0 }).on, false, 'too few games: default off');
  assert.equal(decide('team', { games: MIN_GAMES, dMl: -0.001, dAny: 0 }).on, true);
  assert.equal(decide('team', { games: MIN_GAMES, dMl: -0.001, dAny: 0.0005 }).on, false, 'hurts goalscorers: stays off');
  assert.equal(decide('late', { games: 50, dMl: 0.01, dAny: 0 }).on, true, 'bias fix: on until shown otherwise');
  assert.equal(decide('late', { games: MIN_GAMES, dMl: 0.001, dAny: 0 }).on, false, 'shown worse: off');
  assert.equal(decide('lineup', { games: MIN_GAMES, dMl: -0.0001, dAny: 0 }).on, false, 'no clear difference: default');
});
