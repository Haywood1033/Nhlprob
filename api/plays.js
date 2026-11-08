// POST /api/plays { book?, date? } — Best plays (lib/sharp's lists on tonight's games, locked at the
// first puck drop with a database; see lib/plays lockSharp), with the lists' saved backtest record,
// and suggested same-game parlays. With pasted prices every market is also ranked by value.
const { getSlateContext, parseStarters } = require('../lib/slate');
const { makeBook } = require('../lib/markets');
const { parseBook } = require('../lib/book');
const { buildPlays, lockSharp } = require('../lib/plays');
const { loadBestRecord } = require('../lib/store');
const { lockFor } = require('../lib/lock');
const { body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const b = body(req), starters = parseStarters(b.starters);
    const [{ payload, sims }, record] = await Promise.all([getSlateContext({ ...(b.date ? { date: b.date } : {}), starters }), loadBestRecord()]);
    const book = makeBook(sims);
    const parsed = parseBook(b.book || '', payload.games.filter(g => !g.unavailable));
    const out = buildPlays(payload, book, parsed.rows, record);
    // Only the shared view locks: a device's own starter picks (no database) re-simulate games.
    out.sharp = await lockSharp(payload.date, payload.games, out.sharp, { canSave: !starters.size, lock: lockFor('nhl_daily_plays') });
    send(res, 200, { ...out, book: { matched: parsed.rows.length, skipped: parsed.skipped, rows: parsed.rows } });
  } catch (err) { fail(res, err); }
};
