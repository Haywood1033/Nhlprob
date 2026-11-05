// lib/backtest.js — leak-free backtest over recent game days. Each day's games are predicted the
// way the live app predicts them: lineups from each team's previous game, the projected starter,
// and every rating built only on earlier games. Then the predictions are scored:
//   moneyline       log loss vs the league's home win rate
//   totals          Brier at 5.5 and 6.5 vs the base rate; error of the model total
//   anytime goal    log loss and calibration vs each player's raw goals-per-game this season
//                   (the obvious number a bettor would use), for players who actually dressed
//   first goal      log loss of the actual first scorer vs an even split across the lineups
//   goalie saves    error vs his season saves-per-start, and how often the 10–90% range held,
//                   when the projected starter actually started
//   shots on goal   error vs the player's season shots per game

const { loadHistory } = require('./store');
const { prepare, leagueAt, sideFor } = require('./ratings');
const { simulateGame, summarizeGame, summarizePlayer, summarizeSaves } = require('./simulator');
const { simSide } = require('./slate');
const { hashSeed } = require('./rng');
const { signalsFor } = require('./signals');
const { ML_TIERS, mlTier } = require('./lean');
const { calibrate } = require('./calibration');
const { daysBetween } = require('./ratings');
const SH = require('./sharp');

const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const BINS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0001];

