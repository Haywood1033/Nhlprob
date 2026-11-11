// GET /api/sync — backfill completed games into Postgres (two seasons). Each call does what fits
// in ~45s and reports `remaining`; call again until it reaches 0. The nightly cron (?cron=1) adds
// yesterday's games and grades yesterday's snapshots.
// GET /api/sync?snapshot=1 — builds today's slate so each game's pre-game projection is saved even
// if nobody opens the site before puck drop (daily cron).
const { sync } = require('../lib/store');
const { gradeAll } = require('../lib/grading');
const db = require('../lib/db');
const { param, send, fail } = require('./_util');

// Optional lock: with CRON_SECRET set in Vercel, only the crons (Vercel sends it as a Bearer token)
// and a caller passing ?key=<CRON_SECRET> can run a sync. Without it the route stays open.
function allowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers?.authorization === `Bearer ${secret}` || param(req, 'key') === secret;
}

module.exports = async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 401, { error: 'This route needs the CRON_SECRET (as a Bearer token, or ?key=).' });
    if (param(req, 'snapshot')) {
      const { getSlateContext } = require('../lib/slate'), { makeBook } = require('../lib/markets'), { buildPlays, lockSharp } = require('../lib/plays'), st = require('../lib/store');
      const { payload: p, sims } = await getSlateContext();
      // Best plays too, so the day's lists are saved (and lock at puck drop) even if nobody opens the tab.
      const plays = await lockSharp(p.date, p.games, buildPlays(p, makeBook(sims), [], null).sharp, { canSave: true, lock: require('../lib/lock').lockFor('nhl_daily_plays') }).catch(err => ({ lock: { state: 'error', error: err.message } }));
      return send(res, 200, { date: p.date, games: p.games.length, pregame: p.games.filter(g => g.state === 'pre').length, snapshot: p.snapshot, bestPlays: plays.lock });
    }
    if (!db.hasDb) return send(res, 400, { error: db.notConnected('history sync has nowhere to save'), seen: db.seenDbVars() });
    // The nightly cron also re-runs the replay test and stores it (the Accuracy tab shows the latest),
    // but only when the sync left enough of the function's 60 seconds: a cut-off run saves nothing.
    const t0 = Date.now(), cron = !!param(req, 'cron');
    const result = await sync({ deadline: t0 + (cron ? 25000 : 45000) });
    const grading = await gradeAll({ deadline: Date.now() + (cron ? 5000 : 8000) }).catch(err => ({ error: err.message }));
    // Then one model effect is tested on vs off over the last few days (lib/effects): the one with
    // the least evidence so far, so every effect builds its record over the nights.
    let backtest = null, effect = null;
    if (cron && result.remaining === 0 && Date.now() - t0 < 22000) {
      try { const bt = await require('./backtest').runAndSave({ days: 14, trigger: 'nightly' }); backtest = { days: bt.days, games: bt.games, stored: !!bt.stored, calibrationUsed: bt.calibrationUsed ?? null }; }
      catch (err) { backtest = { error: err.message }; }
      if (Date.now() - t0 < 42000) {
        try { const key = await require('../lib/effects').nextToTest(); const r = await require('./backtest').compareAndSave({ key, days: 4 }); effect = { key, games: r.games, decision: r.decision }; }
        catch (err) { effect = { error: err.message }; }
      }
    } else if (cron) backtest = { skipped: result.remaining ? 'history backfill still running' : 'not enough time left in this run' };
    send(res, 200, { ...result, grading, backtest, effect });
  } catch (err) { fail(res, err); }
};
