// lib/effects.js — which fitted pieces of the model are on, decided by evidence, not by hand.
//
// Every effect in lib/ratings DEFAULT_EFFECTS can be switched on or off. compareEffect() replays
// past game days twice per game, once with the effect and once without, everything else equal
// (same ratings, same random numbers), and records per game how much log loss changed:
//   d_ml   moneyline log loss (raw win chance), effect on minus off
//   d_any  anytime-goal log loss averaged over the players who dressed, on minus off
// The rows are stored per (effect, game), so overlapping nightly runs replace rather than double
// count. An effect's state is then:
//   on    300+ games, moneyline log loss down by at least MIN_GAIN per game, goalscorers not worse
//   off   300+ games and it made moneylines worse by MIN_GAIN, or goalscorers worse by ANY_HARM
//   else  its default (estimation and bias fixes on; the team-level additions off)
// A fixed rule, so nothing is switched on because one week looked good.

const db = require('./db');
const { DEFAULT_EFFECTS, prepare, leagueAt, sideFor } = require('./ratings');
const { simulateGame, summarizeGame, summarizePlayer } = require('./simulator');
const { hashSeed } = require('./rng');

const KEYS = Object.keys(DEFAULT_EFFECTS);
const LABELS = {
  eb: 'Fitted shooting and save priors', late: 'Late-game model (empty net, extra-attacker ties)', otShots: 'Overtime shots', dispResid: 'Shot spread fitted after the opponent',
  team: 'Team finishing and suppression', lineup: 'Lineup-adjusted team shots', b2b: 'Back-to-back shot effect', homeFinish: 'Home finishing edge',
};
const MIN_GAMES = 300, MIN_GAIN = 0.0005, ANY_SLACK = 0.0002, ANY_HARM = 0.001;
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));

// One effect, on vs off, over the last `days` game days of `history`. effects: the current state.
async function compareEffect({ key, days = 7, sims = 1500, history, effects = DEFAULT_EFFECTS, simSide = require('./slate').simSide } = {}) {
  if (!KEYS.includes(key)) throw Object.assign(new Error(`Unknown effect "${key}"`), { status: 400 });
  const prep = prepare(history.games);
  const dates = [...new Set(prep.games.map(g => g.date))];
  const firstOk = prep.games[Math.min(prep.games.length - 1, 150)]?.date;
  const target = dates.filter(d => d > firstOk).slice(-days);
  const rows = [];
  for (const date of target) {
    const lgOn = leagueAt(prep, date, { ...effects, [key]: true }), lgOff = leagueAt(prep, date, { ...effects, [key]: false });
    for (const g of prep.games.filter(x => x.date === date)) {
      const run = lg => {
        const H = sideFor(prep, g.home, g.away, date, lg), A = sideFor(prep, g.away, g.home, date, lg);
        if (!H.skaters.length || !A.skaters.length) return null;
        const sim = simulateGame({ id: g.id, playoff: g.gameType === 3, home: simSide(H, A, lg, true), away: simSide(A, H, lg, false), lg }, { sims, seed: hashSeed(`fx|${g.id}`) });
        const players = new Map([...H.skaters, ...A.skaters].map((p, i) => [p.id, summarizePlayer(sim, i).anytime]));
        return { pHome: summarizeGame(sim).pHome, players };
      };
      const on = run(lgOn), off = run(lgOff);
      if (!on || !off) continue;
      const y = g.homeScore > g.awayScore ? 1 : 0;
      const dressed = g.skaters.filter(p => on.players.has(p.id) && off.players.has(p.id));
      const dAny = dressed.length ? dressed.reduce((s, p) => s + ll(on.players.get(p.id), p.goals >= 1) - ll(off.players.get(p.id), p.goals >= 1), 0) / dressed.length : 0;
      rows.push({ gameId: g.id, date, dMl: ll(on.pHome, y) - ll(off.pHome, y), dAny, nAny: dressed.length });
    }
  }
  return { key, label: LABELS[key], days: target.length, games: rows.length, rows, summary: summarize(rows) };
}

function summarize(rows) {
  const n = rows.length, mean = f => (n ? rows.reduce((s, r) => s + f(r), 0) / n : null);
  return { games: n, dMl: mean(r => r.dMl), dAny: mean(r => r.dAny) };
}

function decide(key, s) {
  const def = DEFAULT_EFFECTS[key];
  if (!s || s.games < MIN_GAMES) return { on: def, why: `default (${s?.games || 0} of ${MIN_GAMES} games tested)` };
  if (s.dMl <= -MIN_GAIN && s.dAny <= ANY_SLACK) return { on: true, why: 'improves held-out predictions' };
  if (s.dMl >= MIN_GAIN || s.dAny >= ANY_HARM) return { on: false, why: 'made held-out predictions worse' };
  return { on: def, why: 'no clear difference yet: default' };
}

async function saveEvidence(key, rows) {
  if (!db.hasDb || !rows.length) return 0;
  await db.ensureTables();
  for (const r of rows) await db.query(`INSERT INTO nhl_effect_evidence (effect, game_id, game_date, d_ml, d_any, n_any) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (effect, game_id) DO UPDATE SET d_ml = EXCLUDED.d_ml, d_any = EXCLUDED.d_any, n_any = EXCLUDED.n_any, tested_at = NOW()`, [key, r.gameId, r.date, r.dMl, r.dAny, r.nAny]);
  cache = null;
  return rows.length;
}

let cache = null;
// → { effects: { key: bool }, detail: [{ key, label, on, why, games, dMl, dAny }] }
async function loadEffects() {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  let sums = new Map();
  if (db.hasDb) {
    try {
      await db.ensureTables();
      const r = await db.withTimeout(db.query(`SELECT effect, COUNT(*)::int AS games, AVG(d_ml) AS dml, AVG(d_any) AS dany FROM nhl_effect_evidence GROUP BY effect`), 6000);
      sums = new Map(r.rows.map(x => [x.effect, { games: x.games, dMl: Number(x.dml), dAny: Number(x.dany) }]));
    } catch { /* defaults */ }
  }
  const detail = KEYS.map(k => ({ key: k, label: LABELS[k], ...(sums.get(k) || { games: 0, dMl: null, dAny: null }), ...decide(k, sums.get(k)) }));
  const value = { effects: Object.fromEntries(detail.map(d => [d.key, d.on])), detail };
  cache = { at: Date.now(), value };
  return value;
}

// The effect to test tonight: the one with the least evidence (ties by a fixed order).
async function nextToTest() {
  const { detail } = await loadEffects();
  return [...detail].sort((a, b) => a.games - b.games)[0].key;
}

module.exports = { KEYS, LABELS, MIN_GAMES, MIN_GAIN, compareEffect, summarize, decide, saveEvidence, loadEffects, nextToTest, clearEffectsCache: () => { cache = null; } };
