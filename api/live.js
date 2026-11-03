// GET /api/live?date=YYYY-MM-DD — scores, period, clock and goals for the day (polled while
// games are on; cached 20 seconds at the edge).
const { fetchScores } = require('../lib/nhl');
const { etDate } = require('../lib/store');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, { games: await fetchScores(param(req, 'date') || etDate(), { live: true }) }, 20); } catch (err) { fail(res, err); }
};
