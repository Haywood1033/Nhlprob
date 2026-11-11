// lib/ratings.js — everyone's state as of a date, built only from earlier games (leak-free):
//   team     shots on goal for / against per game, recency-weighted, regressed to the league;
//   skater   ice time (recent role), shots per 60 (regressed to the position rate), shooting %
//            (long memory, heavily regressed: finishing is mostly noise over a few weeks);
//   goalie   save % (long memory, regressed to the league), recent starts;
//   lineup   who dressed in the team's last game, and the projected starting goalie (the
//            recent starter, the backup on the second night of a back-to-back);
//   league   shots per game, shooting % by position (regulation, goalie in net), save %, home shot edge, how often a
//            late lead becomes an empty-net goal, and how often overtime ends before a shootout.

const DAY = 864e5;
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const decay = (d, hl) => Math.pow(0.5, d / hl);
const HL = { team: 50, toi: 14, shots: 90, shPct: 400, sv: 400, league: 365 };
// Fallback priors, used until there's enough history to fit them (leagueAt → lg.prior, below).
const PRIOR = { teamGames: 8, shotMinutes: 240, shPctShots: 70, svShots: 1200 };
// What the fitted pieces of the model do, and which are on. The first four are estimation and bias
// fixes (on). The last four add team-level effects; each switches on only once the backtest's
// side-by-side check (lib/effects) shows it improves predictions on held-out games.
const DEFAULT_EFFECTS = { eb: true, late: true, otShots: true, dispResid: true, team: false, lineup: false, b2b: false, homeFinish: false };

// Empirical-Bayes prior strength from a population of rates: items [{ n, x }] (trials, successes).
// The spread of observed rates beyond binomial noise is the talent spread τ²; the prior worth k
// trials is p̄(1−p̄)/τ² − 1. Clamped, and null when the population is too small to say.
function ebStrength(items, { minN, minItems, lo, hi }) {
  const xs = items.filter(i => i.n >= minN);
  if (xs.length < minItems) return null;
  const N = xs.reduce((s, i) => s + i.n, 0), X = xs.reduce((s, i) => s + i.x, 0), p = X / N;
  const S = xs.reduce((s, i) => s + i.n * (i.x / i.n - p) ** 2, 0), denom = N - xs.reduce((s, i) => s + i.n * i.n, 0) / N;
  const tau2 = (S - (xs.length - 1) * p * (1 - p)) / denom;
  if (!(tau2 > 0)) return hi;
  return Math.round(Math.min(hi, Math.max(lo, p * (1 - p) / tau2 - 1)));
}

