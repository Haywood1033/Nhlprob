// POST /api/plays { book?, date? } — Best plays (lib/sharp's rules on tonight's games, with the
// rules' saved backtest record) and suggested same-game parlays. With pasted prices (lib/book's
// format) every market is also ranked by value against them.
const { getSlateContext, parseStarters } = require('../lib/slate');
const { makeBook } = require('../lib/markets');
const { parseBook } = require('../lib/book');
const { buildPlays } = require('../lib/plays');
const { loadBestRecord } = require('../lib/store');
const { body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const b = body(req);
    const [{ payload, sims }, record] = await Promise.all([getSlateContext({ ...(b.date ? { date: b.date } : {}), starters: parseStarters(b.starters) }), loadBestRecord()]);
    const book = makeBook(sims);
    const parsed = parseBook(b.book || '', payload.games.filter(g => !g.unavailable));
    send(res, 200, { ...buildPlays(payload, book, parsed.rows, record), book: { matched: parsed.rows.length, skipped: parsed.skipped, rows: parsed.rows } });
  } catch (err) { fail(res, err); }
};
