// POST /api/plays { book?, date? } — Best plays and suggested same-game parlays. With pasted
// prices (lib/book's format) sections rank by value against them; without, by the model.
const { getSlateContext } = require('../lib/slate');
const { makeBook } = require('../lib/markets');
const { parseBook } = require('../lib/book');
const { buildPlays } = require('../lib/plays');
const { body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const b = body(req);
    const { payload, sims } = await getSlateContext(b.date ? { date: b.date } : {});
    const book = makeBook(sims);
    const parsed = parseBook(b.book || '', payload.games.filter(g => !g.unavailable));
    send(res, 200, { ...buildPlays(payload, book, parsed.rows), book: { matched: parsed.rows.length, skipped: parsed.skipped, rows: parsed.rows } });
  } catch (err) { fail(res, err); }
};
