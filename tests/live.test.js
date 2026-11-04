// A slate with the first game under way: the day's pick stays on the full slate, and the best
// player still to start is reported separately.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NHL_MEMORY_DAYS = '400';
const { installMockFetch } = require('./fixtures');

const NOW = '2026-11-03T15:00:00Z';
const realNow = Date.now;
let world;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; world = installMockFetch({ now: NOW, live: true }); });
test.after(() => { world.restore(); Date.now = realNow; });

const call = (name, query = {}) => new Promise((resolve, reject) => {
  let code = 200;
  const res = { setHeader() {}, status(c) { code = c; return this; }, json(b) { resolve({ code, body: b }); }, end() { resolve({ code }); } };
  require(`../api/${name}.js`)({ method: 'GET', query }, res).catch(reject);
});

test('best goalscorer play is locked to the whole slate once a game starts', async () => {
  const { body } = await call('slate');
  assert.ok(body.games.some(g => g.state === 'in'), 'fixture: one game live');
  const all = body.games.flatMap(g => g.players.map(p => ({ p, g })));
  const top = all.reduce((a, b) => (b.p.anytime > a.p.anytime ? b : a));
  assert.equal(body.best.playerId, top.p.id, 'chosen from every game, started ones included');
  assert.equal(body.best.locked, true);
  const pre = all.filter(x => x.g.state === 'pre'), topPre = pre.reduce((a, b) => (b.p.anytime > a.p.anytime ? b : a));
  if (topPre.p.id !== top.p.id) assert.equal(body.bestRemaining.playerId, topPre.p.id, 'best still to start reported separately');
  else assert.equal(body.bestRemaining, null);
  // The live game's goals carry scorer ids, which is what the card's live status reads.
  const live = body.games.find(g => g.state === 'in');
  assert.ok(live.live.goals.every(x => x.playerId && x.period));
});
