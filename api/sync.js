// GET /api/sync — backfill completed games into Postgres (two seasons). Each call does what fits
// in ~45s and reports `remaining`; call again until it reaches 0. The nightly cron (?cron=1) adds
// yesterday's games and grades yesterday's snapshots.
// GET /api/sync?snapshot=1 — builds today's slate so each game's pre-game projection is saved even
// if nobody opens the site before puck drop (daily cron).
const { sync } = require('../lib/store');
const { gradeAll } = require('../lib/grading');
const db = require('../lib/db');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (param(req, 'snapshot')) {
      const { buildSlate } = require('../lib/slate');
      const { payload: p } = await buildSlate();
      return send(res, 200, { date: p.date, games: p.games.length, pregame: p.games.filter(g => g.state === 'pre').length, snapshot: p.snapshot });
    }
    if (!db.hasDb) return send(res, 400, { error: `No database connected — set ${db.DB_VARS[0]} (or ${db.DB_VARS[1]}). History sync needs Postgres.` });
    const result = await sync({ deadline: Date.now() + 45000 });
    const grading = await gradeAll({ deadline: Date.now() + 8000 }).catch(err => ({ error: err.message }));
    send(res, 200, { ...result, grading });
  } catch (err) { fail(res, err); }
};
