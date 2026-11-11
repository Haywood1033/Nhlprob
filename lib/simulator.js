// lib/simulator.js — Monte Carlo hockey games, shot by shot. Each run:
//   1. game pace and each team's shot volume get a random draw (some nights are wide open);
//   2. period by period, each team's shots on goal arrive at its rate (its shots for × the
//      opponent's shots allowed, home edge), nudged by the score: the trailing team presses;
//   3. each shot goes to a skater in proportion to his expected shots (shots per 60 × ice
//      time) and beats the goalie at his shooting % scaled by the goalie's save % against
//      the league's; a starter who has let in four or more may get pulled;
//   4. late: a team down one can tie it with the extra attacker (the fitted rate beyond normal
//      play), else a one- or two-goal lead can become an empty-net goal at the league's rate
//      (both measured from the lead at 57:00 in every game); a tie goes to overtime (3-on-3,
//      settled at the league's overtime rate, else a shootout, with both teams' overtime shots
//      counted) or, in the playoffs, sudden-death 5-on-5 periods.
// Everything is recorded per run (score, who scored first, every skater's goals and shots,
// each goalie's saves), so every market and same-game parlay counts from the same games.

const { makeRng } = require('./rng');

// Gamma(shape k, mean 1) via Marsaglia–Tsang — the overdispersion of shot volume.
function gamma1(rng, k) {
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = rng.normal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rng.uniform();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / k;
  }
}
function poisson(rng, mean) {
  if (mean <= 0) return 0;
  if (mean > 40) return Math.max(0, Math.round(mean + rng.normal() * Math.sqrt(mean)));
  let L = Math.exp(-mean), k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}
function pick(cum, u) { let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; } return lo; }

// Shot-volume dispersion: lg.dispK (fitted from history: shots variance beyond chance) is split
// evenly between a shared game pace and each team's own night, so both widen and correlate.
const DEFAULT_K = 60;
const TRAIL = [1, 1.06, 1.1], LEAD = [1, 0.95, 0.92]; // shot-rate multipliers by goals behind / ahead
const PULL = { 4: 0.35, 5: 0.6, 6: 0.8 }; // chance a starter is pulled at a period break after N goals against

