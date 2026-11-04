// lib/calibration.js — moneyline calibration fitted by the backtest. The model's win chances can sit
// too close to 50/50 (team strength beyond shot rates and goalies — shot quality, special teams —
// isn't in the shot model), so the backtest fits a stretch k: calibrated p = σ(k · logit p).
// k > 1 widens favourites, k < 1 pulls them in, k = 1 changes nothing.
//
// What's applied is shrunk toward 1 by sample size, k_applied = 1 + (k_fit − 1) · n / (n + 400),
// so a couple of hundred games move it only part of the way; it fills in as graded games add up.
// The fit is also checked honestly: fit on the older half of the games, scored on the newer half.

const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
const stretch = (p, k) => 1 / (1 + Math.exp(-k * logit(p)));
const logLoss = (rows, k) => rows.reduce((s, r) => s - (r.y ? Math.log(clip(stretch(r.p, k))) : Math.log(1 - clip(stretch(r.p, k)))), 0) / rows.length;
const GRID = Array.from({ length: 33 }, (_, i) => +(0.6 + i * 0.05).toFixed(2)); // 0.60 … 2.20
const SHRINK = 400;

function fitStretch(rows) {
  if (rows.length < 30) return null;
  let best = { k: 1, ll: logLoss(rows, 1) };
  for (const k of GRID) { const ll = logLoss(rows, k); if (ll < best.ll) best = { k, ll }; }
  return best.k;
}

// rows: [{ p (home win chance), y (home won), date }] → fit, applied value and the held-out check.
function calibrate(rows) {
  if (rows.length < 60) return { n: rows.length, kFit: null, kApplied: 1, note: 'Too few games to fit a calibration.' };
  const kFit = fitStretch(rows), n = rows.length;
  const kApplied = +(1 + (kFit - 1) * n / (n + SHRINK)).toFixed(3);
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const older = sorted.slice(0, Math.floor(n / 2)), newer = sorted.slice(Math.floor(n / 2));
  const kHalf = fitStretch(older), kHalfApplied = 1 + (kHalf - 1) * older.length / (older.length + SHRINK);
  return {
    n, kFit, kApplied,
    check: { fitOn: older.length, testedOn: newer.length, kFit: kHalf, kApplied: +kHalfApplied.toFixed(3), raw: logLoss(newer, 1), calibrated: logLoss(newer, kHalfApplied) },
  };
}

module.exports = { calibrate, fitStretch, stretch, SHRINK };
