// lib/lean.js — how strong the model's leans are.
//
// Moneyline: by distance of the favorite's win chance from a coin flip (nflprob's Strong Lean /
// Lean / Toss-up, on hockey-sized steps: NHL favorites rarely pass 68%, so nflprob's 65% bar would
// almost never fire). Used on the slate and graded the same way on the Accuracy tab.
const ML_TIERS = [{ key: 'strong', label: 'Strong lean', min: 0.12 }, { key: 'lean', label: 'Lean', min: 0.05 }, { key: 'tossup', label: 'Toss-up', min: 0 }];
function mlTier(pHome) { const edge = Math.abs(pHome - 0.5); return ML_TIERS.find(t => edge >= t.min).key; }

// Totals: a lean only when the model clears that line's usual hit rate by a clear margin. NHL
// scoring is right-skewed (most games land a little under the average), so under 6.5 cashes about
// 56% of the time and over 5.5 about 55% with no model at all: a 54% "under" is weaker than the
// base rate, not a lean. Over 195 backtested days: under 6.5 at 58%+ hit 64% (444 games), over
// 5.5 at 58%+ hit 60% (513); the less common sides need less: over 6.5 at 55%+ hit 57% (83),
// under 5.5 at 55%+ hit 56% (73). Both halves of the window held.
const TOTAL_BARS = [{ line: 6.5, side: 'under', min: 0.58 }, { line: 5.5, side: 'over', min: 0.58 }, { line: 6.5, side: 'over', min: 0.55 }, { line: 5.5, side: 'under', min: 0.55 }];
// over: { 5.5: p, 6.5: p } (chance of going over each line), mean: model total.
// → { line, side, prob } for the clearest qualifying lean, or { line (nearest the model), side: null }.
function totalLean(over, mean) {
  const nearest = Math.abs(mean - 5.5) <= Math.abs(mean - 6.5) ? 5.5 : 6.5;
  const hits = TOTAL_BARS.map(b => { const p = b.side === 'over' ? over[b.line] : 1 - over[b.line]; return { ...b, prob: p, margin: p - b.min }; }).filter(b => Number.isFinite(b.prob) && b.margin >= 0);
  if (!hits.length) return { line: nearest, side: null, prob: null };
  const b = hits.sort((x, y) => y.margin - x.margin)[0];
  return { line: b.line, side: b.side, prob: b.prob };
}

module.exports = { ML_TIERS, mlTier, TOTAL_BARS, totalLean };
