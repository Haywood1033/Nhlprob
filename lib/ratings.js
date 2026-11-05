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
const PRIOR = { teamGames: 8, shotMinutes: 240, shPctShots: 70, svShots: 1200 };

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

// League rates from the year before `date`.
function leagueAt(prep, date) {
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
    w += 2 * x; sog += x * ((g.homeSog || 0) + (g.awaySog || 0)); homeSog += x * (g.homeSog || 0); awaySog += x * (g.awaySog || 0); hw += x;
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
  return {
    sogPerTeam: sog60, homeShotEdge: hw && awaySog ? Math.sqrt(homeSog / awaySog) : 1.02,
    shPct: { F: pos.F.s ? pos.F.g / pos.F.s : 0.105, D: pos.D.s ? pos.D.g / pos.D.s : 0.05 },
    svPct: sa ? sv / sa : 0.9, goalsPerGame: goalsW ? goals / goalsW : 6.1,
    en: { 1: en[1].n >= 20 ? en[1].hit / en[1].n : 0.3, 2: en[2].n >= 20 ? en[2].hit / en[2].n : 0.22 },
    pOT: ot >= 20 ? otGoal / ot : 0.6,
    dispK: +dispK.toFixed(1), games: Math.round(hw),
  };
}

function teamAt(prep, abbrev, date, lg) {
  const rs = before(prep.teams.get(abbrev), date);
  let w = 0, sf = 0, sa = 0, gf = 0, ga = 0;
  for (const r of rs) { const x = decay(daysBetween(r.date, date), HL.team); w += x; sf += x * (r.sf || 0); sa += x * (r.sa || 0); gf += x * (r.gf || 0); ga += x * (r.ga || 0); }
  const P = PRIOR.teamGames, L = lg.sogPerTeam, G = lg.goalsPerGame / 2;
  const last = rs.at(-1) || null;
  const season = rs.filter(r => last && r.date >= seasonStart(last.date));
  return {
    abbrev, name: last?.name || abbrev,
    sfPerGame: (sf + P * L) / (w + P), saPerGame: (sa + P * L) / (w + P), gfPerGame: (gf + P * G) / (w + P), gaPerGame: (ga + P * G) / (w + P),
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
  const shPct = (gg + PRIOR.shPctShots * lg.shPct[pos]) / (gs + PRIOR.shPctShots);
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
  const P = PRIOR.svShots;
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
  return { team: T, skaters, goalie: G ? { ...G, projection: proj } : null };
}

module.exports = { prepare, leagueAt, teamAt, skaterAt, goalieAt, projectStarter, teamGoalies, sideFor, HL, PRIOR, daysBetween };
