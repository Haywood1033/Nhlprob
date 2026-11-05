// lib/sharp.js — the rules behind Best plays, the same shape as nflprob's and hrprob's Sharp Plays:
// conviction from several separate areas lining up, not a price call (there are no book lines).
//
//   Sharp play     an All-Star or Elite tag AND three signal areas firing at once — workload
//                  (🎯 shot volume or ⏱ top-line minutes), matchup (🥅 soft goalie or 🚪 leaky
//                  defense) and form (🔥 hot) — AND a 20%+ anytime chance, on 10+ games this
//                  season. Max 5, Elite → All-Star → signals → chance.
//   Best plays     everything at All-Star or Elite: goalscorers by their tag (lib/signals), goalie
//                  saves and shots on goal by how strongly the model leans against a line at the
//                  player's own season average (books hang theirs close to it).
//   Risks & fades  near misses (4+ signals, 15%+) with a red flag, and big names the model is
//                  well below tonight.
//
// Set on 195 game days (Oct 2025 – Nov 2026), each predicted only from earlier games, and checked
// on each half of that window separately (see SET_RECORD). The backtest (lib/backtest.js) grades
// these same functions, so the record shown is these exact rules.

const POS_GPG = { F: 0.21, D: 0.088 }, PRIOR_GAMES = 8;
const TIERS = ['Elite', 'All-Star', 'Value'];
const tierRank = t => ({ Elite: 3, 'All-Star': 2, Value: 1 }[t] || 0);
// Saves / shots tiers by the model's chance on the lean side (each step hit more often in testing).
const PROP_TIERS = {
  savesOver: [0.68, 0.62, 0.57], savesUnder: [0.75, 0.7, 0.65],
  sogOver: [0.68, 0.64, 0.6], sogUnder: [0.78, 0.73, 0.68],
};
const MIN_GP = 10, SOG_MIN_TOI = 14, SOG_MIN_AVG = 1.2, MIN_STARTS = 3, SHARP_MAX = 5, RISKS_MAX = 5;

const nearestHalf = v => Math.round(v - 0.5) + 0.5;
const on = (p, k) => (p.signals || []).some(s => s.key === k && s.on);
const AREAS = {
  workload: p => on(p, 'volume') || on(p, 'minutes'),
  matchup: p => on(p, 'softGoalie') || on(p, 'leaky'),
  form: p => on(p, 'hot'),
};

// Anytime chance implied by his season scoring rate (shrunk toward his position over 8 games):
// the number a casual read of his stat line starts from.
function seasonRate(p) {
  const s = p.season || {}, lg = POS_GPG[p.pos === 'D' ? 'D' : 'F'];
  return 1 - Math.exp(-(((s.goals || 0) + PRIOR_GAMES * lg) / ((s.gp || 0) + PRIOR_GAMES)));
}

// p: { pos, season, badge, count, signals: [{ key, on }] }, prob: anytime chance (0–1).
function isSharp(p, prob) {
  return (p.season?.gp || 0) >= MIN_GP && tierRank(p.badge) >= 2 && prob >= 0.2 && AREAS.workload(p) && AREAS.matchup(p) && AREAS.form(p);
}
function isNearMiss(p, prob) { return (p.season?.gp || 0) >= MIN_GP && (p.count || 0) >= 4 && prob >= 0.15 && !isSharp(p, prob); }
function isBigNameFade(p, prob) { const base = seasonRate(p); return (p.season?.gp || 0) >= MIN_GP && base >= 0.28 && prob / base <= 0.85; }
// Red flags on a near miss or a big name (strongest first). Only "model below his season rate"
// held up as a warning in testing (24% scored vs 33% from season rates); the others explain why.
function riskFlags(p, prob) {
  const base = seasonRate(p), flags = [];
  if (prob / base <= 0.9) flags.push({ key: 'belowSeason', text: `the model has ${(prob * 100).toFixed(0)}%, below the ${(base * 100).toFixed(0)}% his season rate says` });
  if (!AREAS.matchup(p)) flags.push({ key: 'noMatchup', text: 'no matchup edge: the opposing goalie and defense are average or better' });
  if (!AREAS.workload(p)) flags.push({ key: 'noWorkload', text: 'workload signals off: fewer shots or minutes than a lead scorer' });
  if (!AREAS.form(p)) flags.push({ key: 'noForm', text: 'no hot-form signal' });
  return flags;
}
// A risk only counts with the one flag that predicted anything: the model below his season rate.
function isRisk(p, prob) { return (isNearMiss(p, prob) && prob / seasonRate(p) <= 0.9) || isBigNameFade(p, prob); }

function sogLine(p) { const s = p.season || {}; if ((s.gp || 0) < MIN_GP || (p.toi || 0) < SOG_MIN_TOI) return null; const avg = s.shots / s.gp; return avg >= SOG_MIN_AVG ? { line: nearestHalf(avg), avg } : null; }
function savesLine(G) { const s = G.season || {}; return s.savesPerStart && (s.gs || 0) >= MIN_STARTS ? { line: nearestHalf(s.savesPerStart), avg: s.savesPerStart } : null; }
// overProb at the season-average line → { side, prob, tier } | null
function propTier(market, overProb) {
  for (const side of ['over', 'under']) {
    const prob = side === 'over' ? overProb : 1 - overProb, cuts = PROP_TIERS[`${market}${side === 'over' ? 'Over' : 'Under'}`];
    const i = cuts.findIndex(c => prob >= c);
    if (i >= 0) return { side, prob, tier: TIERS[i] };
  }
  return null;
}

// Tag first, then signals firing (goalscorers), then the chance.
function sortPlays(a, b) { return tierRank(b.tier) - tierRank(a.tier) || (b.count ?? 0) - (a.count ?? 0) || b.prob - a.prob; }

// The record each list set when the rules were fixed (shown until a backtest saves a fresher one).
// Goalscorers and risks: how often they scored, vs the model and vs their season rates.
// Saves and shots: how often the lean hit at the season-average line, vs the model.
const SET_RECORD = {
  window: '195 game days, Oct 2025 – Nov 2026',
  sharp: { n: 250, hit: 0.384, model: 0.348, base: 0.331 },
  scorers: { n: 493, hit: 0.365, model: 0.332, base: 0.317 },
  saves: { n: 338, hit: 0.743, model: 0.724 },
  sog: { n: 910, hit: 0.689, model: 0.728 },
  risks: { n: 746, hit: 0.233, model: 0.259, base: 0.33 },
};

module.exports = { POS_GPG, TIERS, PROP_TIERS, SHARP_MAX, RISKS_MAX, SET_RECORD, AREAS, tierRank, seasonRate, isSharp, isNearMiss, isBigNameFade, isRisk, riskFlags, sogLine, savesLine, propTier, sortPlays, nearestHalf };