function prepare(games) {
  const teams = new Map(), skaters = new Map(), goalies = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
  const sorted = [...games].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  for (const g of sorted) {
    for (const [me, op, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const sf = home ? g.homeSog : g.awaySog, sa = home ? g.awaySog : g.homeSog;
      const gf = home ? g.homeScore : g.awayScore, ga = home ? g.awayScore : g.homeScore;
      const dressed = g.skaters.filter(p => p.team === me);
      const starter = g.goalies.find(p => p.team === me && p.starter) || g.goalies.filter(p => p.team === me).sort((x, y) => y.toi - x.toi)[0] || null;
      push(teams, me, { date: g.date, gameId: g.id, opp: op, home, sf, sa, gf, ga, ot: g.outcome === 'OT' || g.outcome === 'SO', regular: g.gameType !== 3, skaters: dressed.map(p => p.id), goalies: g.goalies.filter(p => p.team === me).map(p => p.id), starter: starter?.id ?? null, name: home ? g.homeName : g.awayName });
    }
    // Empty-net and overtime goals are added by the simulator on their own, so finishing is rated
    // on regulation goals against a goalie (each such goal also removes its shot).
    const extra = new Map();
    for (const q of g.goals || []) if (q.emptyNet || q.period > 3) extra.set(q.playerId, (extra.get(q.playerId) || 0) + 1);
    for (const p of g.skaters) { const x = Math.min(p.goals, extra.get(p.id) || 0); push(skaters, p.id, { date: g.date, gameId: g.id, team: p.team, opp: p.team === g.home ? g.away : g.home, name: p.name, pos: p.pos, toi: p.toi, shots: p.shots, goals: p.goals, ppg: p.ppg || 0, assists: p.assists || 0, shotsVsG: Math.max(0, p.shots - x), goalsVsG: p.goals - x }); }
    for (const p of g.goalies) push(goalies, p.id, { date: g.date, gameId: g.id, team: p.team, opp: p.team === g.home ? g.away : g.home, name: p.name, toi: p.toi, sa: p.shotsAgainst, sv: p.saves, starter: p.starter });
  }
  return { games: sorted, teams, skaters, goalies };
}

const before = (arr, date) => (arr || []).filter(r => r.date < date);

// League rates from the year before `date`, plus the fitted pieces of the model (priors, late-game
// rates, back-to-back and home finishing effects). effects: which of them the simulation applies.
function leagueAt(prep, date, effects = DEFAULT_EFFECTS) {
  let w = 0, sog = 0, homeSog = 0, awaySog = 0, hw = 0;
  const pos = { F: { g: 0, s: 0 }, D: { g: 0, s: 0 } };
  let sv = 0, sa = 0, ot = 0, otGoal = 0;
  const en = { 1: { n: 0, hit: 0 }, 2: { n: 0, hit: 0 } };
  let goalsW = 0, goals = 0;
  for (const g of prep.games) {
    if (g.date >= date) break;
    const d = daysBetween(g.date, date);
    if (d > 730) continue;
    const x = decay(d, HL.league);
    if (Number.isFinite(g.homeSog) && Number.isFinite(g.awaySog)) { w += 2 * x; sog += x * (g.homeSog + g.awaySog); homeSog += x * g.homeSog; awaySog += x * g.awaySog; hw += x; }
    goalsW += x; goals += x * ((g.homeScore || 0) + (g.awayScore || 0));
    const extra = new Map();
    for (const q of g.goals || []) if (q.emptyNet || q.period > 3) extra.set(q.playerId, (extra.get(q.playerId) || 0) + 1);
    for (const p of g.skaters) { const k = p.pos === 'D' ? 'D' : 'F', e = Math.min(p.goals, extra.get(p.id) || 0); pos[k].g += x * (p.goals - e); pos[k].s += x * Math.max(0, p.shots - e); }
    for (const p of g.goalies) { sv += x * p.saves; sa += x * p.shotsAgainst; }
    // Overtime: tied after regulation → share settled in overtime rather than a shootout.
    if (g.gameType === 2 && (g.outcome === 'OT' || g.outcome === 'SO')) { ot += x; if (g.outcome === 'OT') otGoal += x; }
    // Empty-net goals: lead after regulation not counting empty-netters, and whether the leader added one.
    if (g.goals?.length && g.outcome === 'REG') {
      const reg = g.goals.filter(q => q.period <= 3);
      const non = reg.filter(q => !q.emptyNet), d0 = non.filter(q => q.team === g.home).length - non.filter(q => q.team === g.away).length;
      const lead = Math.abs(d0);
      if (lead === 1 || lead === 2) { const leader = d0 > 0 ? g.home : g.away; en[lead].n += x; if (reg.some(q => q.emptyNet && q.team === leader)) en[lead].hit += x; }
    }
  }
  const sog60 = w ? sog / w : 30;
  // Shot-volume spread beyond chance: each team-game's shots against that team's season mean;
  // the variance left over after Poisson noise sets how wide the simulator's nights swing.
  const byTeam = new Map();
  for (const g of prep.games) { if (g.date >= date) break; if (daysBetween(g.date, date) > 400) continue; for (const [t, v] of [[g.home, g.homeSog], [g.away, g.awaySog]]) { if (v == null) continue; const a = byTeam.get(t) || []; a.push(v); byTeam.set(t, a); } }
  let rss = 0, nObs = 0, mSum = 0;
  for (const a of byTeam.values()) { if (a.length < 5) continue; const m = a.reduce((x, y) => x + y, 0) / a.length; for (const v of a) { rss += (v - m) ** 2; mSum += m; } nObs += a.length - 1; }
  const meanSog = nObs ? mSum / (nObs + byTeam.size) : sog60, extraVar = nObs ? rss / nObs - meanSog : null;
  const dispK = extraVar && extraVar > 0.5 ? Math.min(400, (meanSog * meanSog) / extraVar) : 400;
  const fit = fitLeague(prep, date, sog60, goalsW ? goals / goalsW : 6.1);
  return {
    effects: { ...DEFAULT_EFFECTS, ...effects }, ...fit,
    sogPerTeam: sog60, homeShotEdge: hw && awaySog ? Math.sqrt(homeSog / awaySog) : 1.02,
    shPct: { F: pos.F.s ? pos.F.g / pos.F.s : 0.105, D: pos.D.s ? pos.D.g / pos.D.s : 0.05 },
    svPct: sa ? sv / sa : 0.9, goalsPerGame: goalsW ? goals / goalsW : 6.1,
    pOT: ot >= 20 ? otGoal / ot : 0.6,
    dispK: +(effects.dispResid !== false && fit.dispKResid ? fit.dispKResid : dispK).toFixed(1), dispKRaw: +dispK.toFixed(1), games: Math.round(hw),
    en: { 1: en[1].n >= 20 ? en[1].hit / en[1].n : 0.3, 2: en[2].n >= 20 ? en[2].hit / en[2].n : 0.22 },
  };
}

// The model's fitted pieces, from the year before `date`:
//   prior       empirical-Bayes prior strengths for shooting % (by position) and save %, from the
//               spread of players' rates beyond chance (they were hand-set at 70 and 1,200 shots)
//   late        from the lead at 57:00 in every game (regulation, overtime and shootout alike): how
//               often a team down one tied it in the last three minutes, beyond what normal play
//               would (the extra attacker). The simulator had no such goal, so late ties ran low.
//               The empty-net rate itself (league, above) stays measured on the lead at the end of
//               regulation, which is exactly where the simulator applies it: a game tied late has
//               no lead there, so leaving it out of that rate is correct, not a bias.
//   b2b         shots for and against on the second night of a back-to-back vs the team's norm
//   homeFinish  home goals per shot on goal vs away (beyond the shot edge)
//   dispKResid  shot-volume spread after allowing for the opponent (the old fit counted opponent
//               and score effects that the simulator adds again, so saves ranges ran wide)
function fitLeague(prep, date, sogPerTeam, goalsPerGame) {
  const yr = prep.games.filter(g => g.date < date && daysBetween(g.date, date) <= 365);
  // Priors.
  const sk = new Map(), gl = new Map();
  for (const g of yr) {
    const extra = new Map();
    for (const q of g.goals || []) if (q.emptyNet || q.period > 3) extra.set(q.playerId, (extra.get(q.playerId) || 0) + 1);
    for (const p of g.skaters) { const e = Math.min(p.goals, extra.get(p.id) || 0), k = p.pos === 'D' ? 'D' : 'F', a = sk.get(p.id) || { pos: k, n: 0, x: 0 }; a.n += Math.max(0, p.shots - e); a.x += p.goals - e; sk.set(p.id, a); }
    for (const p of g.goalies) { const a = gl.get(p.id) || { n: 0, x: 0 }; a.n += p.shotsAgainst; a.x += p.saves; gl.set(p.id, a); }
  }
  const skItems = pos => [...sk.values()].filter(a => a.pos === pos);
  const prior = {
    shPctShots: { F: ebStrength(skItems('F'), { minN: 20, minItems: 60, lo: 40, hi: 800 }), D: ebStrength(skItems('D'), { minN: 20, minItems: 40, lo: 40, hi: 1500 }) },
    svShots: ebStrength([...gl.values()], { minN: 300, minItems: 15, lo: 400, hi: 8000 }),
  };
  // Late game, from the lead at 57:00.
  const late = { 1: { n: 0, en: 0, tie: 0 }, 2: { n: 0, en: 0 } };
  for (const g of yr) {
    if (!g.goals?.length || g.gameType !== 2) continue;
    const before = g.goals.filter(q => q.period <= 3 && q.t < 57), d = before.filter(q => q.team === g.home).length - before.filter(q => q.team === g.away).length, L = Math.abs(d);
    if (L !== 1 && L !== 2) continue;
    const leader = d > 0 ? g.home : g.away, after = g.goals.filter(q => q.period === 3 && q.t >= 57);
    late[L].n++;
    if (after.some(q => q.emptyNet && q.team === leader)) late[L].en++;
    if (L === 1 && after.some(q => !q.emptyNet && q.team !== leader)) late[1].tie++;
  }
  const perTeamMinute = goalsPerGame / 2 / 60, baseTie = 1 - Math.exp(-3 * perTeamMinute * 1.06); // normal play, trailing a bit harder
  const lateFit = { tieExtra: late[1].n >= 60 ? Math.max(0, late[1].tie / late[1].n - baseTie) : 0, observedTie: late[1].n ? late[1].tie / late[1].n : null, baseTie, n: { 1: late[1].n, 2: late[2].n } };
  // Team shot norms for the back-to-back and dispersion fits.
  const norm = new Map();
  for (const g of yr) for (const [t, sf, sa] of [[g.home, g.homeSog, g.awaySog], [g.away, g.awaySog, g.homeSog]]) { if (!Number.isFinite(sf) || !Number.isFinite(sa)) continue; const a = norm.get(t) || { n: 0, sf: 0, sa: 0 }; a.n++; a.sf += sf; a.sa += sa; norm.set(t, a); }
  const mf = t => { const a = norm.get(t); return a && a.n >= 5 ? a.sf / a.n : sogPerTeam; }, ma = t => { const a = norm.get(t); return a && a.n >= 5 ? a.sa / a.n : sogPerTeam; };
  // Back-to-backs: shots on the second night vs each team's norm, shrunk toward no effect.
  const lastPlayed = new Map(), b2b = { n: 0, sf: 0, sfExp: 0, sa: 0, saExp: 0 };
  for (const g of yr) {
    for (const [t, sf, sa] of [[g.home, g.homeSog, g.awaySog], [g.away, g.awaySog, g.homeSog]]) {
      const prev = lastPlayed.get(t);
      if (prev && daysBetween(prev, g.date) <= 1.01 && Number.isFinite(sf) && Number.isFinite(sa)) { b2b.n++; b2b.sf += sf; b2b.sfExp += mf(t); b2b.sa += sa; b2b.saExp += ma(t); }
      lastPlayed.set(t, g.date);
    }
  }
  const K_B2B = 30 * sogPerTeam; // worth 30 games of no effect
  const b2bFit = { n: b2b.n, sfMult: (b2b.sf + K_B2B) / (b2b.sfExp + K_B2B), saMult: (b2b.sa + K_B2B) / (b2b.saExp + K_B2B) };
  // Home finishing: goals per shot against a goalie, home vs away, shrunk toward no effect.
  let hg = 0, hs = 0, ag = 0, as = 0;
  for (const g of yr) {
    const extra = new Map(); for (const q of g.goals || []) if (q.emptyNet || q.period > 3) extra.set(q.playerId, (extra.get(q.playerId) || 0) + 1);
    for (const p of g.skaters) { const e = Math.min(p.goals, extra.get(p.id) || 0); if (p.team === g.home) { hg += p.goals - e; hs += Math.max(0, p.shots - e); } else { ag += p.goals - e; as += Math.max(0, p.shots - e); } }
  }
  // Each side's goals-per-shot is pulled toward the pooled rate by K_HF goals' worth of evidence.
  const K_HF = 400, p0 = hs + as ? (hg + ag) / (hs + as) : 0;
  const homeFinish = p0 ? ((hg + K_HF) / (hs + K_HF / p0)) / ((ag + K_HF) / (as + K_HF / p0)) : 1;
  // Shot dispersion after the opponent: residual variance of each team-game's shots against
  // what that pairing should produce, minus Poisson noise.
  let rss = 0, n = 0, em = 0;
  for (const g of yr) for (const [t, o, v] of [[g.home, g.away, g.homeSog], [g.away, g.home, g.awaySog]]) { if (!Number.isFinite(v)) continue; const e = mf(t) * ma(o) / sogPerTeam; rss += (v - e) ** 2; em += e; n++; }
  const extraVar = n >= 200 ? rss / n - em / n : null;
  // No spread beyond chance once the opponent is allowed for → the most concentrated setting (400).
  const dispKResid = extraVar === null ? null : extraVar > 0.5 ? Math.min(400, (em / n) ** 2 / extraVar) : 400;
  return { prior, late: lateFit, b2b: b2bFit, homeFinish: +homeFinish.toFixed(4), dispKResid: dispKResid && +dispKResid.toFixed(1) };
}

function teamAt(prep, abbrev, date, lg) {
  const rs = before(prep.teams.get(abbrev), date);
  // Shots are weighted only over games that have them: a box score missing its shot totals used to
  // count as a zero-shot game and drag the team's rate down.
  let w = 0, ws = 0, sf = 0, sa = 0, gf = 0, ga = 0;
  for (const r of rs) {
    const x = decay(daysBetween(r.date, date), HL.team); w += x; gf += x * (r.gf || 0); ga += x * (r.ga || 0);
    if (Number.isFinite(r.sf) && Number.isFinite(r.sa)) { ws += x; sf += x * r.sf; sa += x * r.sa; }
  }
  const P = PRIOR.teamGames, L = lg.sogPerTeam, G = lg.goalsPerGame / 2;
  const last = rs.at(-1) || null;
  const season = rs.filter(r => last && r.date >= seasonStart(last.date));
  return {
    abbrev, name: last?.name || abbrev,
    sfPerGame: (sf + P * L) / (ws + P), saPerGame: (sa + P * L) / (ws + P), gfPerGame: (gf + P * G) / (w + P), gaPerGame: (ga + P * G) / (w + P),
    games: rs.length, record: seasonRecord(season),
    last: last ? { date: last.date, gameId: last.gameId, skaters: last.skaters, starter: last.starter } : null,
    recent: rs.slice(-10).reverse().map(r => ({ date: r.date, opp: r.opp, home: r.home, gf: r.gf, ga: r.ga, sf: r.sf, sa: r.sa })),
  };
}
const seasonStart = d => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); return `${m >= 9 ? y : y - 1}-09-01`; };
// Regular-season W-L-OT the NHL way: an overtime or shootout loss is its own column, not a loss.
function seasonRecord(rs) { let w = 0, l = 0, otl = 0; const reg = rs.filter(r => r.regular !== false); for (const r of reg) { if (r.gf > r.ga) w++; else if (r.ot) otl++; else l++; } return { w, l, otl, pts: 2 * w + otl, gp: reg.length, source: 'history' }; }

