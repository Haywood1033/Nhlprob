// lib/sharp.js — the rules behind Best plays. Each one picks out a spot where the model disagrees
// with the number a bettor (and a book's opening line) anchors to — the player's own season rate —
// by enough that the disagreement has held up in backtests. Plays that are simply likely (a star's
// usual 35% to score, a heavy favorite) are not plays here: their price already says so.
//
// Rules, set on 195 game days (Oct 2025 – Nov 2026, leak-free, each half checked separately):
//   Goalscorer edge  anytime 20%+ and 1.25× or more his season scoring rate; top 3 a night.
//                    Scored 24.3% vs 16.5% from their season rates (449 picks).
//   Elite tag        6+ signals firing and 20%+ (lib/signals). Scored 45.7% vs 37.8% model (116).
//   Fade             a scorer whose season rate says 28%+, with the model at 0.85× or less tonight.
//                    Scored 23.6% vs 33.6% from their season rates (top 3 a night, 471).
//   Saves over       57%+ over his season saves-per-start line: hit 69% (301).
//   Saves under      65%+ under it: hit 76% (279).
//   Shots under      68%+ under his season shots-per-game line, top 3 a night: hit 72% (544).
//   Shots over       60%+ over it, top 2 a night: hit 60% (346).
// Moneylines, totals and first goalscorers aren't here: without a price the model's favorite is
// just the favorite, and the backtest finds no edge in model-only totals. They show up as value
// plays once prices are pasted.
//
// The same functions grade the backtest (lib/backtest.js), so the record on the Accuracy tab and
// on Best plays is these exact rules, not a description of them.

// League goals per skater-game by position (stable season to season), and how many games of it a
// player's own rate is blended with — the "season rate" a book's opening price is built from.
const POS_GPG = { F: 0.21, D: 0.088 }, PRIOR_GAMES = 8;
const R = {
  edge: { minProb: 0.2, minRatio: 1.25, minGp: 10, perNight: 3 },
  elite: { badge: 'Elite' },
  fade: { minSeason: 0.28, maxRatio: 0.85, minGp: 10, perNight: 3 },
  savesOver: 0.57, savesUnder: 0.65, minStarts: 3,
  sogUnder: 0.68, sogOver: 0.6, sogMinGp: 10, sogMinAvg: 1.2, sogUnderPerNight: 3, sogOverPerNight: 2,
};

const nearestHalf = v => Math.round(v - 0.5) + 0.5;

// Anytime chance implied by his season scoring rate (shrunk toward his position over 8 games).
function seasonRate(p) {
  const s = p.season || {}, lg = POS_GPG[p.pos === 'D' ? 'D' : 'F'];
  return 1 - Math.exp(-(((s.goals || 0) + PRIOR_GAMES * lg) / ((s.gp || 0) + PRIOR_GAMES)));
}
function sogLine(p) { const s = p.season || {}; if ((s.gp || 0) < R.sogMinGp) return null; const avg = s.shots / s.gp; return avg >= R.sogMinAvg ? { line: nearestHalf(avg), avg } : null; }
function savesLine(G) { const s = G.season || {}; return s.savesPerStart && (s.gs || 0) >= R.minStarts ? { line: nearestHalf(s.savesPerStart), avg: s.savesPerStart } : null; }

// p: { pos, season: { gp, goals }, badge }, anytime: model chance. → { rule, ratio, base } | null
function scorerRule(p, anytime) {
  const base = seasonRate(p), ratio = anytime / base, gp = p.season?.gp || 0;
  if (gp < R.edge.minGp) return null;
  if (p.badge === R.elite.badge) return { rule: 'elite', base, ratio };
  if (anytime >= R.edge.minProb && ratio >= R.edge.minRatio) return { rule: 'edge', base, ratio };
  return null;
}
function fadeRule(p, anytime) {
  const base = seasonRate(p), ratio = anytime / base;
  return (p.season?.gp || 0) >= R.fade.minGp && base >= R.fade.minSeason && ratio <= R.fade.maxRatio ? { rule: 'fade', base, ratio } : null;
}
// overProb: model chance of going over `line`. → { rule, side, prob } | null
function savesRule(overProb) {
  if (overProb >= R.savesOver) return { rule: 'savesOver', side: 'over', prob: overProb };
  if (1 - overProb >= R.savesUnder) return { rule: 'savesUnder', side: 'under', prob: 1 - overProb };
  return null;
}
function sogRule(overProb) {
  if (1 - overProb >= R.sogUnder) return { rule: 'sogUnder', side: 'under', prob: 1 - overProb };
  if (overProb >= R.sogOver) return { rule: 'sogOver', side: 'over', prob: overProb };
  return null;
}

// Nightly caps: which of one night's qualifiers are shown (and graded). Each entry needs
// { rule, prob, base? }; edges rank by points over the season rate, fades by points under it,
// shots by the model's chance. Elite tags and saves plays are few enough to show them all.
const CAPS = { edge: R.edge.perNight, fade: R.fade.perNight, sogUnder: R.sogUnderPerNight, sogOver: R.sogOverPerNight };
function capNight(items) {
  const by = {};
  for (const x of items) (by[x.rule] ||= []).push(x);
  const key = { edge: x => x.prob - x.base, fade: x => x.base - x.prob, sogUnder: x => x.prob, sogOver: x => x.prob };
  return Object.entries(by).flatMap(([rule, xs]) => (CAPS[rule] ? xs.sort((a, b) => key[rule](b) - key[rule](a)).slice(0, CAPS[rule]) : xs));
}

const RULES = {
  edge: { label: 'Goalscorer edge', short: 'Edge', what: 'Anytime 20%+ and at least 1.25× his season scoring rate (top 3 a night)', baseLabel: 'season rate' },
  elite: { label: 'Elite tag', short: 'Elite', what: '6+ of the 8 signals firing with a 20%+ chance', baseLabel: 'model' },
  fade: { label: 'Fade', short: 'Fade', what: 'His season rate says 28%+, the model is 15%+ below it tonight (top 3)', baseLabel: 'season rate' },
  savesOver: { label: 'Saves over', short: 'Saves O', what: '57%+ over his season saves-per-start line', baseLabel: 'model' },
  savesUnder: { label: 'Saves under', short: 'Saves U', what: '65%+ under his season saves-per-start line', baseLabel: 'model' },
  sogUnder: { label: 'Shots under', short: 'SOG U', what: '68%+ under his season shots-per-game line (top 3)', baseLabel: 'model' },
  sogOver: { label: 'Shots over', short: 'SOG O', what: '60%+ over his season shots-per-game line (top 2)', baseLabel: 'model' },
};
// The record these rules set when they were fixed (see the header): shown until a backtest saves a fresher one.
const SET_RECORD = {
  window: '195 game days, Oct 2025 – Nov 2026',
  edge: { n: 449, hit: 0.243, model: 0.238, base: 0.165 }, elite: { n: 116, hit: 0.457, model: 0.378, base: 0.361 },
  fade: { n: 471, hit: 0.764, model: 0.258, base: 0.336, scored: 0.236 },
  savesOver: { n: 301, hit: 0.694, model: 0.649 }, savesUnder: { n: 279, hit: 0.763, model: 0.728 },
  sogUnder: { n: 544, hit: 0.722, model: 0.772 }, sogOver: { n: 346, hit: 0.595, model: 0.651 },
};

module.exports = { R, RULES, SET_RECORD, POS_GPG, seasonRate, sogLine, savesLine, scorerRule, fadeRule, savesRule, sogRule, capNight, nearestHalf };
