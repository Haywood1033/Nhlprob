// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no database the app
// runs on the last few weeks of games fetched live; with one it keeps two seasons of history and
// the pre-game snapshots the Accuracy tab grades.
// Connection string: DATABASE_URL, or the POSTGRES_URL that Vercel's Supabase (and Neon)
// integrations set. sslmode is stripped from the URL: recent pg versions read sslmode=require as
// full certificate verification, which Supabase's pooler fails; TLS stays on via `ssl` below.
const DB_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'SUPABASE_DB_URL'];
const dbVar = DB_VARS.find(k => process.env[k]) || null;
const hasDb = !!dbVar;
// sslmode=disable is honoured (a local database without TLS); anything else connects over TLS.
const sslOff = () => { try { return new URL(process.env[dbVar]).searchParams.get('sslmode') === 'disable'; } catch { return false; } };
function connectionString() {
  try {
    const u = new URL(process.env[dbVar]);
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return process.env[dbVar]; }
}
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: connectionString(), ssl: sslOff() ? false : { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 8000 });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS nhl_games (
    game_id     VARCHAR(16) PRIMARY KEY,
    game_date   DATE NOT NULL,
    season      INTEGER,
    payload     JSONB,
    synced_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS nhl_games_date ON nhl_games (game_date);
  CREATE TABLE IF NOT EXISTS nhl_sync_days (
    game_date   DATE PRIMARY KEY,
    games       SMALLINT,
    complete    BOOLEAN,
    synced_at   TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS nhl_daily_picks (
    game_date   DATE PRIMARY KEY,
    payload     JSONB,
    saved_at    TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS nhl_starters (
    game_date   DATE NOT NULL,
    team        VARCHAR(4) NOT NULL,
    goalie_id   INTEGER NOT NULL,
    goalie_name TEXT,
    set_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (game_date, team)
  );
  CREATE TABLE IF NOT EXISTS nhl_snapshots (
    game_id     VARCHAR(16) PRIMARY KEY,
    game_date   DATE,
    name        TEXT,
    saved_at    TIMESTAMP DEFAULT NOW(),
    payload     JSONB,
    graded      JSONB,
    graded_at   TIMESTAMP
  );
`;

let ensured = false;
async function ensureTables() {
  if (!hasDb || ensured) return;
  await query(ENSURE_SQL);
  ensured = true;
}

// Resolves with fn's result, or rejects after ms — so a slow database can't hang a page load.
function withTimeout(promise, ms, what = 'database') {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { hasDb, dbVar, DB_VARS, query, ensureTables, withTimeout };
