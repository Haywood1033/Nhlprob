// No database: a started game's numbers are rebuilt from its pre-game inputs, so its leans, its
// players' chances and the day's best goalscorer play match what showed before puck drop.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NHL_MEMORY_DAYS = '400';
const { installMockFetch } = require('./fixtures');
const { buildSlate } = require('../lib/slate');

const NOW = '2026-11-03T15:00:00Z';
const realNow = Date.now;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; });
test.after(() => { Date.now = realNow; });

const build = async live => { const w = installMockFetch({ now: NOW, live }); try { return (await buildSlate({})).payload; } finally { w.restore(); } };

test('a started game keeps its pre-game numbers without a database', async () => {
  const before = await build(false), after = await build(true);
  const g0 = after.games.find(g => g.state === 'in'), p0 = before.games.find(g => g.id === g0.id);
  assert.ok(g0 && p0 && p0.state === 'pre', 'fixture: the same game, before and after puck drop');
  assert.ok(g0.frozen?.rebuilt, 'rebuilt from pre-game inputs');
  assert.equal(g0.pHome, p0.pHome);
  assert.deepEqual(g0.leans, p0.leans);
  const pre = new Map(p0.players.map(p => [p.id, p.anytime]));
  for (const p of g0.players) if (p.pregame !== false) assert.equal(p.anytime, pre.get(p.id), p.name);
  assert.equal(after.best.playerId, before.best.playerId, 'the day’s pick doesn’t change at puck drop');
  assert.equal(after.best.lockState, 'unsaved');
});