async function runBacktest({ days = 20, sims = 2500, history = null } = {}) {
  const hist = history || await loadHistory();
  const prep = prepare(hist.games);
  const dates = [...new Set(prep.games.map(g => g.date))];
  // Leave a warm-up: at least ~150 games of history before the first scored day.
  const firstOk = prep.games[Math.min(prep.games.length - 1, 150)]?.date;
  const target = dates.filter(d => d > firstOk).slice(-days);
  const ml = [], tot = [], any = [], first = [], saves = [], sog = [], sharp = [];
  let homeWins = 0, seen = 0;
  for (const g of prep.games) { if (g.date >= (target[0] || '9999')) break; seen++; if (g.homeScore > g.awayScore) homeWins++; }
  const perDay = [];
  for (const date of target) {
    const lg = leagueAt(prep, date), baseHome = seen ? homeWins / seen : 0.53;
    const games = prep.games.filter(g => g.date === date);
    let right = 0, n = 0;
    const night = []; // Best plays candidates for this date (lib/sharp), capped per night below
    for (const g of games) {
      const H = sideFor(prep, g.home, g.away, date, lg), A = sideFor(prep, g.away, g.home, date, lg);
      if (!H.skaters.length || !A.skaters.length) continue;
      const input = { id: g.id, playoff: g.gameType === 3, home: simSide(H, A, lg, true), away: simSide(A, H, lg, false), lg };
      const sim = simulateGame(input, { sims, seed: hashSeed(`bt|${g.id}`) });
      const s = summarizeGame(sim);
      const homeWon = g.homeScore > g.awayScore ? 1 : 0;
      ml.push({ p: s.pHome, y: homeWon, base: baseHome, tier: mlTier(s.pHome), date });
      if ((s.pHome >= 0.5) === (homeWon === 1)) right++; n++;
      const total = g.homeScore + g.awayScore;
      tot.push({ mean: s.total.mean, actual: total, p55: s.total.over[5.5], p65: s.total.over[6.5] });
      // Players: only those who dressed (books void scratches).
      const dressed = new Map(g.skaters.map(p => [p.id, p]));
      const firstId = g.goals?.[0]?.playerId ?? null;
      let firstP = null;
      const all = [...H.skaters, ...A.skaters];
      all.forEach((p, i) => {
        const actual = dressed.get(p.id);
        const ps = summarizePlayer(sim, i);
        if (p.id === firstId) firstP = ps.first;
        if (!actual) return;
        const gpg = p.season.gp ? p.season.goals / p.season.gp : 0, spg = p.season.gp ? p.season.shots / p.season.gp : null;
        const opp = i < H.skaters.length ? A : H;
        const sig = signalsFor({ ...p, anytime: ps.anytime }, { lg, oppSaPerGame: opp.team.saPerGame, oppGoalieSv: opp.goalie ? opp.goalie.svPct : null, gameTotal: s.total.mean, oppB2b: !!opp.team.last && daysBetween(opp.team.last.date, date) <= 1.01 });
        any.push({ p: ps.anytime, y: actual.goals >= 1 ? 1 : 0, naive: 1 - Math.exp(-gpg), pos: p.pos, badge: sig.badge, count: sig.count });
        // Best plays rules, exactly as lib/plays applies them live.
        const who = { ...p, badge: sig.badge }, scored = actual.goals >= 1 ? 1 : 0;
        const sr = SH.scorerRule(who, ps.anytime); if (sr) night.push({ ...sr, prob: ps.anytime, y: scored });
        const fr = SH.fadeRule(who, ps.anytime); if (fr) night.push({ ...fr, prob: ps.anytime, y: 1 - scored, scored });
        const sl = SH.sogLine(p), so = sl ? ps.shots.over[sl.line] : undefined;
        if (so !== undefined) { const r = SH.sogRule(so); if (r) night.push({ ...r, y: (r.side === 'over' ? actual.shots > sl.line : actual.shots < sl.line) ? 1 : 0 }); }
        if (spg !== null && p.season.gp >= 5) sog.push({ mean: ps.shots.mean, naive: spg, actual: actual.shots });
      });
      // Scored only when the first scorer was in the projected lineups (a missing player is a lineup miss, counted separately).
      if (firstId) first.push({ p: firstP ?? 0, uniform: 1 / Math.max(1, all.length), inLineup: firstP !== null });
      for (const [side, home] of [[H, true], [A, false]]) {
        const actual = g.goalies.find(x => x.starter && x.team === (home ? g.home : g.away));
        if (!side.goalie || !actual || actual.id !== side.goalie.id) continue;
        const sv = summarizeSaves(sim, home);
        const gl = SH.savesLine(side.goalie);
        if (gl) { const arr = home ? sim.svH : sim.svA, w = sim.w; let o = 0, tw = 0; for (let k = 0; k < arr.length; k++) { const x = w ? w[k] : 1; tw += x; if (arr[k] > gl.line) o += x; } const r = SH.savesRule(o / tw); if (r) night.push({ ...r, y: (r.side === 'over' ? actual.saves > gl.line : actual.saves < gl.line) ? 1 : 0 }); }
        saves.push({ mean: sv.mean, naive: side.goalie.season.savesPerStart, actual: actual.saves, inRange: actual.saves >= sv.p10 && actual.saves <= sv.p90 });
      }
    }
    for (const x of SH.capNight(night)) sharp.push({ ...x, date });
    for (const g of games) { seen++; if (g.homeScore > g.awayScore) homeWins++; }
    if (n) perDay.push({ date, games: n, favoritesWon: right });
  }
  const mean = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
  const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
  const base55 = mean(tot, x => (x.actual > 5.5 ? 1 : 0)), base65 = mean(tot, x => (x.actual > 6.5 ? 1 : 0));
  return {
    generatedAt: new Date().toISOString(), source: hist.source, days: perDay.length, games: ml.length,
    moneyline: { accuracy: mean(ml, x => ((x.p >= 0.5) === (x.y === 1) ? 1 : 0)), logLoss: { model: mean(ml, x => ll(x.p, x.y)), base: mean(ml, x => ll(x.base, x.y)) },
      // Each lean strength: how often the favorite won vs how often the model said it would.
      // Calibration fitted on these games (raw model numbers), with an older-half / newer-half check.
      calibration: calibrate(ml),
      byTier: ML_TIERS.map(t => { const r = ml.filter(x => x.tier === t.key); return { tier: t.key, label: t.label, n: r.length, predicted: r.length ? mean(r, x => Math.max(x.p, 1 - x.p)) : null, won: r.length ? mean(r, x => ((x.p >= 0.5) === (x.y === 1) ? 1 : 0)) : null }; }) },
    totals: {
      mae: { model: mean(tot, x => Math.abs(x.mean - x.actual)), base: mean(tot, x => Math.abs(mean(tot, y => y.actual) - x.actual)) },
      brier: { over55: { model: mean(tot, x => (x.p55 - (x.actual > 5.5)) ** 2), base: mean(tot, x => (base55 - (x.actual > 5.5)) ** 2) }, over65: { model: mean(tot, x => (x.p65 - (x.actual > 6.5)) ** 2), base: mean(tot, x => (base65 - (x.actual > 6.5)) ** 2) } },
      rate: { over55: base55, over65: base65 },
    },
    anytime: {
      n: any.length, rate: mean(any, x => x.y),
      logLoss: { model: mean(any, x => ll(x.p, x.y)), naive: mean(any, x => ll(x.naive, x.y)) },
      calibration: BINS.slice(0, -1).map((lo, i) => { const b = any.filter(x => x.p >= lo && x.p < BINS[i + 1]); return { lo, hi: Math.min(1, BINS[i + 1]), n: b.length, predicted: b.length ? mean(b, x => x.p) : null, actual: b.length ? mean(b, x => x.y) : null }; }),
    },
    // How tagged players actually scored, against what the model said for the same players: a tag
    // adds information only if its players beat their own predicted rate.
    tags: ['Elite', 'All-Star', 'Value', null].map(b => { const r = any.filter(x => x.badge === b); return { badge: b || 'No tag', n: r.length, predicted: r.length ? mean(r, x => x.p) : null, actual: r.length ? mean(r, x => x.y) : null }; }),
    bySignals: [0, 1, 2, 3, 4, 5, 6].map(c => { const r = any.filter(x => (c === 6 ? x.count >= 6 : x.count === c)); return { signals: c === 6 ? '6+' : String(c), n: r.length, predicted: r.length ? mean(r, x => x.p) : null, actual: r.length ? mean(r, x => x.y) : null }; }),
    first: { n: first.length, inLineup: mean(first, x => (x.inLineup ? 1 : 0)), logLoss: { model: mean(first.filter(x => x.inLineup), x => -Math.log(clip(x.p))), uniform: mean(first.filter(x => x.inLineup), x => -Math.log(x.uniform)) } },
    saves: { n: saves.length, mae: { model: mean(saves, x => Math.abs(x.mean - x.actual)), naive: mean(saves.filter(x => x.naive), x => Math.abs(x.naive - x.actual)) }, inRange: mean(saves, x => (x.inRange ? 1 : 0)) },
    sog: { n: sog.length, mae: { model: mean(sog, x => Math.abs(x.mean - x.actual)), naive: mean(sog, x => Math.abs(x.naive - x.actual)) } },
    // Best plays: each rule's record over these days. For fades, "hit" means he didn't score, and
    // base/model are his chance to score (so a fade works when he scores below both).
    bestPlays: Object.fromEntries(Object.keys(SH.RULES).map(k => { const r = sharp.filter(x => x.rule === k); return [k, { n: r.length, hit: r.length ? mean(r, x => x.y) : null, model: r.length ? mean(r, x => x.prob) : null, base: r.length && r[0].base !== undefined ? mean(r, x => x.base) : null, scored: k === 'fade' && r.length ? mean(r, x => x.scored) : undefined }]; })),
    perDay: perDay.reverse(),
  };
}

module.exports = { runBacktest };