function skaterAt(prep, id, date, lg) {
  const rs = before(prep.skaters.get(id), date);
  const last = rs.at(-1);
  const pos = last?.pos === 'D' ? 'D' : 'F';
  let tw = 0, toi = 0, sw = 0, sm = 0, ss = 0, gw = 0, gs = 0, gg = 0;
  for (const r of rs) {
    const d = daysBetween(r.date, date);
    const a = decay(d, HL.toi); tw += a; toi += a * r.toi;
    const b = decay(d, HL.shots); sm += b * r.toi; ss += b * r.shots; sw += b;
    const c = decay(d, HL.shPct); gs += c * (r.shotsVsG ?? r.shots); gg += c * (r.goalsVsG ?? r.goals); gw += c;
  }
  const posShots60 = pos === 'D' ? 4.6 : 7.4;
  const shots60 = (60 * ss + PRIOR.shotMinutes * posShots60) / (sm + PRIOR.shotMinutes);
  const kSh = (lg.effects?.eb !== false && lg.prior?.shPctShots?.[pos]) || PRIOR.shPctShots;
  const shPct = (gg + kSh * lg.shPct[pos]) / (gs + kSh);
  const season = rs.filter(r => last && r.date >= seasonStart(last.date));
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    id, name: last?.name || null, team: last?.team || null, pos, games: rs.length,
    toi: tw ? toi / tw : (pos === 'D' ? 19 : 14), shots60, shPct, expShots: shots60 * ((tw ? toi / tw : 14) / 60),
    season: { gp: season.length, goals: sum(season, 'goals'), shots: sum(season, 'shots'), assists: sum(season, 'assists'), ppg: sum(season, 'ppg'), toi: season.length ? sum(season, 'toi') / season.length : 0 },
    last10: rs.slice(-10).reverse().map(r => ({ date: r.date, opp: r.opp, toi: +r.toi.toFixed(1), shots: r.shots, goals: r.goals })),
    raw: { shots: rs.reduce((s, r) => s + r.shots, 0), goals: rs.reduce((s, r) => s + r.goals, 0) },
  };
}

