// GET /api/health — fetches every source the model depends on and reports what came back, so a
// changed NHL feed shows up here first. A check fails on empty data, not only on errors.
// ?probe=1 returns the raw shapes (keys and samples) of each feed, to check the parsers against
// what the API actually sends.
const nhl = require('../lib/nhl');
const { dataStatus, snapshotStatus, etDate, shift } = require('../lib/store');
const { fetchJson } = require('../lib/http');
const { param, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { const detail = await fn(); return { name, ok: true, ms: Date.now() - t, ...detail }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const clip = (v, n = 1200) => { const t = JSON.stringify(v); return t && t.length > n ? `${t.slice(0, n)}…` : v; };
const keys = o => (o && typeof o === 'object' ? Object.keys(o) : null);

// The most recent date with finished games, searching back up to two weeks.
async function lastGameDay() {
  for (let i = 1; i <= 14; i++) { const d = shift(etDate(), -i); const s = await nhl.fetchScores(d); if (s.some(g => g.state === 'post')) return { date: d, games: s }; }
  return null;
}

async function probe() {
  const out = [], today = etDate();
  const sch = await fetchJson(nhl.URLS.schedule(today)).catch(e => ({ error: e.message }));
  const g0 = sch.gameWeek?.find(d => d.games?.length)?.games?.[0];
  out.push({ name: 'schedule', keys: keys(sch), days: sch.gameWeek?.map(d => `${d.date}:${d.games?.length}`), gameKeys: keys(g0), game: clip(g0, 900) });
  const last = await lastGameDay().catch(() => null);
  if (last) {
    const sc = await fetchJson(nhl.URLS.score(last.date));
    const s0 = sc.games?.find(g => g.goals?.length);
    out.push({ name: `score ${last.date}`, keys: keys(sc), gameKeys: keys(s0), goalKeys: keys(s0?.goals?.[0]), goals: clip(s0?.goals?.slice(0, 2), 900), outcome: s0?.gameOutcome, period: s0?.periodDescriptor, teams: clip({ a: s0?.awayTeam, h: s0?.homeTeam }, 500) });
    const box = await fetchJson(nhl.URLS.boxscore(s0.id));
    const t = box.playerByGameStats?.homeTeam || {};
    out.push({ name: `boxscore ${s0.id}`, keys: keys(box), teamKeys: keys(t), forward: clip(t.forwards?.[0], 600), defense: clip(t.defense?.[0], 400), goalie: clip(t.goalies?.[0], 600), homeTeam: clip(box.homeTeam, 300) });
    const pid = t.forwards?.[0]?.playerId;
    const sd = await fetchJson(nhl.URLS.standings(today)).catch(e => ({ error: e.message }));
    out.push({ name: 'standings', keys: keys(sd), row: clip(sd.standings?.[0], 600) });
    if (pid) { const gl = await fetchJson(nhl.URLS.gameLog(pid, s0.season, 2)).catch(e => ({ error: e.message })); out.push({ name: 'player game log', keys: keys(gl), row: clip(gl.gameLog?.[0], 500) }); }
  }
  return out;
}

module.exports = async (req, res) => {
  if (param(req, 'probe')) {
    try { return send(res, 200, { generatedAt: new Date().toISOString(), probe: await probe() }); }
    catch (err) { return send(res, 200, { error: err.message }); }
  }
  const checks = [];
  let last = null;
  checks.push(await check('Schedule: next 7 days', async () => {
    const days = [];
    for (let i = 0; i < 7; i++) { const d = shift(etDate(), i); days.push({ date: d, games: (await nhl.fetchSchedule(d)).length }); }
    const total = days.reduce((s, d) => s + d.games, 0), m = Number(etDate().slice(5, 7));
    need(total > 0 || (m >= 7 && m <= 9), 'no games scheduled in the next week during the season');
    return { days, total };
  }));
  checks.push(await check('Scores: last game day', async () => {
    last = await lastGameDay();
    need(last, 'no finished games in the last two weeks');
    const done = last.games.filter(g => g.state === 'post');
    const goals = done.reduce((s, g) => s + g.goals.length, 0), scored = done.reduce((s, g) => s + (g.home.score || 0) + (g.away.score || 0), 0);
    need(goals > 0, 'finished games but no goals parsed');
    return { date: last.date, games: done.length, goalsParsed: goals, goalsOnScoreboard: scored, shootoutGames: done.filter(g => g.outcome === 'SO').length, sample: done[0]?.goals[0] || null };
  }));
  if (last) checks.push(await check('Box score: one finished game', async () => {
    const g = last.games.find(x => x.state === 'post');
    const b = await nhl.fetchBoxscore(g.id);
    const sk = [...b.players.home.skaters, ...b.players.away.skaters], gs = [...b.players.home.goalies, ...b.players.away.goalies];
    need(sk.length >= 30, `only ${sk.length} skaters parsed`);
    need(gs.filter(x => x.starter).length === 2, 'starting goalies not identified');
    need(sk.some(p => p.shots > 0) && sk.some(p => p.toi > 0), 'skater shots or ice time missing');
    return { game: `${b.away.abbrev} @ ${b.home.abbrev}`, skaters: sk.length, goalies: gs.map(x => `${x.name} ${x.saves}/${x.shotsAgainst}${x.starter ? ' (started)' : ''}`), shots: sk.reduce((s, p) => s + p.shots, 0), sogOnScoreboard: (b.home.sog || 0) + (b.away.sog || 0), sample: sk[0] };
  }));
  checks.push(await check('Standings', async () => {
    const st = await nhl.fetchStandings(etDate());
    const m = Number(etDate().slice(5, 7));
    need(st.size >= 30 || (m >= 7 && m <= 9), `only ${st.size} teams in the standings`);
    return { teams: st.size, sample: [...st.entries()].slice(0, 3).map(([k, v]) => `${k} ${v.w}-${v.l}-${v.otl} (${v.pts} pts)`) };
  }));
  checks.push(await check('History store', async () => dataStatus()));
  checks.push(await check('Snapshot storage (accuracy tracking)', async () => { const st = await snapshotStatus(); if (st.variable && !st.connected) throw new Error(st.note); return st; }));
  const ok = checks.every(c => c.ok);
  send(res, ok ? 200 : 503, { ok, generatedAt: new Date().toISOString(), checks });
};
