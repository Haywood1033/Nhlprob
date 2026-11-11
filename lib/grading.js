// lib/grading.js — grades each saved pre-game snapshot (the last projection before puck drop)
// against the finished game: moneyline and totals, every projected skater who dressed (anytime
// goal), the first goalscorer, and each projected starter who started (saves). Nothing from
// after puck drop touches a snapshot, so the Accuracy tab is an honest out-of-sample record.

const db = require('./db');
const { loadGame } = require('./store');
const { mlTier } = require('./lean');
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
const day = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function gradeOne(snap, g) {
  const homeWon = g.homeScore > g.awayScore ? 1 : 0, total = g.homeScore + g.awayScore;
  const dressed = new Map(g.skaters.map(p => [p.id, p]));
  const players = snap.players.filter(p => dressed.has(p.id));
  const firstId = g.goals?.[0]?.playerId ?? null, firstSnap = snap.players.find(p => p.id === firstId);
  const anyLL = players.reduce((s, p) => s + ll(p.anytime, dressed.get(p.id).goals >= 1), 0);
  const scored = players.filter(p => dressed.get(p.id).goals >= 1);
  const saves = [];
  for (const k of ['home', 'away']) {
    const G = snap.goalies?.[k]; if (!G) continue;
    const actual = g.goalies.find(x => x.starter && x.team === (k === 'home' ? g.home : g.away));
    if (actual && actual.id === G.id) saves.push({ name: G.name, projected: G.mean, actual: actual.saves, inRange: actual.saves >= G.p10 && actual.saves <= G.p90 });
  }
  return {
    final: `${g.away} ${g.awayScore} – ${g.homeScore} ${g.home}${g.outcome && g.outcome !== 'REG' ? ` (${g.outcome})` : ''}`,
    moneyline: { p: homeWon ? snap.pHome : 1 - snap.pHome, picked: (snap.pHome >= 0.5) === (homeWon === 1), logLoss: +ll(snap.pHome, homeWon).toFixed(4), tier: mlTier(snap.pHome), fav: Math.max(snap.pHome, 1 - snap.pHome) },
    total: { model: snap.total.mean, actual: total, over55: { p: snap.total.over[5.5], hit: total > 5.5 }, over65: { p: snap.total.over[6.5], hit: total > 6.5 } },
    anytime: { players: players.length, scorers: scored.length, expected: +players.reduce((s, p) => s + p.anytime, 0).toFixed(2), logLoss: players.length ? +(anyLL / players.length).toFixed(4) : null, topPicks: players.slice().sort((a, b) => b.anytime - a.anytime).slice(0, 5).map(p => ({ name: p.name, p: p.anytime, scored: dressed.get(p.id).goals >= 1 })) },
    first: firstId ? { name: g.goals[0].name, p: firstSnap ? firstSnap.first : null, inLineup: !!firstSnap } : null,
    saves,
    // The benchmark: the betting line's (de-vigged) home chance saved with the snapshot, scored the
    // same way as the model. Beating it is the hardest test there is.
    market: Number.isFinite(snap.market?.pHome) ? { p: snap.market.pHome, logLoss: +ll(snap.market.pHome, homeWon).toFixed(4), modelLogLoss: +ll(snap.pHome, homeWon).toFixed(4) } : null,
  };
}

async function gradeAll({ deadline = Date.now() + 20000 } = {}) {
  if (!db.hasDb) return { newlyGraded: [] };
  await db.ensureTables();
  const todo = await db.query(`SELECT game_id, game_date, payload FROM nhl_snapshots WHERE graded IS NULL AND game_date < (NOW() AT TIME ZONE 'America/New_York')::date ORDER BY game_date LIMIT 200`);
  const newly = [];
  for (const row of todo.rows) {
    if (Date.now() > deadline) break;
    const g = await loadGame(row.game_id, day(row.game_date)).catch(() => null);
    if (!g) continue; // not final yet / not available; tried again next time
    await db.query(`UPDATE nhl_snapshots SET graded=$2, graded_at=NOW() WHERE game_id=$1`, [row.game_id, JSON.stringify(gradeOne(row.payload, g))]);
    newly.push(row.game_id);
  }
  return { newlyGraded: newly };
}

