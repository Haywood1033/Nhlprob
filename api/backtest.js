// GET /api/backtest?days=20 — leak-free backtest over recent game days (lib/backtest), run now.
// GET /api/backtest?latest=1 — the last stored run (the nightly one, or the last button press).
// GET /api/backtest?compare=<effect>&days=7 — test one model effect on vs off (lib/effects).
// GET /api/backtest?effects=1 — which effects are on, and the evidence behind each.
// Public on purpose: anyone can re-run it.
const { saveCalibration, saveBestRecord, saveBacktest, loadBacktest } = require('../lib/store');
const db = require('../lib/db');
const { param, numParam, send, fail } = require('./_util');

// Run, then save what the live app uses: the moneyline calibration (only the stretch that passed its
// held-out check, else k = 1 — lib/calibration), the Best plays record, and the run itself.
async function runAndSave({ days, trigger }) {
  const { runBacktest } = require('../lib/backtest');
  // Longer windows use fewer runs per game (1,500) to fit the function's time limit; that adds
  // about a point of noise to each probability, which washes out over hundreds of games.
  const bt = await runBacktest({ days, sims: days > 20 ? 1500 : 2500 });
  const c = bt.moneyline.calibration;
  bt.calibrationSaved = false;
  if (db.hasDb && c && c.kFit !== null && c.n >= 150) { try { bt.calibrationSaved = await saveCalibration(c); bt.calibrationUsed = c.use; require('../lib/slate').clearSlateCache(); } catch (err) { bt.calibrationError = err.message; } }
  if (db.hasDb && bt.bestPlays) { try { bt.bestPlaysSaved = await saveBestRecord(bt.bestPlays, bt.days); } catch (err) { bt.bestPlaysError = err.message; } }
  if (db.hasDb) { try { await saveBacktest(bt, trigger); bt.stored = true; } catch (err) { bt.storeError = err.message; } }
  return bt;
}

// One model effect on vs off over recent days (lib/effects): stores the per-game evidence that
// decides whether the effect is used live. ?compare=team|lineup|b2b|homeFinish|eb|late|otShots|dispResid
async function compareAndSave({ key, days }) {
  const fx = require('../lib/effects'), { loadHistory } = require('../lib/store');
  const cur = (await fx.loadEffects()).effects;
  const r = await fx.compareEffect({ key, days, sims: 1200, history: await loadHistory(), effects: cur });
  const saved = await fx.saveEvidence(key, r.rows).catch(err => ({ error: err.message }));
  fx.clearEffectsCache();
  const after = (await fx.loadEffects()).detail.find(d => d.key === key);
  if (after.on !== cur[key]) require('../lib/slate').clearSlateCache();
  const { rows, ...rest } = r;
  return { ...rest, saved, decision: after };
}

async function handler(req, res) {
  try {
    if (param(req, 'compare')) return send(res, 200, await compareAndSave({ key: param(req, 'compare'), days: numParam(req, 'days', 7, { min: 2, max: 20 }) }));
    if (param(req, 'effects')) return send(res, 200, await require('../lib/effects').loadEffects());
    if (param(req, 'latest')) { const last = await loadBacktest(); return send(res, 200, last ? { ...last, fromStore: true } : { none: true, note: db.hasDb ? 'No stored run yet: the nightly job saves one, or run it below.' : 'No database connected, so runs aren’t stored.' }); }
    const days = numParam(req, 'days', 20, { min: 3, max: 60 });
    send(res, 200, await runAndSave({ days, trigger: 'button' }));
  } catch (err) { fail(res, err); }
}

module.exports = handler;
module.exports.runAndSave = runAndSave;
module.exports.compareAndSave = compareAndSave;
