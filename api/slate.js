// GET /api/slate?date=YYYY-MM-DD — the payload every tab reads: each game's lineups, goalies,
// leans, totals, every skater's goal and shot chances, each starter's saves. No date = today (ET).
const { getSlateContext, parseStarters } = require('../lib/slate');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const date = param(req, 'date');
    if (date && !/^\d{4}-\d\d-\d\d$/.test(date)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
    const { payload } = await getSlateContext({ ...(date ? { date } : {}), starters: parseStarters(param(req, 'starters')) });
    send(res, 200, payload, payload.games.some(g => g.state === 'in') ? 0 : 120);
  } catch (err) { fail(res, err); }
};
