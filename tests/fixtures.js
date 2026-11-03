// Synthetic NHL world for tests and layout screenshots: fake teams, players and games served in
// the NHL web API's shapes (schedule, score with goals, box score; lib/nhl.js). Some box scores
// use the older goalie format ("saves/shots", no starter flag) to exercise both parsers.
// Nothing here is real data.
const { makeRng } = require('../lib/rng');

const CITIES = ['Aurora', 'Bayside', 'Cedar', 'Dunmore', 'Easton', 'Fairview', 'Glen', 'Harbor', 'Iron', 'Juniper', 'Kingsport', 'Lakeview', 'Maple', 'Northgate', 'Oakridge', 'Pinecrest', 'Quarry', 'Ridgeway', 'Stonebridge', 'Timber', 'Union', 'Valley', 'Westfield', 'Yarrow', 'Zenith', 'Ashford', 'Brookline', 'Clearwater', 'Driftwood', 'Elmhurst', 'Foxboro', 'Granite'];
const NICK = ['Wolves', 'Hawks', 'Bears', 'Owls', 'Foxes', 'Lynx', 'Storm', 'Comets', 'Knights', 'Rangers', 'Pilots', 'Otters', 'Bisons', 'Falcons', 'Sharks', 'Ravens', 'Moose', 'Badgers', 'Eagles', 'Herons', 'Cougars', 'Stags', 'Vipers', 'Wardens', 'Mariners', 'Rockets', 'Titans', 'Hornets', 'Jets', 'Lancers', 'Monarchs', 'Pumas'];
const FIRST = ['Aleksi', 'Brody', 'Cale', 'Dmitri', 'Elias', 'Filip', 'Gage', 'Henrik', 'Isak', 'Jesper', 'Kasper', 'Liam', 'Mikko', 'Nils', 'Owen', 'Pavel', 'Quinn', 'Rasmus', 'Sami', 'Teuvo', 'Urho', 'Viktor', 'Wyatt', 'Yanni', 'Zach'];
const LAST = ['Aho', 'Bergstrom', 'Carlsson', 'Dahlin', 'Eklund', 'Forsberg', 'Granlund', 'Hagel', 'Ivanov', 'Jarvinen', 'Kaprizov', 'Lindqvist', 'Makar', 'Nylander', 'Olofsson', 'Pettersson', 'Quinlan', 'Rantanen', 'Sorokin', 'Tkachuk', 'Ulmark', 'Vatanen', 'Wennberg', 'Yakupov', 'Zibanejad'];
const abbr = c => c.slice(0, 3).toUpperCase();

function makeLeague(seed = 21) {
  const rng = makeRng(seed);
  let pid = 8470000, n = 0;
  const name = () => { const k = n++; return `${FIRST[k % 25]} ${LAST[Math.floor(k / 25) % 25]}${k >= 625 ? ' II' : ''}`; };
  const teams = CITIES.map((c, i) => {
    const pace = Math.exp(rng.normal() * 0.08), suppress = Math.exp(rng.normal() * 0.08);
    const sk = (pos, k) => Array.from({ length: k }, (_, j) => ({ id: pid++, name: name(), pos, line: j, shots60: (pos === 'D' ? 4.4 : 7.2) * Math.exp(rng.normal() * 0.3), sh: (pos === 'D' ? 0.05 : 0.105) * Math.exp(rng.normal() * 0.28), toi: pos === 'D' ? 24 - j * 1.6 : 19 - Math.floor(j / 3) * 2.6 }));
    return {
      id: i + 1, abbrev: abbr(c) === 'GLE' ? 'GLN' : abbr(c), place: c, nick: NICK[i], pace, suppress,
      F: sk('C', 14).map((p, j) => ({ ...p, pos: ['C', 'L', 'R'][j % 3] })), D: sk('D', 8),
      G: [{ id: pid++, name: name(), sv: 0.9 + rng.normal() * 0.008 }, { id: pid++, name: name(), sv: 0.895 + rng.normal() * 0.008 }],
    };
  });
  return { teams, rng };
}

const clock = m => { const t = Math.max(0, Math.min(19.99, m)); return `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * 60)).padStart(2, '0')}`; };
const shift = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const seasonOf = d => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 9 ? y : y - 1; return Number(`${s}${s + 1}`); };

