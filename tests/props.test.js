// DraftKings lines from ESPN's feed (lib/props) and their grading (lib/grading): over listed first,
// names matched to our players, a group that isn't one pair skipped, voids left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchLines } = require('../lib/props');
const { gradeOne } = require('../lib/grading');

const ref = id => ({ $ref: `http://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/seasons/2027/athletes/${id}?lang=en` });
const item = (id, type, american, line) => ({ athlete: ref(id), type: { name: type }, odds: { american: { value: american } }, current: line === undefined ? {} : { target: { value: line } } });
const g = { id: 'G1', home: { abbrev: 'BUF' }, away: { abbrev: 'TBL' },
  players: [{ id: 1, name: 'J. Carlson', team: 'TBL', pos: 'D' }, { id: 2, name: 'T. Thompson', team: 'BUF', pos: 'C' }],
  goalies: { home: { id: 30, name: 'U. Luukkonen', team: 'BUF' }, away: { id: 31, name: 'A. Vasilevskiy', team: 'TBL' } } };
const names = new Map([['5118', { name: 'John Carlson', first: 'John', last: 'Carlson' }], ['77', { name: 'Tage Thompson', first: 'Tage', last: 'Thompson' }], ['2976847', { name: 'Andrei Vasilevskiy', first: 'Andrei', last: 'Vasilevskiy' }], ['999', { name: 'Not Here', first: 'Not', last: 'Here' }]]);

test('DraftKings entries become priced bets on our players', () => {
  const { rows, unmatched } = matchLines([
    item(5118, 'Anytime Goalscorer', '+450'), item(77, 'First Goalscorer', '+900'), item(77, 'To Score 2+ Goals', '+1200'),
    item(5118, 'Total Shots on Goal', '-160', 1.5), item(5118, 'Total Shots on Goal', '+120', 1.5),
    item(2976847, 'Total Saves', '-120', 23.5), item(2976847, 'Total Saves', '-110', 23.5),
    item(77, 'Total Shots on Goal', '-115', 3.5), // only one side: skipped, never guessed
    item(999, 'Anytime Goalscorer', '+300'), item(5118, 'Total Points', '-105', 0.5),
  ], names, g);
  const find = (m, side) => rows.find(r => r.market === m && (side ? r.side === side : true));
  assert.equal(find('goal').player, 1); assert.equal(find('goal').raw, '+450'); assert.equal(find('goal').dec, 5.5);
  assert.equal(find('first').player, 2); assert.equal(find('goal2').player, 2);
  assert.deepEqual([find('sog', 'over').raw, find('sog', 'under').raw, find('sog', 'over').line], ['-160', '+120', 1.5]);
  assert.deepEqual([find('saves', 'over').team, find('saves', 'over').raw, find('saves', 'under').raw], ['away', '-120', '-110']);
  assert.equal(rows.filter(r => r.market === 'sog').length, 2, 'the one-sided shots line is skipped');
  assert.equal(unmatched, 1, 'a player not in our game is counted, not matched');
});

test('the lines are graded against the final, with voids left out', () => {
  const snap = { pHome: 0.5, total: { mean: 6, over: { 5.5: 0.5, 6.5: 0.4 } }, players: [{ id: 1, name: 'J. Carlson', anytime: 0.2, first: 0.03, shots: 2.4 }, { id: 2, name: 'T. Thompson', anytime: 0.4, first: 0.08, shots: 3.6 }],
    goalies: { away: { id: 31, name: 'A. Vasilevskiy', mean: 25, p10: 18, p90: 32 } },
    props: { provider: 'DraftKings', rows: [
      { market: 'goal', player: 1, dec: 5.5, p: 0.2 }, { market: 'goal', player: 2, dec: 2.2, p: 0.5 }, { market: 'goal', player: 3, dec: 3, p: 0.3 },
      { market: 'sog', player: 1, side: 'over', line: 1.5, dec: 1.625, p: 0.7 }, { market: 'sog', player: 1, side: 'under', line: 1.5, dec: 2.2, p: 0.3 },
      { market: 'saves', team: 'away', side: 'over', line: 23.5, dec: 1.833, p: 0.55 }, { market: 'saves', team: 'away', side: 'under', line: 23.5, dec: 1.909, p: 0.45 } ] } };
  const fin = { home: 'BUF', away: 'TBL', homeScore: 3, awayScore: 2, outcome: 'REG', goals: [{ playerId: 2, name: 'T. Thompson' }],
    skaters: [{ id: 1, goals: 0, shots: 3 }, { id: 2, goals: 1, shots: 5 }], goalies: [{ id: 31, team: 'TBL', starter: true, saves: 20 }] };
  const P = gradeOne(snap, fin).props;
  assert.equal(P.goal.n, 2, 'player 3 never dressed: void');
  assert.equal(P.goal.won, 1);
  assert.equal(P.goal.bets, 2, 'both clear 3% EV (20% at 5.5, 50% at 2.2)'); assert.equal(P.goal.returned, 2.2, 'Thompson scored, Carlson didn’t');
  assert.equal(P.sog.n, 2); assert.equal(P.sog.won, 1, 'over 1.5 won (3 shots), under lost');
  const devig = (1 / 1.625) / (1 / 1.625 + 1 / 2.2);
  assert.ok(Math.abs(P.sog.book - (devig + (1 - devig))) < 1e-3, 'shots: the two prices de-vigged');
  assert.deepEqual(P.shots, { n: 1, line: 1.5, model: 2.4, actual: 3 });
  assert.equal(P.saves.won, 1, '20 saves: the under won');
});
