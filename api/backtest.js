// GET /api/backtest?days=20 — leak-free backtest over recent game days (lib/backtest).
const { runBacktest } = require('../lib/backtest');
const { saveCalibration, saveBestRecord } = require('../lib/store');
const db = require('../lib/db');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  // Longer windows use fewer runs per game (1,500) to fit the function's time limit; that adds
  // about a point of noise to each probability, which washes out over hundreds of games.
  // With a database, a run over 150+ games saves the fitted moneyline calibration, which the slate
  // then applies (shrunk by sample size; see lib/calibration.js).
  try {
    const days = numParam(req, 'days', 20, { min: 3, max: 60 });
    const bt = await runBacktest({ days, sims: days > 20 ? 1500 : 2500 });
    const c = bt.moneyline.calibration;
    bt.calibrationSaved = false;
    if (db.hasDb && c && c.kFit !== null && c.n >= 150) { try { bt.calibrationSaved = await saveCalibration(c); require('../lib/slate').clearSlateCache(); } catch (err) { bt.calibrationError = err.message; } }
    // Best plays rule record: saved on every run with a database (the tab shows its window).
    if (db.hasDb && bt.bestPlays) { try { bt.bestPlaysSaved = await saveBestRecord(bt.bestPlays, bt.days); } catch (err) { bt.bestPlaysError = err.message; } }
    send(res, 200, bt);
  } catch (err) { fail(res, err); }
};