function goalieAt(prep, id, date, lg) {
  const rs = before(prep.goalies.get(id), date);
  let sa = 0, sv = 0;
  for (const r of rs) { const x = decay(daysBetween(r.date, date), HL.sv); sa += x * r.sa; sv += x * r.sv; }
  const P = (lg.effects?.eb !== false && lg.prior?.svShots) || PRIOR.svShots;
  const last = rs.at(-1);
  const season = rs.filter(r => last && r.date >= seasonStart(last.date));
  const sSa = season.reduce((s, r) => s + r.sa, 0), sSv = season.reduce((s, r) => s + r.sv, 0);
  return {
    id, name: last?.name || null, team: last?.team || null, svPct: (sv + P * lg.svPct) / (sa + P),
    games: rs.length, season: { gp: season.length, gs: season.filter(r => r.starter).length, svPct: sSa ? sSv / sSa : null, savesPerStart: season.filter(r => r.starter).length ? season.filter(r => r.starter).reduce((s, r) => s + r.sv, 0) / season.filter(r => r.starter).length : null },
    last10: rs.slice(-10).reverse().map(r => ({ date: r.date, opp: r.opp, sa: r.sa, sv: r.sv, starter: r.starter, toi: +r.toi.toFixed(1) })),
  };
}

// Projected starter: recency-weighted starts over the team's last 12 games (the latest counts
// most, so a new number one or an injury shows up within a game or two), limited to goalies who
// dressed for the last game (a goalie who wasn't even on the bench is hurt or sent down). On the
// second night of a back-to-back, the other dressed goalie if he has started at all lately.
function projectStarter(prep, abbrev, date) {
  const rs = before(prep.teams.get(abbrev), date).slice(-12);
  if (!rs.length) return null;
  const last = rs.at(-1);
  const dressed = new Set(last.goalies?.length ? last.goalies : [last.starter].filter(Boolean));
  const score = new Map(), starts = new Map();
  rs.forEach((r, i) => { if (!r.starter) return; const w = Math.pow(0.8, rs.length - 1 - i); score.set(r.starter, (score.get(r.starter) || 0) + w); starts.set(r.starter, (starts.get(r.starter) || 0) + 1); });
  const all = [...score.entries()].sort((x, y) => y[1] - x[1]);
  const ranked = all.filter(([id]) => dressed.has(id));
  if (!ranked.length) return null;
  const skipped = all[0] && !dressed.has(all[0][0]) ? all[0][0] : null;
  const b2b = daysBetween(last.date, date) <= 1.01;
  const of = rs.length, n = id => starts.get(id) || 0;
  if (b2b && ranked.length > 1 && last.starter === ranked[0][0]) return { id: ranked[1][0], reason: 'Second night of a back-to-back: the backup usually starts', starts: n(ranked[1][0]), of, b2b };
  return { id: ranked[0][0], reason: `Started ${n(ranked[0][0])} of the last ${of}${ranked[0][0] === last.starter ? ', including the last game' : ''}`, starts: n(ranked[0][0]), of, b2b, skipped };
}

