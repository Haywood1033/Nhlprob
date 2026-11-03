// lib/markets.js — every bet priced inside the simulated games. Within a game, legs are
// counted from the same runs, so correlations come for free: a team's moneyline and its top
// scorer's anytime goal move together; a goalie's saves over and the game's total under do too.
// Games are simulated independently, so legs from different games multiply as they should, but
// still through the same run index, so one code path prices any ticket.
//
// Leg: { game, market, side?, line?, player?, dec? }
//   ml        side home | away                         moneyline (overtime and shootout count)
//   pl        side home | away, line -1.5 | 1.5        puck line
//   total     side over | under, line                  game total
//   tt        side over | under, line, team home|away  team total
//   p1        side over | under, line                  first-period total
//   first_team side home | away                        team to score first
//   goal      player                                   anytime goalscorer (no shootout goals)
//   goal2     player                                   2+ goals
//   first     player                                   first goalscorer
//   sog       player, side over | under, line          shots on goal
//   saves     team home | away, side over | under, line  that team's starting goalie's saves

const MARKETS = ['ml', 'pl', 'total', 'tt', 'p1', 'first_team', 'goal', 'goal2', 'first', 'sog', 'saves'];
const PLAYER = new Set(['goal', 'goal2', 'first', 'sog']);

function legKey(l) { return [l.game, l.market, l.side || '', l.line ?? '', l.player ?? '', l.team || ''].join('|'); }

function hitFn(sim, leg) {
  const S = sim.sims, line = Number(leg.line), over = leg.side !== 'under';
  const cmp = v => (over ? v > line : v < line);
  const pIdx = PLAYER.has(leg.market) ? sim.players.indexOf(Number(leg.player)) : -1;
  if (PLAYER.has(leg.market) && pIdx < 0) return null;
  const home = leg.side === 'home' || leg.team === 'home';
  switch (leg.market) {
    case 'ml': return k => (home ? sim.hg[k] > sim.ag[k] : sim.ag[k] > sim.hg[k]);
    case 'pl': return k => { const d = home ? sim.hg[k] - sim.ag[k] : sim.ag[k] - sim.hg[k]; return d + line > 0; };
    case 'total': return k => cmp(sim.hg[k] + sim.ag[k]);
    case 'tt': return k => cmp(leg.team === 'away' ? sim.ag[k] : sim.hg[k]);
    case 'p1': return k => cmp(sim.p1H[k] + sim.p1A[k]);
    case 'first_team': return k => sim.firstTeam[k] === (home ? 0 : 1);
    case 'goal': return k => sim.goals[pIdx * S + k] >= 1;
    case 'goal2': return k => sim.goals[pIdx * S + k] >= 2;
    case 'first': return k => sim.firstScorer[k] === pIdx;
    case 'sog': return k => cmp(sim.shots[pIdx * S + k]);
    case 'saves': return k => cmp(leg.team === 'away' ? sim.svA[k] : sim.svH[k]);
    default: return null;
  }
}

function validLeg(book, l) {
  const sim = book.byId.get(String(l.game));
  if (!sim || !MARKETS.includes(l.market)) return false;
  if ((l.market === 'ml' || l.market === 'pl' || l.market === 'first_team') && l.side !== 'home' && l.side !== 'away') return false;
  if (['pl', 'total', 'tt', 'p1', 'sog', 'saves'].includes(l.market) && !Number.isFinite(Number(l.line))) return false;
  if (['total', 'tt', 'p1', 'sog', 'saves'].includes(l.market) && l.side !== 'over' && l.side !== 'under') return false;
  if ((l.market === 'tt' || l.market === 'saves') && l.team !== 'home' && l.team !== 'away') return false;
  if (PLAYER.has(l.market) && !sim.players.includes(Number(l.player))) return false;
  return true;
}

function legSeries(book, leg) {
  const key = legKey(leg);
  let out = book.series.get(key);
  if (out) return out;
  const sim = book.byId.get(String(leg.game)), S = sim.sims, f = hitFn(sim, leg);
  const hit = new Uint8Array(S); let sum = 0;
  for (let k = 0; k < S; k++) { hit[k] = f(k) ? 1 : 0; sum += hit[k]; }
  out = { hit, prob: sum / S };
  book.series.set(key, out);
  return out;
}

// book: { byId: Map(gameId -> sim), sims, series cache }
function makeBook(sims) { const arr = [...sims.values()]; return { byId: new Map(arr.map(s => [String(s.id), s])), sims: arr[0]?.sims || 0, series: new Map() }; }

function priceTicket(book, legs) {
  if (!legs.length) return { error: 'Add at least one leg.' };
  const bad = legs.find(l => !validLeg(book, l));
  if (bad) return { error: `Can't price this leg: ${JSON.stringify(bad)}` };
  const S = book.sims, series = legs.map(l => legSeries(book, l));
  let joint = 0;
  for (let k = 0; k < S; k++) { let h = 1; for (const x of series) if (!x.hit[k]) { h = 0; break; } joint += h; }
  joint /= S;
  const independent = series.reduce((a, x) => a * x.prob, 1);
  const allDec = legs.every(l => l.dec > 1), bookDecimal = allDec ? legs.reduce((a, l) => a * l.dec, 1) : null;
  return { legs: legs.map((l, i) => ({ ...l, prob: series[i].prob })), joint, independent, lift: independent ? joint / independent : null, fairDecimal: joint ? 1 / joint : null, bookDecimal, ev: allDec ? joint * bookDecimal - 1 : null };
}

module.exports = { MARKETS, legKey, validLeg, legSeries, makeBook, priceTicket };
