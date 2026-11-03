// lib/grading.js — grades each saved pre-game snapshot (the last projection before puck drop)
// against the finished game: moneyline and totals, every projected skater who dressed (anytime
// goal), the first goalscorer, and each projected starter who started (saves). Nothing from
// after puck drop touches a snapshot, so the Accuracy tab is an honest out-of-sample record.

const db = require('./db');
const { loadGame } = require('./store');
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
    moneyline: { p: homeWon ? snap.pHome : 1 - snap.pHome, picked: (snap.pHome >= 0.5) === (homeWon === 1), logLoss: +ll(snap.pHome, homeWon).toFixed(4) },
    total: { model: snap.total.mean, actual: total, over55: { p: snap.total.over[5.5], hit: total > 5.5 }, over65: { p: snap.total.over[6.5], hit: total > 6.5 } },
    anytime: { players: players.length, scorers: scored.length, expected: +players.reduce((s, p) => s + p.anytime, 0).toFixed(2), logLoss: players.length ? +(anyLL / players.length).toFixed(4) : null, topPicks: players.slice().sort((a, b) => b.anytime - a.anytime).slice(0, 5).map(p => ({ name: p.name, p: p.anytime, scored: dressed.get(p.id).goals >= 1 })) },
    first: firstId ? { name: g.goals[0].name, p: firstSnap ? firstSnap.first : null, inLineup: !!firstSnap } : null,
    saves,
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

async function listGrades() {
  if (db.hasDb) await gradeAll({ deadline: Date.now() + 8000 }).catch(() => {});
  const storage = await require('./store').snapshotStatus();
  if (!storage.connected) return { games: [], totals: null, storage, note: storage.note };
  const r = await db.query(`SELECT game_id, game_date, name, graded FROM nhl_snapshots WHERE graded IS NOT NULL ORDER BY game_date DESC, game_id DESC LIMIT 300`);
  const games = r.rows.map(x => ({ gameId: x.game_id, date: day(x.game_date), name: x.name, ...x.graded }));
  const n = games.length, sum = f => games.reduce((s, x) => s + f(x), 0);
  const sv = games.flatMap(x => x.saves);
  const any = games.filter(x => x.anytime.players);
  const totals = n ? {
    games: n, favouritesWon: sum(x => (x.moneyline.picked ? 1 : 0)), moneylineLogLoss: sum(x => x.moneyline.logLoss) / n,
    anytime: { players: sum(x => x.anytime.players), scorers: sum(x => x.anytime.scorers), expected: +sum(x => x.anytime.expected).toFixed(1), logLoss: any.length ? any.reduce((s, x) => s + x.anytime.logLoss * x.anytime.players, 0) / any.reduce((s, x) => s + x.anytime.players, 0) : null },
    saves: { n: sv.length, mae: sv.length ? sv.reduce((s, x) => s + Math.abs(x.projected - x.actual), 0) / sv.length : null, inRange: sv.length ? sv.filter(x => x.inRange).length / sv.length : null },
    totalMae: sum(x => Math.abs(x.total.model - x.total.actual)) / n,
  } : null;
  return { storage, games: games.slice(0, 120), totals };
}

module.exports = { gradeOne, gradeAll, listGrades };