// One game from latent traits → { score, sog, goals, players }.
function playGame(h, a, date, rng, rest) {
  const dress = t => {
    const scratchF = new Set([Math.floor(rng.uniform() * 14), 13]), scratchD = new Set([7, Math.floor(rng.uniform() * 8)]);
    const F = t.F.filter((_, j) => !scratchF.has(j)).slice(0, 12), D = t.D.filter((_, j) => !scratchD.has(j)).slice(0, 6);
    const g = rest.get(t.abbrev) === shift(date, -1) && rng.uniform() < 0.8 ? t.G[1] : rng.uniform() < 0.85 ? t.G[0] : t.G[1];
    return { sk: [...F, ...D], g };
  };
  const H = dress(h), A = dress(a);
  const side = (me, op, M) => ({ rate: 30 * me.pace / op.suppress * (M ? 1.03 : 0.97), sk: (M ? H : A).sk, g: (M ? A : H).g });
  const S = [side(h, a, true), side(a, h, false)];
  const line = new Map([...H.sk, ...A.sk].map(p => [p.id, { shots: 0, goals: 0, toi: p.toi * Math.exp(rng.normal() * 0.08) }]));
  const goals = [], sc = [0, 0], sog = [0, 0], faced = [0, 0], saved = [0, 0];
  const pickShooter = sk => { const ws = sk.map(p => p.shots60 * p.toi); const t = ws.reduce((x, y) => x + y, 0); let u = rng.uniform() * t; for (let i = 0; i < sk.length; i++) { u -= ws[i]; if (u <= 0) return sk[i]; } return sk[sk.length - 1]; };
  for (let per = 1; per <= 3; per++) {
    const ev = [];
    for (const s of [0, 1]) { const n = Math.round(S[s].rate / 3 + rng.normal() * Math.sqrt(S[s].rate / 3)); for (let j = 0; j < n; j++) ev.push({ s, t: rng.uniform() * 20 }); }
    ev.sort((x, y) => x.t - y.t);
    for (const e of ev) {
      const p = pickShooter(S[e.s].sk), L = line.get(p.id); L.shots++; sog[e.s]++; faced[1 - e.s]++;
      if (rng.uniform() < p.sh * (1 - S[e.s].g.sv) / 0.1) { L.goals++; sc[e.s]++; goals.push({ period: per, t: e.t, s: e.s, p, en: false }); } else saved[1 - e.s]++;
    }
  }
  const lead = sc[0] - sc[1];
  if (Math.abs(lead) >= 1 && Math.abs(lead) <= 2 && rng.uniform() < (Math.abs(lead) === 1 ? 0.3 : 0.22)) {
    const s = lead > 0 ? 0 : 1, p = pickShooter(S[s].sk); line.get(p.id).goals++; line.get(p.id).shots++; sog[s]++; sc[s]++; goals.push({ period: 3, t: 19.2, s, p, en: true });
  }
  let outcome = 'REG';
  if (sc[0] === sc[1]) {
    if (rng.uniform() < 0.6) { const s = rng.uniform() < 0.5 ? 0 : 1, p = pickShooter(S[s].sk); line.get(p.id).goals++; line.get(p.id).shots++; sog[s]++; sc[s]++; faced[1 - s]++; goals.push({ period: 4, t: rng.uniform() * 5, s, p, en: false }); outcome = 'OT'; }
    else { sc[rng.uniform() < 0.5 ? 0 : 1]++; outcome = 'SO'; }
  }
  return { H, A, line, goals, sc, sog, faced, saved, outcome };
}

function makeWorld({ now, live = false } = {}) {
  const { teams, rng } = makeLeague();
  const byAbbrev = new Map(teams.map(t => [t.abbrev, t]));
  const today = new Date(Date.parse(now)).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const days = new Map(); // date -> [game]
  const rest = new Map();
  let gid = 0;
  const seasons = [['2025-10-07', '2026-04-16'], ['2026-10-07', shift(today, 2)]];
  for (const [from, to] of seasons) {
    for (let d = from; d <= to; d = shift(d, 1)) {
      const order = [...teams].sort(() => rng.uniform() - 0.5).slice(0, 2 * (5 + Math.floor(rng.uniform() * 4)));
      const games = [];
      for (let i = 0; i < order.length; i += 2) {
        const h = order[i], a = order[i + 1], season = seasonOf(d);
        const id = `${Math.floor(season / 10000)}02${String(++gid).padStart(4, '0')}`;
        const state = d < today ? 'OFF' : d === today ? (live && i === 0 ? 'LIVE' : 'FUT') : 'FUT';
        const g = { id, date: d, season, home: h, away: a, state, start: `${d}T23:${String(i * 3).padStart(2, '0')}:00Z` };
        if (d < today || (live && d === today && i === 0)) g.res = playGame(h, a, d, rng, rest);
        games.push(g);
      }
      for (const g of games) { rest.set(g.home.abbrev, d); rest.set(g.away.abbrev, d); }
      days.set(d, games);
    }
  }
  return { teams, byAbbrev, days, today };
}

