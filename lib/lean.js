// lib/lean.js — how strong the model's moneyline lean is, by distance of the favorite's win
// chance from a coin flip (nflprob's Strong Lean / Lean / Toss-up, on hockey-sized steps: NHL
// favorites rarely pass 68%, so nflprob's 65% bar would almost never fire). Used on the slate
// and graded the same way on the Accuracy tab.
const ML_TIERS = [{ key: 'strong', label: 'Strong lean', min: 0.12 }, { key: 'lean', label: 'Lean', min: 0.05 }, { key: 'tossup', label: 'Toss-up', min: 0 }];
function mlTier(pHome) { const edge = Math.abs(pHome - 0.5); return ML_TIERS.find(t => edge >= t.min).key; }
module.exports = { ML_TIERS, mlTier };
