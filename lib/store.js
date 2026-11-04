// lib/store.js — game history, the model's backbone: one row per completed game with the final
// score, how it ended, every goal in order (who, when, empty-net) and each player's line (skater
// shots, goals, ice time; goalie shots faced and saves). With a database the rows persist
// (backfilled by /api/sync); without one the last few weeks are fetched live so the app still
// runs, on a shorter history. The database also keeps pre-game snapshots for grading.

const db = require('./db');
const { fetchScores, fetchBoxscore, seasonFor } = require('./nhl');
const { mapLimit } = require('./http');

const MEMORY_DAYS = Number(process.env.NHL_MEMORY_DAYS || 28);
const etDate = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const shift = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
// History seasons: this one and the one before (NHL_FIRST_SEASON overrides, e.g. 20232024).
function firstSeason() { const cur = seasonFor(etDate()); return Number(process.env.NHL_FIRST_SEASON || `${Math.floor(cur / 10000) - 1}${Math.floor(cur / 10000)}`); }

// Score-page game (with goals) + box score → one history row.
function gameRow(date, sc, box) {
  const goalT = g => (g.period - 1) * 20 + g.time;
  return {
    id: sc.id, date, season: sc.season || box.season, gameType: sc.gameType,
    home: sc.home.abbrev, away: sc.away.abbrev, homeName: sc.home.name, awayName: sc.away.name,
    homeScore: sc.home.score ?? box.home.score, awayScore: sc.away.score ?? box.away.score,
    homeSog: box.home.sog ?? sc.home.sog, awaySog: box.away.sog ?? sc.away.sog,
    outcome: sc.outcome || box.outcome || 'REG',
    goals: sc.goals.map(g => ({ t: +goalT(g).toFixed(2), period: g.period, periodType: g.periodType, team: g.team, playerId: g.playerId, name: g.name, emptyNet: g.emptyNet, strength: g.strength })).sort((a, b) => a.t - b.t),
    skaters: [...box.players.home.skaters, ...box.players.away.skaters],
    goalies: [...box.players.home.goalies, ...box.players.away.goalies],
  };
}

async function rowsForDate(date) {
  const scores = (await fetchScores(date)).filter(g => g.state === 'post');
  const rows = await mapLimit(scores, 6, async sc => { try { return gameRow(date, sc, await fetchBoxscore(sc.id)); } catch { return null; } });
  return { rows: rows.filter(Boolean), listed: scores.length };
}

async function saveRows(date, rows, complete) {
  await db.ensureTables();
  for (const r of rows) {
    await db.query(`INSERT INTO nhl_games (game_id, game_date, season, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (game_id) DO UPDATE SET payload = EXCLUDED.payload, synced_at = NOW()`, [r.id, date, r.season, JSON.stringify(r)]);
  }
  await db.query(`INSERT INTO nhl_sync_days (game_date, games, complete) VALUES ($1,$2,$3) ON CONFLICT (game_date) DO UPDATE SET games = EXCLUDED.games, complete = EXCLUDED.complete, synced_at = NOW()`, [date, rows.length, complete]);
}

// Every date from the first history season's October to yesterday that isn't stored yet,
// newest first (so the model improves fastest); stops before the serverless deadline.
async function sync({ deadline = Date.now() + 45000 } = {}) {
  await db.ensureTables();
  const start = `${Math.floor(firstSeason() / 10000)}-09-28`, end = shift(etDate(), -1);
  const have = new Set((await db.query(`SELECT game_date FROM nhl_sync_days WHERE complete`)).rows.map(r => day(r.game_date)));
  const todo = [];
  for (let d = end; d >= start; d = shift(d, -1)) { const m = Number(d.slice(5, 7)); if (m >= 7 && m <= 8) continue; if (!have.has(d)) todo.push(d); }
  const synced = [], failed = [];
  let processed = 0;
  for (const d of todo) {
    if (Date.now() > deadline - 8000) break;
    processed++;
    try { const { rows, listed } = await rowsForDate(d); await saveRows(d, rows, rows.length === listed); if (rows.length) synced.push({ date: d, games: rows.length }); }
    catch (err) { failed.push({ date: d, error: err.message }); }
  }
  return { from: start, to: end, datesStored: have.size, synced, failed, remaining: todo.length - processed };
}

