// End to end through the real route handlers over the synthetic world.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NHL_MEMORY_DAYS = '400';
const { installMockFetch } = require('./fixtures');

const NOW = '2026-11-03T15:00:00Z';
const realNow = Date.now;
let world;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; world = installMockFetch({ now: NOW }); });
test.after(() => { world.restore(); Date.now = realNow; });

function call(name, { query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json(b) { resolve({ code, body: b }); }, end() { resolve({ code }); } };
    require(`../api/${name}.js`)({ method: body ? 'POST' : 'GET', query, body }, res).catch(reject);
  });
}

test('slate: every game simulated, probabilities consistent, best play', async () => {
  const { code, body } = await call('slate');
  assert.equal(code, 200);
  assert.equal(body.date, world.today);
  assert.equal(body.games.length, world.days.get(world.today).length);
  for (const g of body.games) {
    assert.ok(!g.unavailable, g.unavailable);
    assert.ok(Math.abs(g.pHome + g.pAway - 1) < 1e-9);
    assert.equal(g.players.length, 36);
    assert.ok(g.goalies.home && g.goalies.away);
    const first = g.players.reduce((s, p) => s + p.first, 0) + g.firstTeam.none;
    assert.ok(Math.abs(first - 1) < 1e-9);
    assert.ok(['over', 'under'].includes(g.leans.total.side) && [5.5, 6.5].includes(g.leans.total.line));
  }
  const avg = body.games.reduce((s, g) => s + g.total.mean, 0) / body.games.length;
  assert.ok(Math.abs(avg - body.league.goalsPerGame) < 0.5, `slate total ${avg} vs league ${body.league.goalsPerGame}`);
  assert.ok(body.best && body.best.anytime === Math.max(...body.games.flatMap(g => g.players.map(p => p.anytime))));
  assert.equal(body.snapshot.saved, 0);
  // Records come from the standings (W-L-OT), matching the season's finished games.
  const { standingsAt } = require('./fixtures');
  const official = new Map(standingsAt(world, world.today).map(r => [r.teamAbbrev.default, r]));
  for (const g of body.games) for (const t of [g.home, g.away]) {
    const o = official.get(t.abbrev);
    assert.deepEqual([t.record.w, t.record.l, t.record.otl, t.record.pts, t.record.source], [o.wins, o.losses, o.otLosses, o.points, 'standings']);
  }
});

test('plays: model mode without prices, value mode with them; SGP pricing', async () => {
  const slate = (await call('slate')).body;
  const m = (await call('plays', { body: { book: '' } })).body;
  assert.equal(m.sections.anytime.mode, 'model');
  assert.ok(m.sections.anytime.items.length && m.sections.saves.items.length && m.sgp.length);
  assert.ok(m.sgp.every(t => t.lift > 1));
  const g = slate.games[0], p = g.players[0];
  const v = (await call('plays', { body: { book: `${p.name}, anytime, +900\n${g.home.abbrev}, ml, +100\nNo One, anytime, +100` } })).body;
  assert.equal(v.sections.anytime.mode, 'value');
  assert.equal(v.sections.anytime.items[0].player, p.id);
  assert.equal(v.book.matched, 2); assert.equal(v.book.skipped.length, 1);
  const t = (await call('sgp', { body: { legs: [{ game: g.id, market: 'ml', side: g.leans.moneyline.side }, { game: g.id, market: 'goal', player: g.players.find(x => x.team === g.leans.moneyline.team).id }] } })).body;
  assert.ok(t.joint > 0 && t.joint < 1 && t.lift > 1);
  assert.equal((await call('sgp', { body: { legs: [{ game: 'nope', market: 'ml', side: 'home' }] } })).code, 400);
});

test('backtest beats simple baselines; health, status, grades, sync', async () => {
  const bt = (await call('backtest', { query: { days: '15' } })).body;
  assert.ok(bt.games > 50);
  assert.ok(bt.anytime.logLoss.model < bt.anytime.logLoss.naive, 'anytime beats raw goals-per-game');
  assert.ok(bt.sog.mae.model < bt.sog.mae.naive, 'shots beat season average');
  assert.ok(bt.saves.mae.model < bt.saves.mae.naive, 'saves beat season saves per start');
  assert.ok(bt.first.logLoss.model < bt.first.logLoss.uniform, 'first goal beats an even split');
  const h = await call('health');
  assert.equal(h.code, 200, JSON.stringify(h.body.checks.filter(c => !c.ok)));
  assert.equal(h.body.checks.length, 6);
  const st = (await call('status')).body;
  assert.equal(st.history.source, 'live-recent'); assert.equal(st.snapshots.connected, false);
  const gr = (await call('grades')).body;
  assert.match(gr.note, /No database/);
  assert.equal((await call('sync')).code, 400);
  const sn = (await call('sync', { query: { snapshot: '1' } })).body;
  assert.equal(sn.pregame, world.days.get(world.today).length);
});
