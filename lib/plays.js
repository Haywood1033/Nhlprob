// lib/plays.js — the Best plays tab and the suggested same-game parlays. Sections: anytime
// goalscorers, first goalscorers, shots on goal, goalie saves, moneylines, totals. With pasted
// prices a section ranks by expected value against the book; without, by the model, and it
// says so. Shots and saves have no line without prices, so their model leans use the player's
// season average as a stand-in for the book line (books hang those lines close to it).

const { legSeries, priceTicket, legKey } = require('./markets');

const MIN_EV = 0.03;
const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const american = p => (!p || p <= 0 || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
// The .5 line nearest a number (2.8 → 2.5, 3.2 → 3.5): where a book hangs a line near an average.
const nearestHalf = v => Math.round(v - 0.5) + 0.5;

function legTitle(g, l, who) {
  const T = s => (s === 'home' ? g.home.abbrev : g.away.abbrev);
  switch (l.market) {
    case 'ml': return `${T(l.side)} moneyline`;
    case 'pl': return `${T(l.side)} ${l.line > 0 ? '+' : ''}${l.line}`;
    case 'total': return `${l.side === 'over' ? 'Over' : 'Under'} ${l.line} · ${g.away.abbrev} @ ${g.home.abbrev}`;
    case 'tt': return `${T(l.team)} ${l.side} ${l.line} goals`;
    case 'p1': return `1st period ${l.side} ${l.line}`;
    case 'first_team': return `${T(l.side)} score first`;
    case 'goal': return `${who} anytime goal`;
    case 'goal2': return `${who} 2+ goals`;
    case 'first': return `${who} first goal`;
    case 'sog': return `${who} ${l.side} ${l.line} shots`;
    case 'saves': return `${who} ${l.side} ${l.line} saves`;
    default: return l.market;
  }
}

function playerReasons(p, g) {
  const opp = p.team === g.home.abbrev ? g.away : g.home, oppG = p.team === g.home.abbrev ? g.goalies.away : g.goalies.home;
  const out = [`${p.expShots.toFixed(1)} expected shots (${p.shots60.toFixed(1)} per 60 × ${p.toi.toFixed(1)} min)`, `Shooting ${(p.shPct * 100).toFixed(1)}% regressed; ${p.season.goals} G on ${p.season.shots} shots in ${p.season.gp} GP`];
  out.push(`${opp.abbrev} allow ${opp.saPerGame} shots/game${oppG ? `; ${oppG.name} ${(oppG.svPct * 100).toFixed(1)}% (${oppG.projection?.confirmed ? 'confirmed' : 'projected'})` : ''}`);
  const l = p.last10; if (l.length >= 5) out.push(`Last ${l.length}: ${l.reduce((s, x) => s + x.goals, 0)} G, ${l.reduce((s, x) => s + x.shots, 0)} shots`);
  return out;
}
function goalieReasons(G, g, home) {
  const opp = home ? g.away : g.home;
  return [`Projected ${G.saves.shotsAgainst} shots against: ${opp.abbrev} take ${opp.sfPerGame}/game, ${home ? g.home.abbrev : g.away.abbrev} allow ${(home ? g.home : g.away).saPerGame}`, `Save % ${(G.svPct * 100).toFixed(1)} regressed${G.season.svPct ? `; ${(G.season.svPct * 100).toFixed(1)} this season` : ''}`, G.projection?.reason || 'Starter'];
}
function gameReasons(g, side) {
  const me = side === 'home' ? g.home : side === 'away' ? g.away : null, op = side === 'home' ? g.away : side === 'away' ? g.home : null;
  if (!me) return [`Model total ${g.total.mean} goals; shots ${g.sog.home} – ${g.sog.away}`, `Goalies: ${g.goalies.home?.name || '—'} ${g.goalies.home ? (g.goalies.home.svPct * 100).toFixed(1) + '%' : ''} vs ${g.goalies.away?.name || '—'} ${g.goalies.away ? (g.goalies.away.svPct * 100).toFixed(1) + '%' : ''}`, `Overtime ${pct(g.overtime)} (shootout ${pct(g.shootout)})`];
  const mg = g.goalies[side], og = g.goalies[side === 'home' ? 'away' : 'home'];
  return [`Shots for ${me.sfPerGame} vs ${op.abbrev}'s ${op.sfPerGame}; allowed ${me.saPerGame} vs ${op.saPerGame}`, `Goalies: ${mg?.name || '—'} ${mg ? (mg.svPct * 100).toFixed(1) + '%' : ''} vs ${og?.name || '—'} ${og ? (og.svPct * 100).toFixed(1) + '%' : ''}`, `Record ${me.record.w}-${me.record.l}-${me.record.otl ?? 0} vs ${op.record.w}-${op.record.l}-${op.record.otl ?? 0}${side === 'home' ? '; home ice' : ''}`];
}

// Candidate legs for one game, with the line each section uses when there are no prices.
function candidates(g) {
  const out = [];
  for (const side of ['home', 'away']) out.push({ game: g.id, market: 'ml', side, kind: 'sides' });
  for (const side of ['over', 'under']) out.push({ game: g.id, market: 'total', side, line: g.leans.total.line, kind: 'totals' });
  for (const p of g.players) {
    out.push({ game: g.id, market: 'goal', player: p.id, kind: 'anytime' }, { game: g.id, market: 'first', player: p.id, kind: 'first' });
    const avg = p.season.gp ? p.season.shots / p.season.gp : p.expShots;
    if (p.season.gp >= 10 && avg >= 1.2) for (const side of ['over', 'under']) out.push({ game: g.id, market: 'sog', player: p.id, side, line: nearestHalf(avg), proxy: +avg.toFixed(2), kind: 'sog' });
  }
  for (const k of ['home', 'away']) {
    const G = g.goalies[k]; if (!G) continue;
    const avg = G.season.savesPerStart;
    if (avg && G.season.gs >= 3) for (const side of ['over', 'under']) out.push({ game: g.id, market: 'saves', team: k, side, line: nearestHalf(avg), proxy: +avg.toFixed(1), kind: 'saves' });
  }
  return out;
}

function buildPlays(payload, book, bookRows = []) {
  const games = payload.games.filter(g => !g.unavailable && g.state === 'pre');
  const byId = new Map(games.map(g => [g.id, g]));
  const priced = new Map(bookRows.filter(r => byId.has(r.game)).map(r => [legKey(r), r]));
  const people = new Map(games.flatMap(g => [...g.players.map(p => [`${g.id}|${p.id}`, p]), ...['home', 'away'].filter(k => g.goalies[k]).map(k => [`${g.id}|G${k}`, g.goalies[k]])]));
  const item = l => {
    const g = byId.get(l.game), prob = legSeries(book, l).prob, r = priced.get(legKey(l));
    const p = l.player ? people.get(`${g.id}|${l.player}`) : null, G = l.market === 'saves' ? people.get(`${g.id}|G${l.team}`) : null;
    const reasons = p ? playerReasons(p, g) : G ? goalieReasons(G, g, l.team === 'home') : gameReasons(g, l.market === 'ml' ? l.side : null);
    if (l.proxy !== undefined && !r) reasons.unshift(`Line here is a stand-in from his season average (${l.proxy}); paste the real line for a price comparison`);
    return { ...l, title: legTitle(g, l, p?.name || G?.name), sub: `${g.away.abbrev} @ ${g.home.abbrev}`, prob, fairOdds: american(prob), book: r ? { raw: r.raw, dec: r.dec, implied: 1 / r.dec, ev: prob * r.dec - 1 } : null, reasons };
  };
  // Priced lines that aren't in the default candidate set (other lines, puck lines, team totals) join their section.
  const cand = games.flatMap(candidates);
  const have = new Set(cand.map(legKey));
  for (const r of priced.values()) if (!have.has(legKey(r))) cand.push({ ...r, kind: { ml: 'sides', pl: 'sides', total: 'totals', tt: 'totals', p1: 'totals', goal: 'anytime', goal2: 'anytime', first: 'first', sog: 'sog', saves: 'saves' }[r.market] });
  const LABELS = { anytime: 'anytime goalscorer', first: 'first goalscorer', sog: 'shots-on-goal', saves: 'goalie saves', sides: 'moneyline', totals: 'total' };
  const section = kind => {
    const items = cand.filter(c => c.kind === kind).map(item);
    const hasBook = items.some(i => i.book);
    let ranked;
    if (hasBook) ranked = items.filter(i => i.book && i.book.ev >= MIN_EV && i.prob >= 0.03).sort((a, b) => b.book.ev - a.book.ev);
    else if (kind === 'sog' || kind === 'saves' || kind === 'totals') ranked = items.filter(i => i.prob >= 0.5).sort((a, b) => b.prob - a.prob); // leans vs the stand-in or standard line
    else ranked = items.filter(i => i.prob < 0.97).sort((a, b) => b.prob - a.prob);
    ranked = ranked.slice(0, kind === 'anytime' || kind === 'first' ? 10 : 8);
    const label = LABELS[kind];
    const summary = hasBook
      ? (ranked.length ? `${ranked.length} ${label} price${ranked.length > 1 ? 's' : ''} beat the book by ${pct(MIN_EV)}+ per $1. Best: ${ranked[0].title} at ${ranked[0].book.raw} (model ${pct(ranked[0].prob, 1)} vs ${pct(ranked[0].book.implied, 1)} implied).` : `None of your ${label} prices clears ${pct(MIN_EV)} expected profit against the model.`)
      : kind === 'sog' || kind === 'saves' ? `The model's biggest ${label} leans against each player's season average. Paste real lines on this tab to price them.`
        : `The model's strongest ${label} plays. Paste prices to rank by value instead.`;
    return { mode: hasBook ? 'value' : 'model', summary, items: ranked };
  };
  const sections = Object.fromEntries(Object.keys(LABELS).map(k => [k, section(k)]));
  return { date: payload.date, minEv: MIN_EV, sections, sgp: suggestSgps(games, book, priced), priced: bookRows.length, generatedAt: new Date().toISOString() };
}

// Suggested same-game parlays: per game, two- and three-leg combinations of that game's leans
// (favourite, its top scorer, the total lean, each goalie's saves lean), ranked by how much the
// legs help each other (joint chance ÷ the product of the single chances) among tickets that
// still cash often enough.
function suggestSgps(games, book, priced) {
  const out = [];
  for (const g of games) {
    const fav = g.leans.moneyline.side, favTeam = fav === 'home' ? g.home.abbrev : g.away.abbrev;
    const scorers = g.players.filter(p => p.team === favTeam).slice(0, 2);
    const legs = [{ game: g.id, market: 'ml', side: fav }, { game: g.id, market: 'total', side: g.leans.total.side, line: g.leans.total.line }, { game: g.id, market: 'total', side: g.leans.total.side === 'over' ? 'under' : 'over', line: g.leans.total.line },
      ...scorers.map(p => ({ game: g.id, market: 'goal', player: p.id })),
      ...['home', 'away'].filter(k => g.goalies[k]).flatMap(k => { const s = g.goalies[k].saves; const line = s.lines[2]?.line ?? (Math.round(s.p50) - 0.5); return [{ game: g.id, market: 'saves', team: k, side: 'over', line }, { game: g.id, market: 'saves', team: k, side: 'under', line }]; })];
    const name = l => (l.player ? g.players.find(p => p.id === l.player)?.name : l.market === 'saves' ? g.goalies[l.team]?.name : null);
    const tickets = [];
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
      for (const c of [[legs[i], legs[j]], ...legs.slice(j + 1).map(x => [legs[i], legs[j], x])]) {
        // Skip contradictions: both sides of one total, both sides of one goalie's line.
        const keys = c.map(l => `${l.market}|${l.team || ''}|${l.line ?? ''}`);
        if (new Set(keys).size < keys.length) continue;
        const withDec = c.map(l => ({ ...l, dec: priced.get(legKey(l))?.dec || null }));
        const t = priceTicket(book, withDec);
        if (t.error || t.joint < (c.length === 2 ? 0.2 : 0.1)) continue;
        tickets.push({ ...t, legs: t.legs.map(l => ({ ...l, title: legTitle(g, l, name(l)) })) });
      }
    }
    tickets.sort((a, b) => b.lift * Math.sqrt(b.joint) - a.lift * Math.sqrt(a.joint));
    const best = tickets[0];
    if (best && best.lift > 1.02) out.push({ game: g.id, matchup: `${g.away.abbrev} @ ${g.home.abbrev}`, ...best, fairOdds: american(best.joint) });
  }
  return out.sort((a, b) => b.lift - a.lift).slice(0, 8);
}

module.exports = { buildPlays, suggestSgps, legTitle, candidates, MIN_EV };
