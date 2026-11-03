// POST /api/sgp { legs: [{ game, market, side?, line?, player?, team?, dec? }], date? } — prices
// a ticket inside the simulated games: same-game legs from the same runs (correlation counted),
// legs from different games independent. Returns the joint chance, the no-correlation product,
// the lift between them, fair odds and, with prices on every leg, expected value.
const { getSlateContext } = require('../lib/slate');
const { makeBook, priceTicket } = require('../lib/markets');
const { body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const b = body(req);
    const { sims } = await getSlateContext(b.date ? { date: b.date } : {});
    const t = priceTicket(makeBook(sims), Array.isArray(b.legs) ? b.legs.slice(0, 12) : []);
    send(res, t.error ? 400 : 200, t);
  } catch (err) { fail(res, err); }
};
