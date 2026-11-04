// GET /api/backtest?days=20 — leak-free backtest over recent game days (lib/backtest).
const { runBacktest } = require('../lib/backtest');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  // Longer windows use fewer runs per game (1,500) to fit the function's time limit; that adds
  // about a point of noise to each probability, which washes out over hundreds of games.
  try { const days = numParam(req, 'days', 20, { min: 3, max: 60 }); send(res, 200, await runBacktest({ days, sims: days > 20 ? 1500 : 2500 }), 600); } catch (err) { fail(res, err); }
};