// The graded record is read straight from the database (with a retry for a cold connection) and is
// never hidden by the storage status line: a slow status check can only add a warning, not blank the
// record. New games are graded first only within a short budget, so the page isn't held up.
// Totals are aggregated in SQL over EVERY graded game (they used to cover only the latest 300, so
// they stopped matching the "N checked" count about six weeks into a season); the game list is paged.
const PAGE = 60;
const TOTALS_SQL = `
  WITH g AS (SELECT graded FROM nhl_snapshots WHERE graded IS NOT NULL)
  SELECT
    COUNT(*)::int AS games,
    COALESCE(SUM(CASE WHEN (graded->'moneyline'->>'picked')::boolean THEN 1 ELSE 0 END), 0)::int AS fav_won,
    AVG((graded->'moneyline'->>'logLoss')::float8) AS ml_ll,
    COALESCE(SUM((graded->'anytime'->>'players')::int), 0)::int AS any_players,
    COALESCE(SUM((graded->'anytime'->>'scorers')::int), 0)::int AS any_scorers,
    COALESCE(SUM((graded->'anytime'->>'expected')::float8), 0) AS any_expected,
    SUM((graded->'anytime'->>'logLoss')::float8 * (graded->'anytime'->>'players')::int) FILTER (WHERE graded->'anytime'->>'logLoss' IS NOT NULL) AS any_ll_sum,
    SUM((graded->'anytime'->>'players')::int) FILTER (WHERE graded->'anytime'->>'logLoss' IS NOT NULL) AS any_ll_n,
    AVG(ABS((graded->'total'->>'model')::float8 - (graded->'total'->>'actual')::float8)) AS total_mae,
    COUNT(*) FILTER (WHERE graded->'market'->>'p' IS NOT NULL)::int AS mk_games,
    AVG((graded->'market'->>'modelLogLoss')::float8) FILTER (WHERE graded->'market'->>'p' IS NOT NULL) AS mk_model_ll,
    AVG((graded->'market'->>'logLoss')::float8) FILTER (WHERE graded->'market'->>'p' IS NOT NULL) AS mk_ll,
    AVG((graded->'moneyline'->>'fav')::float8) AS ml_fav_pred
  FROM g`;
const TIER_SQL = `
  SELECT graded->'moneyline'->>'tier' AS tier, COUNT(*)::int AS n,
    AVG(CASE WHEN (graded->'moneyline'->>'picked')::boolean THEN 1 ELSE 0 END) AS won,
    AVG((graded->'moneyline'->>'fav')::float8) AS predicted
  FROM nhl_snapshots WHERE graded IS NOT NULL GROUP BY 1`;
const SAVES_SQL = `
  SELECT COUNT(*)::int AS n, AVG(ABS((s->>'projected')::float8 - (s->>'actual')::float8)) AS mae,
    AVG(CASE WHEN (s->>'inRange')::boolean THEN 1 ELSE 0 END) AS in_range
  FROM nhl_snapshots, jsonb_array_elements(COALESCE(graded->'saves', '[]'::jsonb)) AS s WHERE graded IS NOT NULL`;

async function listGrades({ page = 0 } = {}) {
  const store = require('./store');
  if (!db.hasDb) { const storage = await store.snapshotStatus(); return { games: [], totals: null, storage, note: storage.note }; }
  await gradeAll({ deadline: Date.now() + 4000 }).catch(() => {});
  const pg = Math.max(0, Math.floor(Number(page) || 0));
  const run = ms => Promise.all([
    db.withTimeout(db.query(`SELECT game_id, game_date, name, graded FROM nhl_snapshots WHERE graded IS NOT NULL ORDER BY game_date DESC, game_id DESC LIMIT ${PAGE} OFFSET ${pg * PAGE}`), ms),
    db.withTimeout(db.query(TOTALS_SQL), ms), db.withTimeout(db.query(TIER_SQL), ms), db.withTimeout(db.query(SAVES_SQL), ms),
  ]);
  const [r, storage] = await Promise.all([run(10000).catch(() => run(15000)).catch(err => ({ error: err.message })), store.snapshotStatus()]);
  if (r.error) return { games: [], totals: null, storage: { ...storage, connected: false, variable: db.dbVar, error: r.error }, note: r.error };
  const [list, tot, tiers, sv] = r;
  const games = list.rows.map(x => ({ gameId: x.game_id, date: day(x.game_date), name: x.name, ...x.graded }));
  const t = tot.rows[0], n = t.games, num = v => (v === null || v === undefined ? null : Number(v));
  const tierRow = k => tiers.rows.find(x => x.tier === k);
  const totals = n ? {
    games: n, favoritesWon: t.fav_won, moneylineLogLoss: num(t.ml_ll), favoritePredicted: num(t.ml_fav_pred),
    anytime: { players: t.any_players, scorers: t.any_scorers, expected: +Number(t.any_expected).toFixed(1), logLoss: t.any_ll_n ? Number(t.any_ll_sum) / Number(t.any_ll_n) : null },
    saves: { n: sv.rows[0].n, mae: num(sv.rows[0].mae), inRange: num(sv.rows[0].in_range) },
    totalMae: num(t.total_mae),
    // The benchmark: the de-vigged betting line saved with each pre-game projection (lib/market).
    market: t.mk_games ? { games: t.mk_games, modelLogLoss: num(t.mk_model_ll), marketLogLoss: num(t.mk_ll) } : null,
    byTier: ['strong', 'lean', 'tossup'].map(k => { const x = tierRow(k); return { tier: k, n: x ? x.n : 0, won: x ? num(x.won) : null, predicted: x ? num(x.predicted) : null }; }),
  } : null;
  return { storage, games, page: pg, pageSize: PAGE, pages: Math.ceil(n / PAGE), totals };
}

module.exports = { gradeOne, gradeAll, listGrades };