// game: { id, playoff, home: Side, away: Side, lg }
// Side: { rate (shots per 60), skaters: [{ id, w (expected shots), sh (goal per shot) }], goalie: { id, sv } }
function simulateGame(game, { sims = 15000, seed = 1 } = {}) {
  const rng = makeRng(seed), S = sims, lg = game.lg;
  const sides = [game.home, game.away];
  const nH = game.home.skaters.length, nA = game.away.skaters.length, N = nH + nA;
  const cum = sides.map(sd => { const t = sd.skaters.reduce((s, p) => s + p.w, 0) || 1; let a = 0; return Float64Array.from(sd.skaters, p => (a += p.w / t)); });
  const shP = sides.map(sd => Float64Array.from(sd.skaters, p => p.sh));
  // Goal share for empty-net and 3-on-3 goals: expected goals, tilted toward the top of the lineup.
  const gcum = sides.map(sd => { const ws = sd.skaters.map(p => p.w * p.sh * (p.toi ? Math.pow(p.toi / 17, 1.5) : 1)); const t = ws.reduce((a, b) => a + b, 0) || 1; let a = 0; return Float64Array.from(ws, x => (a += x / t)); });
  const gFactor = sides.map((_, i) => { const g = sides[1 - i].goalie; return g ? (1 - g.sv) / (1 - lg.svPct) : 1; }); // facing the other side's goalie
  const out = {
    id: game.id, sims: S, nHome: nH, players: [...game.home.skaters.map(p => p.id), ...game.away.skaters.map(p => p.id)],
    hg: new Uint8Array(S), ag: new Uint8Array(S), regH: new Uint8Array(S), regA: new Uint8Array(S), p1H: new Uint8Array(S), p1A: new Uint8Array(S),
    ending: new Uint8Array(S), // 0 regulation, 1 overtime, 2 shootout
    firstTeam: new Uint8Array(S), firstScorer: new Int16Array(S), // firstTeam: 0 home, 1 away, 2 no goal
    goals: new Uint8Array(N * S), shots: new Uint8Array(N * S), // [player * S + run]
    svH: new Uint8Array(S), svA: new Uint8Array(S), saH: new Uint8Array(S), saA: new Uint8Array(S), // home / away starter
    sogH: new Uint8Array(S), sogA: new Uint8Array(S),
  };
  const off = [0, nH];
  const K = lg.dispK || DEFAULT_K;
  for (let k = 0; k < S; k++) {
    const pace = gamma1(rng, 2 * K);
    const vol = [game.home.rate * pace * gamma1(rng, 2 * K), game.away.rate * pace * gamma1(rng, 2 * K)];
    const sc = [0, 0], ga = [0, 0], saved = [0, 0], faced = [0, 0], sog = [0, 0], pulled = [false, false];
    let firstT = Infinity, firstTeam = 2, firstP = -1;
    const otShots = mins => { for (const s of [0, 1]) { const n = poisson(rng, vol[s] * mins / 60), g = 1 - s; for (let j = 0; j < n; j++) { const i = pick(cum[s], rng.uniform()); out.shots[(off[s] + i) * S + k]++; sog[s]++; if (!pulled[g]) { saved[g]++; faced[g]++; } } } };
    const shoot = (s, from, len, rateMult) => { // one team's shots over [from, from+len) minutes
      const n = poisson(rng, (vol[s] * len / 60) * rateMult);
      let goalsHere = 0;
      for (let j = 0; j < n; j++) {
        const i = pick(cum[s], rng.uniform()), t = from + rng.uniform() * len;
        out.shots[(off[s] + i) * S + k]++; sog[s]++;
        const g = 1 - s; // defending side
        const factor = pulled[g] ? 1 : gFactor[s];
        if (rng.uniform() < Math.min(0.6, shP[s][i] * factor)) {
          out.goals[(off[s] + i) * S + k]++; sc[s]++; goalsHere++;
          if (!pulled[g]) ga[g]++;
          if (t < firstT) { firstT = t; firstTeam = s; firstP = off[s] + i; }
        } else if (!pulled[g]) saved[g]++;
        if (!pulled[g]) faced[g]++;
      }
      return goalsHere;
    };
    for (let per = 0; per < 3; per++) {
      const d = sc[0] - sc[1];
      const m = [d < 0 ? TRAIL[Math.min(2, -d)] : LEAD[Math.min(2, d)], d > 0 ? TRAIL[Math.min(2, d)] : LEAD[Math.min(2, -d)]];
      // Shots for both teams across the period; first-goal timing compares within the period.
      shoot(0, per * 20, 20, m[0]); shoot(1, per * 20, 20, m[1]);
      if (per === 0) { out.p1H[k] = sc[0]; out.p1A[k] = sc[1]; }
      if (per < 2) for (const g of [0, 1]) { const p = PULL[Math.min(6, ga[g])]; if (!pulled[g] && p && rng.uniform() < p) pulled[g] = true; }
    }
    // Late: down one, the extra attacker ties it at the fitted extra rate; otherwise the leader may
    // add an empty-netter at the league rate for that lead.
    const fx = lg.effects || {};
    const lead = sc[0] - sc[1], L = Math.abs(lead);
    if (fx.late && L === 1 && lg.late?.tieExtra && rng.uniform() < lg.late.tieExtra) {
      const s = lead > 0 ? 1 : 0, g = 1 - s, i = pick(gcum[s], rng.uniform());
      out.goals[(off[s] + i) * S + k]++; out.shots[(off[s] + i) * S + k]++; sog[s]++; sc[s]++;
      if (!pulled[g]) { ga[g]++; faced[g]++; }
    } else if ((L === 1 || L === 2) && rng.uniform() < lg.en[L]) {
      const s = lead > 0 ? 0 : 1, i = pick(gcum[s], rng.uniform());
      out.goals[(off[s] + i) * S + k]++; out.shots[(off[s] + i) * S + k]++; sog[s]++; sc[s]++;
    }
    out.regH[k] = sc[0]; out.regA[k] = sc[1];
    let ending = 0;
    if (sc[0] === sc[1]) {
      if (game.playoff) {
        // Sudden death: 20-minute periods at the regular rate until someone scores.
        for (let p = 0; p < 6 && sc[0] === sc[1]; p++) {
          const before = sc[0] + sc[1];
          const n0 = poisson(rng, vol[0] / 3), n1 = poisson(rng, vol[1] / 3);
          const ev = [];
          for (let j = 0; j < n0; j++) ev.push([rng.uniform(), 0]);
          for (let j = 0; j < n1; j++) ev.push([rng.uniform(), 1]);
          ev.sort((a, b) => a[0] - b[0]);
          for (const [u, s] of ev) {
            const i = pick(cum[s], rng.uniform()); out.shots[(off[s] + i) * S + k]++; sog[s]++;
            const g = 1 - s;
            if (rng.uniform() < Math.min(0.6, shP[s][i] * (pulled[g] ? 1 : gFactor[s]))) { out.goals[(off[s] + i) * S + k]++; sc[s]++; if (!pulled[g]) { ga[g]++; faced[g]++; } if (firstTeam === 2) { firstTeam = s; firstP = off[s] + i; } break; }
            if (!pulled[g]) { saved[g]++; faced[g]++; }
          }
          if (sc[0] + sc[1] > before) ending = 1;
        }
        if (sc[0] === sc[1]) { const s = rng.uniform() < 0.5 ? 0 : 1; sc[s]++; ending = 1; }
      } else if (rng.uniform() < lg.pOT) {
        // 3-on-3: the stronger finishing side scores more often; the goal goes to a top skater.
        // Shots before the winner: the minutes played (the goal's time, from the league's overtime
        // rate) at each team's shot rate, all saved (the winner is the only goal).
        if (fx.otShots) otShots(Math.min(5, -Math.log(1 - rng.uniform() * lg.pOT) / (-Math.log(1 - lg.pOT) / 5)));
        const e0 = vol[0] * gFactor[0], e1 = vol[1] * gFactor[1];
        const s = rng.uniform() < e0 / (e0 + e1) ? 0 : 1, i = pick(gcum[s], rng.uniform());
        out.goals[(off[s] + i) * S + k]++; out.shots[(off[s] + i) * S + k]++; sog[s]++; sc[s]++;
        if (!pulled[1 - s]) { ga[1 - s]++; faced[1 - s]++; }
        if (firstTeam === 2) { firstTeam = s; firstP = off[s] + i; }
        ending = 1;
      } else {
        if (fx.otShots) otShots(5); // a scoreless 3-on-3 overtime: five minutes of shots, all saved
        // Shootout: a coin flip tilted slightly by the goalies; counts as one goal for the winner.
        const gh = game.home.goalie?.sv ?? lg.svPct, gaw = game.away.goalie?.sv ?? lg.svPct;
        sc[rng.uniform() < 0.5 + 2 * (gh - gaw) ? 0 : 1]++;
        ending = 2;
      }
    }
    out.hg[k] = sc[0]; out.ag[k] = sc[1]; out.ending[k] = ending;
    out.firstTeam[k] = firstTeam; out.firstScorer[k] = firstP;
    out.svH[k] = saved[0]; out.svA[k] = saved[1]; out.saH[k] = faced[0]; out.saA[k] = faced[1];
    out.sogH[k] = sog[0]; out.sogA[k] = sog[1];
  }
  return out;
}