// Goalies a team has used lately (for the starter picker): starts in the last 30 games, newest first.
function teamGoalies(prep, abbrev, date) {
  const rs = before(prep.teams.get(abbrev), date).slice(-30);
  const m = new Map();
  rs.forEach(r => { for (const id of r.goalies || [r.starter]) { if (!id) continue; const x = m.get(id) || { id, starts: 0, last: null }; if (r.starter === id) { x.starts++; x.last = r.date; } m.set(id, x); } });
  return [...m.values()].map(x => ({ ...x, name: prep.goalies.get(x.id)?.at(-1)?.name || null })).sort((a, b) => b.starts - a.starts);
}

// Ratings are recomputed many times per date (team factors, lineups, the backtest's variants):
// memoized per prepared history, keyed by kind, id and date.
function memo(prep, key, fn) { if (!prep._memo) prep._memo = new Map(); let v = prep._memo.get(key); if (v === undefined) { v = fn(); prep._memo.set(key, v); } return v; }
const skaterMemo = (prep, id, date, lg) => memo(prep, `s|${id}|${date}|${lg.effects?.eb !== false}`, () => skaterAt(prep, id, date, lg));
const goalieMemo = (prep, id, date, lg) => memo(prep, `g|${id}|${date}|${lg.effects?.eb !== false}`, () => goalieAt(prep, id, date, lg));