const day = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

let memory = null;
async function loadRecent() {
  const today = etDate(), dates = [];
  for (let i = 1; i <= MEMORY_DAYS; i++) dates.push(shift(today, -i));
  const per = await mapLimit(dates, 4, d => rowsForDate(d).then(x => x.rows).catch(() => []));
  return per.flat();
}

// Every completed game strictly before `before` (a date), oldest first — leak-free state.
async function loadHistory({ before = etDate() } = {}) {
  if (db.hasDb) {
    await db.ensureTables();
    const r = await db.query(`SELECT payload FROM nhl_games WHERE game_date < $1 ORDER BY game_date, game_id`, [before]);
    if (r.rows.length) return { games: r.rows.map(x => x.payload), source: 'database' };
  }
  if (!memory || Date.now() - memory.at > 3 * 3600 * 1000) memory = { at: Date.now(), games: await loadRecent() };
  return { games: memory.games.filter(g => g.date < before).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), source: 'live-recent' };
}

// One finished game, from the database or straight from the API (for grading).
async function loadGame(id, date) {
  if (db.hasDb) { const r = await db.query(`SELECT payload FROM nhl_games WHERE game_id=$1`, [String(id)]); if (r.rows[0]) return r.rows[0].payload; }
  const sc = (await fetchScores(date)).find(g => g.id === String(id) && g.state === 'post');
  return sc ? gameRow(date, sc, await fetchBoxscore(sc.id)) : null;
}

async function dataStatus() {
  if (!db.hasDb) return { source: 'live-recent', days: MEMORY_DAYS, note: db.notConnected(`history is the last ${MEMORY_DAYS} days fetched live (run /api/sync once connected for two full seasons)`) };
  await db.ensureTables();
  const g = await db.query(`SELECT COUNT(*)::int AS games, MIN(game_date) AS first, MAX(game_date) AS last FROM nhl_games`);
  const d = await db.query(`SELECT COUNT(*)::int AS days FROM nhl_sync_days WHERE complete`);
  return { source: 'database', firstSeason: firstSeason(), ...g.rows[0], daysStored: d.rows[0].days };
}

// ── Snapshots: one row per game, the last projection saved before puck drop ──────────────
async function saveSnapshot(game, payload) {
  if (!db.hasDb) return false;
  await db.ensureTables();
  const res = await db.query(
    `INSERT INTO nhl_snapshots (game_id, game_date, name, payload) VALUES ($1,$2,$3,$4)
     ON CONFLICT (game_id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW(), graded = NULL, graded_at = NULL`,
    [game.id, game.date, `${game.away.abbrev} @ ${game.home.abbrev}`, JSON.stringify(payload)]);
  return res.rowCount > 0;
}

// Save and report: { saved, at } or { saved: false, reason } — never throws, never hangs.
async function saveSnapshotsSafely(items) {
  if (!db.hasDb) return { saved: 0, reason: `no database connected (set ${db.DB_VARS[0]})` };
  try { await db.withTimeout(Promise.all(items.map(x => saveSnapshot(x.game, x.payload))), 10000); return { saved: items.length, at: new Date().toISOString() }; }
  catch (err) { console.error('snapshot save failed', err); return { saved: 0, reason: err.message }; }
}

