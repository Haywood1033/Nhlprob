// lib/calibration.js — moneyline calibration fitted by the backtest. The model's win chances can sit
// too close to 50/50 (team strength beyond shot rates and goalies isn't fully in the shot model), so
// the backtest fits a stretch k: calibrated p = σ(k · logit p). k > 1 widens favourites, k < 1
// pulls them in, k = 1 changes nothing.
//
// What's applied is shrunk toward 1 by sample size, k_applied = 1 + (k_fit − 1) · n / (n + 400),
// and k is searched only between 0.7 and 1.3: a few hundred games can't support a bigger stretch,
// and an early fit once reached 2.2 on a slice of ~20 strong leans.
//
// The fit is checked honestly: fitted on the older half of the games, scored on the newer half.
// It is only used live when that held-out check improves log loss by at least MIN_GAIN; otherwise
// the saved value is k = 1 (no stretch) and the Accuracy tab says the check failed. A bootstrap over
// the games gives a range for k_fit, so a "k = 1.2" from a small sample reads as the guess it is.

const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
const stretch = (p, k) => 1 / (1 + Math.exp(-k * logit(p)));
const logLoss = (rows, k) => rows.reduce((s, r) => s - (r.y ? Math.log(clip(stretch(r.p, k))) : Math.log(1 - clip(stretch(r.p, k)))), 0) / rows.length;
const K_MIN = 0.7, K_MAX = 1.3;
const GRID = Array.from({ length: 25 }, (_, i) => +(K_MIN + i * 0.025).toFixed(3)); // 0.700 … 1.300
const SHRINK = 400;
const MIN_GAIN = 0.0005; // held-out log loss must fall by at least this much per game
const BOOT = 200;

function fitStretch(rows) {
  if (rows.length < 30) return null;
  let best = { k: 1, ll: logLoss(rows, 1) };
  for (const k of GRID) { const ll = logLoss(rows, k); if (ll < best.ll) best = { k, ll }; }
  return best.k;
}

// Deterministic bootstrap (fixed LCG) so the same games always give the same range.
function bootstrapRange(rows) {
  let s = 12345; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ks = [];
  for (let b = 0; b < BOOT; b++) { const sample = rows.map(() => rows[Math.floor(rnd() * rows.length)]); ks.push(fitStretch(sample)); }
  ks.sort((a, b) => a - b);
  return { lo: ks[Math.floor(0.05 * BOOT)], hi: ks[Math.floor(0.95 * BOOT)] };
}

// rows: [{ p (home win chance), y (home won), date }] → fit, applied value, the held-out check, and
// whether it passed (use: the value to apply live).
function calibrate(rows) {
  if (rows.length < 60) return { n: rows.length, kFit: null, kApplied: 1, use: 1, passed: false, note: 'Too few games to fit a calibration.' };
  const kFit = fitStretch(rows), n = rows.length;
  const kApplied = +(1 + (kFit - 1) * n / (n + SHRINK)).toFixed(3);
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const older = sorted.slice(0, Math.floor(n / 2)), newer = sorted.slice(Math.floor(n / 2));
  const kHalf = fitStretch(older), kHalfApplied = 1 + (kHalf - 1) * older.length / (older.length + SHRINK);
  const raw = logLoss(newer, 1), cal = logLoss(newer, kHalfApplied);
  const passed = raw - cal >= MIN_GAIN;
  return {
    n, kFit, kApplied, range: bootstrapRange(rows), passed, use: passed ? kApplied : 1,
    check: { fitOn: older.length, testedOn: newer.length, kFit: kHalf, kApplied: +kHalfApplied.toFixed(3), raw, calibrated: cal, gain: +(raw - cal).toFixed(5), minGain: MIN_GAIN },
    note: passed ? null : `The held-out check didn't improve by ${MIN_GAIN} log loss per game, so no stretch is applied (k = 1).`,
  };
}

module.exports = { calibrate, fitStretch, stretch, logLoss, SHRINK, K_MIN, K_MAX, MIN_GAIN };