// Team finishing (fo) and suppression (fd) as of `date`: over the team's games in the past year
// (recency-weighted), goals against a goalie relative to what its shooters' shooting % and the
// opposing goalies' save % say (fo), and the same for goals it allowed (fd). This is what shot
// quality, special teams and defensive structure add beyond shots and goalies. Shrunk toward 1 by
// an empirical-Bayes spread fitted across the league that day. → Map(team → { fo, fd, games })
function teamFinishAll(prep, date, lg) {
  return memo(prep, `tf|${date}|${lg.effects?.eb !== false}`, () => {
    const acc = new Map(), get = t => { let a = acc.get(t); if (!a) acc.set(t, (a = { gf: 0, ef: 0, ga: 0, ea: 0, games: 0 })); return a; };
    for (const g of prep.games) {
      if (g.date >= date) break;
      const d = daysBetween(g.date, date); if (d > 365) continue;
      const w = decay(d, 100);
      const extra = new Map(); for (const q of g.goals || []) if (q.emptyNet || q.period > 3) extra.set(q.playerId, (extra.get(q.playerId) || 0) + 1);
      const starters = new Map(g.goalies.filter(x => x.starter).map(x => [x.team, x.id]));
      for (const [me, op] of [[g.home, g.away], [g.away, g.home]]) {
        const gid = starters.get(op), G = gid ? goalieMemo(prep, gid, date, lg) : null, gF = G && G.games ? (1 - G.svPct) / (1 - lg.svPct) : 1;
        let goals = 0, exp = 0;
        for (const p of g.skaters) {
          if (p.team !== me) continue;
          const e = Math.min(p.goals, extra.get(p.id) || 0), shots = Math.max(0, p.shots - e);
          goals += p.goals - e;
          if (shots) { const S = skaterMemo(prep, p.id, date, lg); exp += shots * (S.games ? S.shPct : lg.shPct[p.pos === 'D' ? 'D' : 'F']) * gF; }
        }
        const A = get(me), B = get(op);
        A.gf += w * goals; A.ef += w * exp; A.games += w; B.ga += w * goals; B.ea += w * exp;
      }
    }
    // EB spread of the ratios across teams (Poisson noise ≈ 1/expected goals).
    const k = side => {
      const xs = [...acc.values()].map(a => side === 'f' ? [a.gf, a.ef] : [a.ga, a.ea]).filter(([, e]) => e > 20);
      if (xs.length < 10) return 400;
      const r = xs.map(([g, e]) => g / e), m = r.reduce((s, x) => s + x, 0) / r.length;
      const tau2 = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1) - xs.reduce((s, [, e]) => s + 1 / e, 0) / xs.length;
      return tau2 > 0 ? Math.min(1000, Math.max(30, 1 / tau2)) : 1000;
    };
    const kf = k('f'), ka = k('a'), out = new Map();
    for (const [t, a] of acc) out.set(t, { fo: (a.gf + kf) / (a.ef + kf), fd: (a.ga + ka) / (a.ea + ka), games: +a.games.toFixed(1), k: { f: Math.round(kf), a: Math.round(ka) } });
    return out;
  });
}