// ── Summaries ────────────────────────────────────────────────────────────────────────────
// Every summary honours optional run weights (sim.w, averaging 1): calibration re-weights the
// simulated games so the favourite wins as often as the backtest says it should, and every market
// (puck line, totals, scorers, saves, parlays) shifts consistently with it. No weights = each run
// counts once, exactly as before.
const countAt = (arr, off, S) => arr.subarray(off * S, off * S + S);
const wAt = (w, k) => (w ? w[k] : 1);
function quant(arr, p, w = null) {
  if (!w) { const s = Uint8Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
  const tot = new Float64Array(256); let all = 0;
  for (let k = 0; k < arr.length; k++) { tot[arr[k]] += w[k]; all += w[k]; }
  let acc = 0; for (let v = 0; v < 256; v++) { acc += tot[v]; if (acc >= p * all) return v; }
  return 255;
}
function overShare(arr, line, w = null) { let n = 0; for (let k = 0; k < arr.length; k++) if (arr[k] > line) n += wAt(w, k); return n / arr.length; }
const meanOf = (a, w = null) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * wAt(w, k); return s / a.length; };

function summarizeGame(sim) {
  const S = sim.sims, w = sim.w || null;
  let hw = 0, plH = 0, plA = 0, ot = 0, so = 0;
  const reg3 = [0, 0, 0], first = [0, 0, 0], dist = new Array(11).fill(0);
  const totals = new Uint8Array(S), p1 = new Uint8Array(S);
  for (let k = 0; k < S; k++) {
    const h = sim.hg[k], a = sim.ag[k], x = wAt(w, k);
    if (h > a) hw += x;
    reg3[sim.regH[k] > sim.regA[k] ? 0 : sim.regH[k] < sim.regA[k] ? 1 : 2] += x;
    if (h - a >= 2) plH += x; if (a - h >= 2) plA += x;
    if (sim.ending[k] === 1) ot += x; if (sim.ending[k] === 2) so += x;
    totals[k] = h + a; p1[k] = sim.p1H[k] + sim.p1A[k]; first[sim.firstTeam[k]] += x; dist[Math.min(10, h + a)] += x;
  }
  const lines = [4.5, 5.5, 6.5, 7.5];
  return {
    pHome: hw / S, pAway: 1 - hw / S, regulation: { home: reg3[0] / S, away: reg3[1] / S, tie: reg3[2] / S },
    puckLine: { homeMinus: plH / S, awayMinus: plA / S, homePlus: 1 - plA / S, awayPlus: 1 - plH / S },
    total: { mean: +meanOf(totals, w).toFixed(2), median: quant(totals, 0.5, w), over: Object.fromEntries(lines.map(l => [l, overShare(totals, l, w)])), dist: dist.map(v => v / S) },
    teamTotal: { home: { mean: +meanOf(sim.hg, w).toFixed(2), over: { 2.5: overShare(sim.hg, 2.5, w), 3.5: overShare(sim.hg, 3.5, w) } }, away: { mean: +meanOf(sim.ag, w).toFixed(2), over: { 2.5: overShare(sim.ag, 2.5, w), 3.5: overShare(sim.ag, 3.5, w) } } },
    firstPeriod: { over: { 0.5: overShare(p1, 0.5, w), 1.5: overShare(p1, 1.5, w) } },
    firstTeam: { home: first[0] / S, away: first[1] / S, none: first[2] / S },
    overtime: ot / S, shootout: so / S,
    sog: { home: +meanOf(sim.sogH, w).toFixed(1), away: +meanOf(sim.sogA, w).toFixed(1) },
  };
}

