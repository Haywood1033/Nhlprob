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
      const { getSlateContext } = require('../lib/slate'), { makeBook } = require('../lib/markets'), { buildPlays, lockSharp } = require('../lib/plays'), st = require('../lib/store');
      const { payload: p, sims } = await getSlateContext();
      // Best plays too, so the day's lists are saved (and lock at puck drop) even if nobody opens the tab.
      const plays = await lockSharp(p.date, p.games, buildPlays(p, makeBook(sims), [], null).sharp, { canSave: true, load: st.loadDailyPlays, save: st.saveDailyPlays }).catch(err => ({ lock: { state: 'error', error: err.message } }));
      return send(res, 200, { date: p.date, games: p.games.length, pregame: p.games.filter(g => g.state === 'pre').length, snapshot: p.snapshot, bestPlays: plays.lock });
    }
    if (!db.hasDb) return send(res, 400, { error: db.notConnected('history sync has nowhere to save'), seen: db.seenDbVars() });
    const result = await sync({ deadline: Date.now() + 45000 });
    const grading = await gradeAll({ deadline: Date.now() + 8000 }).catch(err => ({ error: err.message }));
    send(res, 200, { ...result, grading });
  } catch (err) { fail(res, err); }
};
