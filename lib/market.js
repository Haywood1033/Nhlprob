// lib/market.js — the betting market's view of each game, from ESPN's public NHL scoreboard, read
// ONLY as a check on the model (red flags), never as an input to a projection, a lean or a pick.
//
//   moneyline   both teams' prices → the market's win chance (vig removed)
//   total       the over/under → with the win chance, each team's expected goals (approximate:
//               total / 2 ± 2.5 × (win chance − 50%), the usual relation between prices and team totals)
//
// Flags (lib/plays, the slate): "market disagrees" on a moneyline lean when the market gives our
// side 7+ points less chance than we do, and on a goalscorer when the market expects his team to
// score 0.4+ goals fewer than the simulation does. The backtest grades both.

const { fetchJson, mapLimit } = require('./http');

const SB = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';
// ESPN's abbreviations that differ from the NHL's.
const ABBR = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', UTAH: 'UTA', WAS: 'WSH', MON: 'MTL', NAS: 'NSH', CLB: 'CBJ', ARI: 'ARI' };
const nhlAbbr = a => ABBR[a] || a;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const implied = ml => (ml === null ? null : ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));

const ML_GAP = 0.07, GOALS_GAP = 0.4;

function parseOdds(c, home, away) {
  const o = (c.odds || [])[0]; if (!o) return null;
  let hML = num(o.homeTeamOdds?.moneyLine), aML = num(o.awayTeamOdds?.moneyLine);
  const details = String(o.details || '').trim();
  const m = details.match(/^(\S+)\s+([+-]?\d+)$/);
  if ((hML === null || aML === null) && m) { const fav = nhlAbbr(m[1]), ml = Number(m[2]); if (fav === home && hML === null) hML = ml; if (fav === away && aML === null) aML = ml; }
  const hp = implied(hML), ap = implied(aML);
  let pHome = null;
  if (hp !== null && ap !== null) pHome = hp / (hp + ap);
  else if (hp !== null) pHome = hp; else if (ap !== null) pHome = 1 - ap;
  const total = num(o.overUnder);
  if (pHome === null && total === null) return null;
  const tilt = pHome === null ? 0 : 2.5 * (pHome - 0.5);
  return {
    details: details || null, provider: o.provider?.name || null, homeML: hML, awayML: aML, total, pHome: pHome === null ? null : +pHome.toFixed(4),
    goals: total === null ? null : { home: +(total / 2 + tilt).toFixed(2), away: +(total / 2 - tilt).toFixed(2) },
  };
}

// One day's lines, keyed "AWY@HOM" in NHL abbreviations. Missing or failed → empty map.
async function fetchLines(date) {
  try {
    const raw = await fetchJson(`${SB}?dates=${date.replace(/-/g, '')}`, { ttlMs: 10 * 60 * 1000, timeoutMs: 10000, retries: 0 });
    const out = new Map();
    for (const ev of raw.events || []) {
      const c = ev.competitions?.[0]; if (!c) continue;
      const h = c.competitors?.find(x => x.homeAway === 'home'), a = c.competitors?.find(x => x.homeAway === 'away');
      if (!h || !a) continue;
      const home = nhlAbbr(h.team?.abbreviation), away = nhlAbbr(a.team?.abbreviation);
      const line = parseOdds(c, home, away);
      if (line) out.set(`${away}@${home}`, line);
    }
    return out;
  } catch { return new Map(); }
}
async function fetchLinesForDates(dates) { const maps = await mapLimit(dates, 6, fetchLines); return new Map(dates.map((d, i) => [d, maps[i]])); }

// The market against the model for one game. pHome: model home win chance; goals: model team means.
function compare(line, { pHome, goals, leanSide }) {
  if (!line) return null;
  const mkSide = line.pHome === null ? null : leanSide === 'home' ? line.pHome : 1 - line.pHome;
  const ourSide = leanSide === 'home' ? pHome : 1 - pHome;
  const mlGap = mkSide === null ? null : +(ourSide - mkSide).toFixed(4);
  const goalsGap = line.goals && goals ? { home: +(goals.home - line.goals.home).toFixed(2), away: +(goals.away - line.goals.away).toFixed(2) } : null;
  return { ...line, mlGap, mlFlag: mlGap !== null && mlGap >= ML_GAP, goalsGap };
}

module.exports = { fetchLines, fetchLinesForDates, parseOdds, compare, nhlAbbr, ML_GAP, GOALS_GAP, SB };
