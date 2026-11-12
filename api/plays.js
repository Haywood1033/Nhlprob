// /api/plays — Model picks (lib/sharp's lists on tonight's games, locked at the first puck drop with a
// database; see lib/plays lockSharp), with the lists' saved backtest record, and suggested same-game
// parlays. With pasted prices every market is also ranked by value.
//   GET  ?date=            the default view (no prices, no personal changes): cacheable at the edge
//   POST { book?, date?, starters?, lineups? }  with pasted prices or one viewer's own changes
const { getSlateContext, parseStarters, parseLineups } = require('../lib/slate');
const { makeBook } = require('../lib/markets');
const { parseBook } = require('../lib/book');
const { buildPlays, lockSharp } = require('../lib/plays');
const { loadBestRecord } = require('../lib/store');
const { lockFor } = require('../lib/lock');
const { body, param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const get = req.method === 'GET';
    const b = get ? { date: param(req, 'date') } : body(req);
    if (b.date && !/^\d{4}-\d\d-\d\d$/.test(b.date)) return send(res, 400, { error: 'date must be YYYY-MM-DD' });
    const starters = parseStarters(b.starters), lineups = parseLineups(b.lineups);
    const [{ payload, sims }, record] = await Promise.all([getSlateContext({ ...(b.date ? { date: b.date } : {}), starters, lineups }), loadBestRecord()]);
    const book = makeBook(sims);
    const parsed = parseBook(b.book || '', payload.games.filter(g => !g.unavailable));
    // The book's lines (lib/props) are the default prices; a price the reader pasted or typed for
    // the same bet wins. Prices only rank plays by value: they never change a chance.
    const { legKey } = require('../lib/markets');
    const mine = new Set(parsed.rows.map(legKey));
    const dk = payload.games.filter(g => !g.unavailable && g.props).flatMap(g => g.props.rows).filter(r => !mine.has(legKey(r))).map(r => ({ ...r, source: 'line' }));
    const out = buildPlays(payload, book, [...parsed.rows, ...dk], record);
    // Only the shared view locks: a viewer's own starter picks or lineup changes re-simulate games.
    out.sharp = await lockSharp(payload.date, payload.games, out.sharp, { canSave: !payload.personal, lock: lockFor('nhl_daily_plays') });
    const live = payload.games.some(g => g.state === 'in');
    send(res, 200, { ...out, sims: payload.sims, book: { matched: parsed.rows.length, skipped: parsed.skipped, rows: parsed.rows } }, get && !live ? 60 : 0);
  } catch (err) { fail(res, err); }
};