// One skater: anytime, 2+, first goal, shots on goal distribution.
function summarizePlayer(sim, idx) {
  const S = sim.sims, w = sim.w || null, g = countAt(sim.goals, idx, S), s = countAt(sim.shots, idx, S);
  let any = 0, two = 0, first = 0;
  for (let k = 0; k < S; k++) { const x = wAt(w, k); if (g[k] >= 1) any += x; if (g[k] >= 2) two += x; if (sim.firstScorer[k] === idx) first += x; }
  return { anytime: any / S, twoPlus: two / S, first: first / S, goalsMean: +meanOf(g, w).toFixed(3), shots: { mean: +meanOf(s, w).toFixed(2), over: Object.fromEntries([0.5, 1.5, 2.5, 3.5, 4.5].map(l => [l, overShare(s, l, w)])) } };
}

// A starting goalie's saves (only while he's in net): average, range, overs at lines near the median.
function summarizeSaves(sim, home) {
  const w = sim.w || null, sv = home ? sim.svH : sim.svA, sa = home ? sim.saH : sim.saA;
  const med = quant(sv, 0.5, w), base = Math.round(med) - 0.5;
  const lines = [base - 4, base - 2, base, base + 2, base + 4].filter(x => x > 0);
  return { mean: +meanOf(sv, w).toFixed(1), shotsAgainst: +meanOf(sa, w).toFixed(1), p10: quant(sv, 0.1, w), p50: med, p90: quant(sv, 0.9, w), lines: lines.map(line => ({ line, over: overShare(sv, line, w) })) };
}

// Calibrate a simulated game's moneyline: the backtest-fitted stretch k moves the home win chance
// to σ(k · logit p); home-win runs are weighted p'/p and away-win runs (1−p')/(1−p), so weights
// average exactly 1 and every other market moves with the result. k = 1 leaves the game untouched.
function calibrateWins(sim, k) {
  if (!k || Math.abs(k - 1) < 1e-6) return sim;
  const S = sim.sims; let hw = 0;
  for (let i = 0; i < S; i++) if (sim.hg[i] > sim.ag[i]) hw++;
  const p = hw / S;
  if (p <= 0 || p >= 1) return sim;
  const q = 1 / (1 + Math.exp(-k * Math.log(p / (1 - p))));
  const wh = q / p, wa = (1 - q) / (1 - p), w = new Float32Array(S);
  for (let i = 0; i < S; i++) w[i] = sim.hg[i] > sim.ag[i] ? wh : wa;
  sim.w = w; sim.calibration = { k, raw: p, calibrated: q };
  return sim;
}

module.exports = { simulateGame, summarizeGame, summarizePlayer, summarizeSaves, calibrateWins, overShare, quant, gamma1, poisson, PULL };