// What the Accuracy tab shows about storage: connected or not, and the latest saved projection.
async function snapshotStatus() {
  if (!db.hasDb) return { connected: false, note: db.notConnected("pre-game projections aren't being saved") };
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT COUNT(*)::int AS saved, COUNT(graded)::int AS graded FROM nhl_snapshots`), 8000);
    const last = await db.query(`SELECT name, game_date, saved_at FROM nhl_snapshots ORDER BY saved_at DESC LIMIT 1`);
    return { connected: true, variable: db.dbVar, saved: r.rows[0].saved, graded: r.rows[0].graded, last: last.rows[0] ? { name: last.rows[0].name, savedAt: last.rows[0].saved_at } : null };
  } catch (err) { return { connected: false, variable: db.dbVar, error: err.message, note: `${db.dbVar} is set but the database didn't answer: ${err.message}` }; }
}

// ── Starting goalies set by hand (shared by everyone when a database is connected) ──────
async function loadStarters(date) {
  if (!db.hasDb) return new Map();
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT team, goalie_id, goalie_name FROM nhl_starters WHERE game_date=$1`, [date]), 6000);
    return new Map(r.rows.map(x => [x.team, { id: x.goalie_id, name: x.goalie_name, source: 'manual' }]));
  } catch { return new Map(); }
}
async function setStarter(date, team, goalieId, goalieName) {
  await db.ensureTables();
  if (!goalieId) { await db.query(`DELETE FROM nhl_starters WHERE game_date=$1 AND team=$2`, [date, team]); return; }
  await db.query(`INSERT INTO nhl_starters (game_date, team, goalie_id, goalie_name) VALUES ($1,$2,$3,$4) ON CONFLICT (game_date, team) DO UPDATE SET goalie_id=EXCLUDED.goalie_id, goalie_name=EXCLUDED.goalie_name, set_at=NOW()`, [date, team, goalieId, goalieName || null]);
}

// ── The day's best goalscorer play, locked at the first puck drop ────────────────────────
async function loadDailyPick(date) {
  if (!db.hasDb) return null;
  try { await db.ensureTables(); const r = await db.withTimeout(db.query(`SELECT payload FROM nhl_daily_picks WHERE game_date=$1`, [date]), 6000); return r.rows[0]?.payload || null; } catch { return null; }
}
async function saveDailyPick(date, pick) {
  if (!db.hasDb || !pick) return false;
  try { await db.ensureTables(); await db.withTimeout(db.query(`INSERT INTO nhl_daily_picks (game_date, payload) VALUES ($1,$2) ON CONFLICT (game_date) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW()`, [date, JSON.stringify(pick)]), 6000); return true; } catch { return false; }
}

// ── Calibration fitted by the backtest (moneyline stretch) ──────────────────────────────
async function loadCalibration() {
  if (!db.hasDb) return null;
  try { await db.ensureTables(); const r = await db.withTimeout(db.query(`SELECT value, detail, fitted_at FROM nhl_calibration WHERE name='ml_stretch'`), 6000); return r.rows[0] ? { k: r.rows[0].value, ...r.rows[0].detail, fittedAt: r.rows[0].fitted_at } : null; } catch { return null; }
}
async function saveCalibration(c) {
  if (!db.hasDb) return false;
  await db.ensureTables();
  await db.query(`INSERT INTO nhl_calibration (name, value, detail) VALUES ('ml_stretch', $1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, detail = EXCLUDED.detail, fitted_at = NOW()`, [c.kApplied, JSON.stringify({ n: c.n, kFit: c.kFit, check: c.check })]);
  return true;
}

// Saved pre-game projections for a date: game id → { payload, savedAt } (empty without a database).
async function loadSnapshots(date) {
  if (!db.hasDb) return new Map();
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT game_id, payload, saved_at FROM nhl_snapshots WHERE game_date=$1`, [date]), 6000);
    return new Map(r.rows.map(x => [x.game_id, { payload: x.payload, savedAt: x.saved_at }]));
  } catch { return new Map(); }
}

module.exports = { loadSnapshots, loadCalibration, saveCalibration, loadDailyPick, saveDailyPick, loadStarters, setStarter, MEMORY_DAYS, etDate, shift, firstSeason, gameRow, rowsForDate, sync, loadHistory, loadGame, dataStatus, saveSnapshot, saveSnapshotsSafely, snapshotStatus };
