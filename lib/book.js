// lib/book.js — pasted sportsbook prices → priced legs. One line per price, comma or tab
// separated, American or decimal odds:
//   Auston Matthews, anytime, +120          anytime goalscorer (also: first, 2+)
//   Auston Matthews, sog o3.5, -130         shots on goal (sog u2.5, shots over 3.5)
//   Joseph Woll, saves o27.5, -115          a starting goalie's saves
//   TOR, ml, -150                           moneyline (team abbreviation or name)
//   TOR, pl -1.5, +170                      puck line
//   TOR @ MTL, over 6.5, -110               game total (or: under 5.5)
//   TOR, tt o3.5, +105                      team total
// Odds: American with or without a sign (+150, 150, -110), EVEN, or decimal (2.50). A bare whole
// number of 100 or more is American (books show plus prices without the sign), below that decimal.
// Each line is read from the right (odds, then market), so "Last, First" names work:
//   Matthews, Auston, anytime, +120
// Two players with the same name need a qualifier: "Elias Pettersson (VAN)", "Sebastian Aho (D)".
// Names are matched to the slate's skaters and starting goalies (lib/names); teams by
// abbreviation, nickname or full name. Unmatched lines come back with a reason.

const { buildMatcher, normName, AMBIGUOUS } = require('./names');

function toDecimal(raw) {
  const s = String(raw || '').trim().replace(/[−–]/g, '-').replace(/\s+/g, '');
  if (/^(even|evens|ev|ev\+?)$/i.test(s)) return 2;
  if (/^[+-]\d+(\.0+)?$/.test(s) || /^\d{3,}$/.test(s)) {
    const a = Number(s);
    if (Math.abs(a) < 100) return null; // -50 or +80 isn't a price
    return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }
  const d = Number(s);
  return Number.isFinite(d) && d > 1 && d <= 51 ? d : null; // decimal tops out at 51.0 (+5000); "80" is a typo, not a price
}

const ou = s => { const m = String(s).toLowerCase().replace(/\s+/g, ' ').match(/(?:^|\s)(o|u|over|under)\s*([\d.]+)$/); return m ? { side: m[1][0] === 'o' ? 'over' : 'under', line: Number(m[2]) } : null; };

function parseBook(text, games) {
  const skaters = games.flatMap(g => g.players.map(p => ({ name: p.name, id: p.id, game: g.id, team: p.team, pos: p.pos, kind: 'skater' })));
  const goalies = games.flatMap(g => ['home', 'away'].filter(k => g.goalies[k]).map(k => ({ name: g.goalies[k].name, id: g.goalies[k].id, game: g.id, team: g.goalies[k].team || g[k].abbrev, side: k, pos: 'G', kind: 'goalie' })));
  const matchSkater = buildMatcher(skaters), matchGoalie = buildMatcher(goalies);
  const teamKeys = [];
  for (const g of games) for (const k of ['home', 'away']) { const t = g[k]; for (const n of [t.abbrev, t.name, t.short]) if (n) teamKeys.push([normName(n), { game: g.id, side: k }]); }
  const matchTeam = raw => { const n = normName(raw); return teamKeys.find(([k]) => k === n)?.[1] || null; };
  const rows = [], skipped = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(/\t|,/).map(s => s.trim());
    if (parts.length < 3) { skipped.push({ line: raw, why: 'Needs at least: name, market, odds' }); continue; }
    // Read from the right: the last field is the odds, the one before it the market, and the rest
    // (commas and all) the name, so "Matthews, Auston" survives.
    const oddsRaw = parts.at(-1), mkRaw = parts.at(-2), who = parts.slice(0, -2).join(', ');
    const mk = mkRaw.toLowerCase(), dec = toDecimal(oddsRaw);
    if (!dec) { skipped.push({ line: raw, why: `Couldn't read the odds "${oddsRaw}" (use +150, 150, -110, EVEN or 2.50)` }); continue; }
    const fail = why => skipped.push({ line: raw, why });
    const who2 = (m, kind) => m === AMBIGUOUS ? `More than one ${kind} on this slate is called "${who}": add the team or position in brackets, e.g. "${who} (D)" or "${who} (VAN)"` : `Couldn't match "${who}" to a ${kind} on this slate`;
    let m;
    if (/^(anytime|atgs|any time|to score|goal)$/.test(mk) || /^(first|fgs|first goal(scorer)?)$/.test(mk) || /^(2\+|two\+|2\+ goals|two or more)$/.test(mk)) {
      const p = matchSkater(who);
      if (!p || p === AMBIGUOUS) { fail(who2(p, 'skater')); continue; }
      rows.push({ game: p.game, market: /^(first|fgs)/.test(mk) ? 'first' : /2|two/.test(mk) ? 'goal2' : 'goal', player: p.id, dec, raw: oddsRaw });
    } else if (/^(sog|shots|shots on goal)\b/.test(mk) && (m = ou(mk))) {
      const p = matchSkater(who);
      if (!p || p === AMBIGUOUS) { fail(who2(p, 'skater')); continue; }
      rows.push({ game: p.game, market: 'sog', player: p.id, side: m.side, line: m.line, dec, raw: oddsRaw });
    } else if (/^saves\b/.test(mk) && (m = ou(mk))) {
      const g = matchGoalie(who);
      if (!g || g === AMBIGUOUS) { fail(g === AMBIGUOUS ? who2(g, 'starting goalie') : `Couldn't match "${who}" to a projected starting goalie`); continue; }
      rows.push({ game: g.game, market: 'saves', team: g.side, side: m.side, line: m.line, dec, raw: oddsRaw });
    } else if (/^(ml|moneyline|win|to win)$/.test(mk)) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'ml', side: t.side, dec, raw: oddsRaw });
    } else if ((m = mk.match(/^(pl|puck ?line|spread)\s*([+-]?[\d.]+)$/))) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'pl', side: t.side, line: Number(m[2]), dec, raw: oddsRaw });
    } else if (/^(tt|team total)\b/.test(mk) && (m = ou(mk))) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'tt', team: t.side, side: m.side, line: m.line, dec, raw: oddsRaw });
    } else if ((m = ou(mk)) && /^(o|u|over|under|total|p1|1st)/.test(mk)) {
      const [x, y] = who.split(/\s+(?:@|vs\.?|v\.?|at)\s+/i);
      const t = (x && matchTeam(x)) || (y && matchTeam(y));
      if (!t) { fail(`Couldn't match "${who}" to a game`); continue; }
      rows.push({ game: t.game, market: /^(p1|1st)/.test(mk) ? 'p1' : 'total', side: m.side, line: m.line, dec, raw: oddsRaw });
    } else fail(`Unknown market "${mkRaw}"`);
  }
  return { rows, skipped };
}

module.exports = { parseBook, toDecimal };
