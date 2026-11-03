// lib/book.js — pasted sportsbook prices → priced legs. One line per price, comma or tab
// separated, American or decimal odds:
//   Auston Matthews, anytime, +120          anytime goalscorer (also: first, 2+)
//   Auston Matthews, sog o3.5, -130         shots on goal (sog u2.5, shots over 3.5)
//   Joseph Woll, saves o27.5, -115          a starting goalie's saves
//   TOR, ml, -150                           moneyline (team abbreviation or name)
//   TOR, pl -1.5, +170                      puck line
//   TOR @ MTL, over 6.5, -110               game total (or: under 5.5)
//   TOR, tt o3.5, +105                      team total
// Names are matched to the slate's skaters and starting goalies (lib/names); teams by
// abbreviation, nickname or full name. Unmatched lines come back with a reason.

const { buildMatcher, normName } = require('./names');

function toDecimal(raw) {
  const s = String(raw || '').trim().replace('−', '-');
  if (/^[+-]\d+$/.test(s)) { const a = Number(s); return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  const d = Number(s);
  return Number.isFinite(d) && d > 1 && d < 1000 ? d : null;
}

const ou = s => { const m = String(s).toLowerCase().replace(/\s+/g, ' ').match(/(?:^|\s)(o|u|over|under)\s*([\d.]+)$/); return m ? { side: m[1][0] === 'o' ? 'over' : 'under', line: Number(m[2]) } : null; };

function parseBook(text, games) {
  const skaters = games.flatMap(g => g.players.map(p => ({ name: p.name, id: p.id, game: g.id, kind: 'skater' })));
  const goalies = games.flatMap(g => ['home', 'away'].filter(k => g.goalies[k]).map(k => ({ name: g.goalies[k].name, id: g.goalies[k].id, game: g.id, team: k, kind: 'goalie' })));
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
    const who = parts[0], mk = parts[1].toLowerCase(), dec = toDecimal(parts[2]);
    if (!dec) { skipped.push({ line: raw, why: `Couldn't read the odds "${parts[2]}"` }); continue; }
    const fail = why => skipped.push({ line: raw, why });
    let m;
    if (/^(anytime|atgs|any time|to score|goal)$/.test(mk) || /^(first|fgs|first goal(scorer)?)$/.test(mk) || /^(2\+|two\+|2\+ goals|two or more)$/.test(mk)) {
      const p = matchSkater(who);
      if (!p) { fail(`Couldn't match "${who}" to a skater on this slate`); continue; }
      rows.push({ game: p.game, market: /^(first|fgs)/.test(mk) ? 'first' : /2|two/.test(mk) ? 'goal2' : 'goal', player: p.id, dec, raw: parts[2] });
    } else if (/^(sog|shots|shots on goal)\b/.test(mk) && (m = ou(mk))) {
      const p = matchSkater(who);
      if (!p) { fail(`Couldn't match "${who}" to a skater on this slate`); continue; }
      rows.push({ game: p.game, market: 'sog', player: p.id, side: m.side, line: m.line, dec, raw: parts[2] });
    } else if (/^saves\b/.test(mk) && (m = ou(mk))) {
      const g = matchGoalie(who);
      if (!g) { fail(`Couldn't match "${who}" to a projected starting goalie`); continue; }
      rows.push({ game: g.game, market: 'saves', team: g.team, side: m.side, line: m.line, dec, raw: parts[2] });
    } else if (/^(ml|moneyline|win|to win)$/.test(mk)) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'ml', side: t.side, dec, raw: parts[2] });
    } else if ((m = mk.match(/^(pl|puck ?line|spread)\s*([+-]?[\d.]+)$/))) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'pl', side: t.side, line: Number(m[2]), dec, raw: parts[2] });
    } else if (/^(tt|team total)\b/.test(mk) && (m = ou(mk))) {
      const t = matchTeam(who);
      if (!t) { fail(`Couldn't match the team "${who}"`); continue; }
      rows.push({ game: t.game, market: 'tt', team: t.side, side: m.side, line: m.line, dec, raw: parts[2] });
    } else if ((m = ou(mk)) && /^(o|u|over|under|total|p1|1st)/.test(mk)) {
      const [x, y] = who.split(/\s+(?:@|vs\.?|v\.?|at)\s+/i);
      const t = (x && matchTeam(x)) || (y && matchTeam(y));
      if (!t) { fail(`Couldn't match "${who}" to a game`); continue; }
      rows.push({ game: t.game, market: /^(p1|1st)/.test(mk) ? 'p1' : 'total', side: m.side, line: m.line, dec, raw: parts[2] });
    } else fail(`Unknown market "${parts[1]}"`);
  }
  return { rows, skipped };
}

module.exports = { parseBook, toDecimal };
