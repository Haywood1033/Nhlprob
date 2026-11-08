// lib/lock.js — write-once daily locks (the play of the day, the Best plays lists).
//
// The rule: whatever is saved when the first game starts is what the day shows, forever.
//   before the first start   draft(): saved on every build, but only while the row isn't sealed
//   at/after the first start seal(): ONE atomic statement — an existing row is sealed with its own
//                            payload (never overwritten); with no row at all, the candidate is
//                            inserted already sealed (a late lock). Concurrent requests can't race:
//                            the database decides, and every caller gets the same sealed payload.
//   database unreachable     no write at all; the caller shows its own pre-game candidate marked
//                            "unconfirmed". A failed read is never mistaken for "nothing saved".
//
// "Started" is the clock (the first scheduled start) or any game not in its pre-game state, so a
// feed that's slow to flip a game live can't keep the day unsealed.

const db = require('./db');

const TABLES = new Set(['nhl_daily_picks', 'nhl_daily_plays']);
const FIRST_MS = 10000, RETRY_MS = 15000; // a cold serverless connection can take several seconds
// The last sealed result this server instance saw, per table and date: if the database is briefly
// unreachable after the seal, the instance still serves the sealed pick instead of a rebuilt one.
const memo = new Map();

async function run(sql, params) {
  try { return await db.withTimeout(db.query(sql, params), FIRST_MS); }
  catch { return db.withTimeout(db.query(sql, params), RETRY_MS); } // one retry, longer
}

function hasStarted(games, now = Date.now()) {
  const live = games.filter(g => !g.unavailable);
  if (live.some(g => g.state && g.state !== 'pre')) return true;
  const first = Math.min(...live.map(g => Date.parse(g.start || g.date)).filter(Number.isFinite));
  return Number.isFinite(first) && now >= first;
}

// Before the first start. → { state: 'open' } saved | { state: 'locked', payload } already sealed |
// { state: 'off' } no database | { state: 'error' }
async function draft(table, date, payload) {
  if (!TABLES.has(table)) throw new Error(`unknown lock table ${table}`);
  if (!db.hasDb || !payload) return { state: 'off' };
  try {
    await db.ensureTables();
    const r = await run(`INSERT INTO ${table} (game_date, payload, saved_at) VALUES ($1, $2, NOW())
      ON CONFLICT (game_date) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW() WHERE ${table}.locked_at IS NULL
      RETURNING locked_at`, [date, JSON.stringify(payload)]);
    if (r.rows.length) return { state: 'open' };
    const s = await run(`SELECT payload, saved_at, locked_at FROM ${table} WHERE game_date = $1`, [date]); // sealed already
    return s.rows[0] ? { state: 'locked', payload: s.rows[0].payload, savedAt: s.rows[0].saved_at, lockedAt: s.rows[0].locked_at } : { state: 'error' };
  } catch (err) { return { state: 'error', error: err.message }; }
}

// At or after the first start. → { state: 'locked' | 'late', payload, savedAt, lockedAt } |
// { state: 'off' } no database | { state: 'unconfirmed', error } database unreachable (nothing written)
async function seal(table, date, candidate) {
  if (!TABLES.has(table)) throw new Error(`unknown lock table ${table}`);
  if (!db.hasDb) return { state: 'off' };
  try {
    await db.ensureTables();
    const r = candidate
      ? await run(`INSERT INTO ${table} (game_date, payload, saved_at, locked_at) VALUES ($1, $2, NOW(), NOW())
          ON CONFLICT (game_date) DO UPDATE SET locked_at = COALESCE(${table}.locked_at, NOW())
          RETURNING payload, saved_at, locked_at, (xmax = 0) AS inserted`, [date, JSON.stringify(candidate)])
      : await run(`UPDATE ${table} SET locked_at = COALESCE(locked_at, NOW()) WHERE game_date = $1 RETURNING payload, saved_at, locked_at, false AS inserted`, [date]);
    const row = r.rows[0];
    if (!row) return { state: 'locked', payload: null };
    const out = { state: row.inserted ? 'late' : 'locked', payload: row.payload, savedAt: row.saved_at, lockedAt: row.locked_at };
    memo.set(`${table}|${date}`, { ...out, state: 'locked' });
    return out;
  } catch (err) {
    const m = memo.get(`${table}|${date}`);
    return m ? { ...m, fromMemo: true } : { state: 'unconfirmed', error: err.message };
  }
}

const lockFor = table => ({ draft: (date, p) => draft(table, date, p), seal: (date, c) => seal(table, date, c) });

module.exports = { hasStarted, draft, seal, lockFor };
