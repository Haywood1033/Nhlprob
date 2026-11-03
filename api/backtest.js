// GET /api/backtest?days=20 — leak-free backtest over recent game days (lib/backtest).
const { runBacktest } = require('../lib/backtest');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await runBacktest({ days: numParam(req, 'days', 20, { min: 3, max: 60 }) }), 600); } catch (err) { fail(res, err); }
};
