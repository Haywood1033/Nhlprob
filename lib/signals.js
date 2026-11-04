// lib/signals.js — the goalscorer signal system (same idea as hrprob's): eight separate data
// points about a skater's night that each fire or don't, and a tag by how many fire.
//   🎯 Shot volume      3.0+ expected shots (2.6 for a defenseman)
//   ⏱ Top-line minutes  18.5+ minutes a night (23 for a defenseman)
//   🏒 Finisher         shooting % (regressed) ≥ 1.2× his position's, on 60+ career shots
//   🔥 Hot form         3+ goals in his last 5, or last-5 shots a game ≥ 1.25× his season rate
//   🥅 Soft goalie      opposing starter's save % (regressed) ≥ 0.3 points below the league
//   🚪 Leaky defense    opponent allows 1.5+ shots a game more than the league average
//   💥 High-event game  model game total ≥ 0.4 goals over the league average
//   😴 Tired opponent   opponent played yesterday (second night of a back-to-back)
// Tags: Elite 6+, All-Star 5, Value 4 — and a real chance to score (anytime 20%+ for Elite and
// All-Star, 15%+ for Value), so a depth defenseman can't be tagged on matchup alone. The tag is a
// conviction label alongside the probability, not a price call.

const DEFS = [
  { key: 'volume', icon: '🎯', label: 'Shot volume' },
  { key: 'minutes', icon: '⏱', label: 'Top-line minutes' },
  { key: 'finisher', icon: '🏒', label: 'Finisher' },
  { key: 'hot', icon: '🔥', label: 'Hot form' },
  { key: 'softGoalie', icon: '🥅', label: 'Soft goalie' },
  { key: 'leaky', icon: '🚪', label: 'Leaky defense' },
  { key: 'highEvent', icon: '💥', label: 'High-event game' },
  { key: 'tired', icon: '😴', label: 'Tired opponent' },
];
const TIERS = [{ name: 'Elite', min: 6, floor: 0.2 }, { name: 'All-Star', min: 5, floor: 0.2 }, { name: 'Value', min: 4, floor: 0.15 }];
const TIER_RANK = { Elite: 3, 'All-Star': 2, Value: 1 };

// p: { pos, expShots, toi, shPct, raw: { shots }, season: { gp, shots }, last10: [{ goals, shots }], anytime }
// ctx: { lg, oppSaPerGame, oppGoalieSv, gameTotal, oppB2b }
function signalsFor(p, ctx) {
  const D = p.pos === 'D', lg = ctx.lg, last5 = (p.last10 || []).slice(0, 5);
  const g5 = last5.reduce((s, x) => s + x.goals, 0), s5 = last5.length ? last5.reduce((s, x) => s + x.shots, 0) / last5.length : 0;
  const spg = p.season?.gp ? p.season.shots / p.season.gp : null;
  const posSh = lg.shPct[D ? 'D' : 'F'];
  const on = {
    volume: [p.expShots >= (D ? 2.6 : 3.0), `${p.expShots.toFixed(1)} expected shots`],
    minutes: [p.toi >= (D ? 23 : 18.5), `${p.toi.toFixed(1)} min a night`],
    finisher: [(p.raw?.shots || 0) >= 60 && p.shPct >= posSh * 1.2, `${(p.shPct * 100).toFixed(1)}% vs ${(posSh * 100).toFixed(1)}% for his position${(p.raw?.shots || 0) < 60 ? ' (under 60 shots)' : ''}`],
    hot: [last5.length >= 5 && (g5 >= 3 || (spg && p.season.gp >= 8 && s5 >= spg * 1.25)), `${g5} G, ${s5.toFixed(1)} shots a game in his last ${last5.length}`],
    softGoalie: [ctx.oppGoalieSv !== null && ctx.oppGoalieSv <= lg.svPct - 0.003, ctx.oppGoalieSv !== null ? `opposing starter ${(ctx.oppGoalieSv * 100).toFixed(1)}% vs league ${(lg.svPct * 100).toFixed(1)}%` : 'no starter'],
    leaky: [ctx.oppSaPerGame >= lg.sogPerTeam + 1.5, `opponent allows ${ctx.oppSaPerGame.toFixed(1)} shots vs league ${lg.sogPerTeam.toFixed(1)}`],
    highEvent: [ctx.gameTotal >= lg.goalsPerGame + 0.4, `model total ${ctx.gameTotal.toFixed(2)} vs league ${lg.goalsPerGame.toFixed(2)}`],
    tired: [!!ctx.oppB2b, ctx.oppB2b ? 'opponent played yesterday' : 'opponent rested'],
  };
  const signals = DEFS.map(d => ({ ...d, on: !!on[d.key][0], detail: on[d.key][1] }));
  const count = signals.filter(s => s.on).length;
  const tier = TIERS.find(t => count >= t.min && p.anytime >= t.floor);
  return { signals, count, badge: tier ? tier.name : null };
}

const tierRank = b => TIER_RANK[b] || 0;

module.exports = { DEFS, TIERS, signalsFor, tierRank };
