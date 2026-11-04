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
  // Every skater carries eight signals; the day's pick is the strongest tag, then the highest chance.
  const rank = { Elite: 3, 'All-Star': 2, Value: 1 };
  const everyone = body.games.flatMap(g => g.players);
  assert.ok(everyone.every(p => p.signals.length === 8 && p.count === p.signals.filter(s => s.on).length));
  assert.ok(everyone.every(p => !p.badge || (p.count >= 4 && p.anytime >= 0.15)));
  const top = everyone.sort((a, b) => (rank[b.badge] || 0) - (rank[a.badge] || 0) || b.anytime - a.anytime)[0];
  assert.equal(body.best.playerId, top.id);
  assert.equal(body.best.badge, top.badge);
  assert.equal(body.snapshot.saved, 0);
  // Logos: the feed's dark logo, else the NHL asset path; moneyline lean strength by the favourite's chance.
  for (const g of body.games) for (const t of [g.home, g.away]) assert.ok(t.logo.startsWith('data:image/svg+xml') || t.logo === `https://assets.nhle.com/logos/nhl/svg/${t.abbrev}_dark.svg`);
  for (const g of body.games) { const e = Math.abs(g.pHome - 0.5); assert.equal(g.leans.moneyline.tier, e >= 0.12 ? 'strong' : e >= 0.05 ? 'lean' : 'tossup'); }
  // Records come from the standings (W-L-OT), matching the season's finished games.
  const { standingsAt } = require('./fixtures');
  const official = new Map(standingsAt(world, world.today).map(r => [r.teamAbbrev.default, r]));
  for (const g of body.games) for (const t of [g.home, g.away]) {
    const o = official.get(t.abbrev);
    assert.deepEqual([t.record.w, t.record.l, t.record.otl, t.record.pts, t.record.source], [o.wins, o.losses, o.otLosses, o.points, 'standings']);
  }
});

test('starters: injured number one not projected; manual pick re-simulates the game', async () => {
  const body = (await call('slate')).body, team = world.hurt.abbrev;
  // The injured number one still has the most starts in the last 12, but wasn't dressed last game.
  const { loadHistory } = require('../lib/store'), { prepare, projectStarter, teamGoalies } = require('../lib/ratings');
  const prep = prepare((await loadHistory({ before: world.today })).games);
  const recent = prep.teams.get(team).slice(-12);
  assert.ok(recent.filter(r => r.starter === world.hurt.G[0].id).length >= 3, 'fixture: he started plenty before the injury');
  const proj = projectStarter(prep, team, world.today);
  assert.equal(proj.id, world.hurt.G[1].id, 'the backup who has been starting is projected');
  assert.ok(teamGoalies(prep, team, world.today).some(o => o.id === world.hurt.callup.id), 'the call-up shows up as an option');
  // Pick a different starter for the first game's home side: that game re-simulates with him.
  const g0 = body.games[0], other = g0.goalies.home.options.find(o => o.id !== g0.goalies.home.id);
  const picked = (await call('slate', { query: { starters: `${g0.home.abbrev}:${other.id}` } })).body.games[0];
  assert.equal(picked.goalies.home.id, other.id);
  assert.equal(picked.goalies.home.projection.manual, true);
  assert.notEqual(picked.pHome, g0.pHome);
  assert.equal(picked.snapshot, undefined);
  // The SGP route prices against the same pick.
  const t = (await call('sgp', { body: { starters: `${g0.home.abbrev}:${other.id}`, legs: [{ game: g0.id, market: 'ml', side: 'home' }] } })).body;
  assert.ok(Math.abs(t.joint - picked.pHome) < 1e-9);
  // Without a database, the shared-pick route says so.
  assert.equal((await call('starters', { body: { team: g0.home.abbrev, goalieId: other.id } })).code, 400);
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
  assert.equal(bt.tags.reduce((s, t) => s + t.n, 0), bt.anytime.n, 'every scored player-game lands in one tag group');
  assert.equal(bt.moneyline.byTier.reduce((s, t) => s + t.n, 0), bt.games, 'every game lands in one lean strength');
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