// Tonight's dressed lineup's expected shots against the team's usual: the same ratings summed over
// whoever dressed in each of its last 10 games. A missing top shooter means fewer team shots, not
// his shots handed to teammates. → ratio, clamped to 0.8–1.2.
function lineupRatio(prep, abbrev, date, lg, skaters) {
  const rs = before(prep.teams.get(abbrev), date).slice(-10);
  if (rs.length < 3 || !skaters.length) return 1;
  const sumOf = ids => ids.reduce((s, id) => { const p = skaterMemo(prep, id, date, lg); return s + (p.games ? p.expShots : 0); }, 0);
  const usual = rs.reduce((s, r) => s + sumOf(r.skaters), 0) / rs.length, tonight = skaters.reduce((s, p) => s + p.expShots, 0);
  return usual > 0 ? Math.min(1.2, Math.max(0.8, tonight / usual)) : 1;
}

// Everything the simulator needs for one side of a game.
// lineup: skater ids from the box score once the game has started (who actually dressed) replace
// the projection from the team's last game.
// starter: { id, name?, source: 'boxscore' | 'manual' } overrides the projection; a goalie with no
// history (a call-up) starts from the league save % with the usual prior.
function sideFor(prep, abbrev, oppAbbrev, date, lg, { starter = null, lineup = null } = {}) {
  const T = teamAt(prep, abbrev, date, lg);
  const ids = lineup?.length ? lineup : T.last?.skaters || [];
  const skaters = ids.map(id => skaterAt(prep, id, date, lg)).filter(p => p.games);
  const proj = starter?.id
    ? (starter.source === 'boxscore' ? { id: starter.id, reason: 'Confirmed by the box score', confirmed: true } : { id: starter.id, reason: 'Starter set by you', manual: true })
    : projectStarter(prep, abbrev, date);
  let G = proj ? goalieAt(prep, proj.id, date, lg) : null;
  if (G && !G.name) G = { ...G, name: starter?.name || `Goalie ${proj.id}`, team: abbrev };
  // The effects simSide may apply (lg.effects decides which): b2b night, team factors, lineup.
  const b2b = !!T.last && daysBetween(T.last.date, date) <= 1.01;
  const fx = lg.effects || {};
  const finish = fx.team ? teamFinishAll(prep, date, lg).get(abbrev) || null : null;
  const lineupR = fx.lineup ? lineupRatio(prep, abbrev, date, lg, skaters) : 1;
  return { team: T, skaters, goalie: G ? { ...G, projection: proj } : null, b2b, finish, lineupRatio: lineupR };
}