const tName = t => ({ id: t.id, abbrev: t.abbrev, placeName: { default: t.place }, commonName: { default: t.nick } });
function scheduleJson(g) { return { id: Number(g.id), season: g.season, gameType: 2, startTimeUTC: g.start, gameState: g.state, venue: { default: `${g.home.place} Arena` }, awayTeam: tName(g.away), homeTeam: tName(g.home) }; }
function scoreJson(g) {
  const r = g.res, base = scheduleJson(g);
  if (!r) return { ...base, awayTeam: { ...tName(g.away), score: 0, sog: 0 }, homeTeam: { ...tName(g.home), score: 0, sog: 0 }, goals: [] };
  const live = g.state === 'LIVE';
  const goals = r.goals.filter(x => !live || x.period <= 2).sort((x, y) => x.period - y.period || x.t - y.t);
  const sc = live ? [goals.filter(x => x.s === 0).length, goals.filter(x => x.s === 1).length] : r.sc;
  return {
    ...base, period: live ? 2 : r.outcome === 'REG' ? 3 : 4, periodDescriptor: { number: live ? 2 : r.outcome === 'REG' ? 3 : r.outcome === 'OT' ? 4 : 5, periodType: live ? 'REG' : r.outcome },
    clock: { timeRemaining: live ? '08:12' : '00:00', inIntermission: false }, gameOutcome: live ? undefined : { lastPeriodType: r.outcome },
    awayTeam: { ...tName(g.away), score: sc[1], sog: live ? Math.round(r.sog[1] * 0.6) : r.sog[1] }, homeTeam: { ...tName(g.home), score: sc[0], sog: live ? Math.round(r.sog[0] * 0.6) : r.sog[0] },
    goals: goals.map((x, i) => ({ period: x.period, periodDescriptor: { number: x.period, periodType: x.period > 3 ? 'OT' : 'REG' }, timeInPeriod: clock(x.t), playerId: x.p.id, name: { default: x.p.name }, teamAbbrev: i % 2 ? { default: (x.s ? g.away : g.home).abbrev } : (x.s ? g.away : g.home).abbrev, strength: 'ev', goalModifier: x.en ? 'empty-net' : 'none' })),
  };
}
function boxJson(g) {
  const base = scoreJson(g), r = g.res;
  if (!r) return { ...base, playerByGameStats: {} };
  const old = Number(g.id.slice(-1)) % 5 === 0; // older goalie format on some games
  const side = (dr, s) => ({
    forwards: dr.sk.filter(p => p.pos !== 'D').map(p => sk(p)), defense: dr.sk.filter(p => p.pos === 'D').map(p => sk(p)),
    goalies: [dr.g].map(gl => old ? { playerId: gl.id, name: { default: gl.name }, toi: '60:00', saveShotsAgainst: `${r.saved[s]}/${r.faced[s]}` } : { playerId: gl.id, name: { default: gl.name }, toi: '60:00', starter: true, shotsAgainst: r.faced[s], saves: r.saved[s], goalsAgainst: r.faced[s] - r.saved[s] }),
  });
  const sk = p => { const L = r.line.get(p.id); return { playerId: p.id, name: { default: p.name }, position: p.pos, goals: L.goals, assists: 0, sog: L.shots, toi: `${Math.floor(L.toi)}:${String(Math.floor((L.toi % 1) * 60)).padStart(2, '0')}`, powerPlayGoals: 0 }; };
  return { ...base, playerByGameStats: { homeTeam: side(r.H, 0), awayTeam: side(r.A, 1) } };
}

function installMockFetch({ now, live = false } = {}) {
  const w = makeWorld({ now, live });
  const byId = new Map([...w.days.values()].flat().map(g => [g.id, g]));
  const real = global.fetch;
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  global.fetch = async url => {
    const u = String(url);
    let m;
    if ((m = u.match(/\/v1\/schedule\/(\d{4}-\d\d-\d\d)$/))) return ok({ gameWeek: [0, 1, 2].map(i => shift(m[1], i)).map(d => ({ date: d, games: (w.days.get(d) || []).map(scheduleJson) })) });
    if ((m = u.match(/\/v1\/score\/(\d{4}-\d\d-\d\d)$/))) return ok({ games: (w.days.get(m[1]) || []).map(scoreJson) });
    if ((m = u.match(/\/v1\/gamecenter\/(\d+)\/boxscore$/))) { const g = byId.get(m[1]); return g ? ok(boxJson(g)) : notFound; }
    return notFound;
  };
  return { restore: () => { global.fetch = real; }, ...w, byId };
}

module.exports = { installMockFetch, makeWorld, makeLeague };
