// POST /api/starters { date, team, goalieId, goalieName? } — sets tonight's starting goalie for a
// team (goalieId null clears it, back to the projection). Saved in the database, so everyone sees
// it and the saved pre-game projection uses it. Without a database the page keeps picks per
// browser instead and passes them to /api/slate.
const { setStarter, slateDate } = require('../lib/store');
const { clearSlateCache } = require('../lib/slate');
const db = require('../lib/db');
const { body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (!db.hasDb) return send(res, 400, { error: 'No database connected: starter picks are kept in this browser instead.' });
    const b = body(req), date = b.date || slateDate();
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^[A-Z]{2,4}$/.test(b.team || '')) return send(res, 400, { error: 'date (YYYY-MM-DD) and team (abbreviation) are required' });
    await setStarter(date, b.team, b.goalieId ? Number(b.goalieId) : null, b.goalieName);
    clearSlateCache();
    send(res, 200, { ok: true, date, team: b.team, goalieId: b.goalieId || null });
  } catch (err) { fail(res, err); }
};