// Regulars who sat the team's last game: dressed in 60%+ of its last 10 (at least 3), not in the
// last one, and still with the team (his latest game was for it, so a trade doesn't show). The
// projected lineup is the last game's, so these players are missing from it until puck drop; this
// is a heads-up, not a guess (some are hurt). Newest absences first, then by ice time.
function missedLastGame(prep, abbrev, date, lg) {
  const rs = before(prep.teams.get(abbrev), date).slice(-10);
  if (rs.length < 3) return [];
  const lastIds = new Set(rs.at(-1).skaters), count = new Map();
  for (const r of rs) for (const id of r.skaters) count.set(id, (count.get(id) || 0) + 1);
  const out = [];
  for (const [id, n] of count) {
    if (lastIds.has(id) || n < Math.max(3, Math.ceil(0.6 * rs.length))) continue;
    const p = skaterAt(prep, id, date, lg);
    if (p.team !== abbrev) continue;
    let missed = 0; for (let i = rs.length - 1; i >= 0 && !rs[i].skaters.includes(id); i--) missed++;
    out.push({ id, name: p.name, pos: p.pos, played: n, of: rs.length, missed, lastPlayed: p.last10[0]?.date || null, toi: +p.toi.toFixed(1), season: { gp: p.season.gp, goals: p.season.goals, assists: p.season.assists } });
  }
  return out.sort((a, b) => a.missed - b.missed || b.toi - a.toi).slice(0, 6);
}

module.exports = { teamFinishAll, lineupRatio, prepare, leagueAt, fitLeague, ebStrength, teamAt, skaterAt, goalieAt, projectStarter, teamGoalies, sideFor, missedLastGame, HL, PRIOR, DEFAULT_EFFECTS, daysBetween };
