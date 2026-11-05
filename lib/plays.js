// lib/plays.js — the Best plays tab and the suggested same-game parlays.
//   sharp     the lib/sharp rules on tonight's games: goalscorer edges and Elite tags, goalie
//             saves, shots on goal, and fades, each with what the model sees, the price it's
//             worth and the rule's record. This is the tab's main content.
//   sections  with pasted prices, every market ranked by expected value against them (anytime,
//             first goal, shots, saves, moneylines, totals). Without prices they're not shown:
//             ranking by the model alone just lists the likeliest outcomes, which the price
//             already reflects.
// Shots and saves have no line without prices, so the rules use the player's season average as a
// stand-in for the book line (books hang those lines close to it).

const { legSeries, priceTicket, legKey } = require('./markets');
const SH = require('./sharp');

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

// What moves a skater's chance off his season rate tonight, strongest first, in the direction
// asked (up for edges, down for fades): shot volume, the goalie, the defense, the game's pace.
function drivers(p, g, lg, dir) {
  const home = p.team === g.home.abbrev, opp = home ? g.away : g.home, oppG = home ? g.goalies.away : g.goalies.home;
  const spg = p.season.gp ? p.season.shots / p.season.gp : null, out = [];
  if (spg) out.push({ v: (p.expShots - spg) / spg, t: `${p.expShots.toFixed(1)} expected shots vs his ${spg.toFixed(1)} a game` });
  // Finishing luck: his season shooting % against the regressed rate the model uses.
  const sh = p.season.shots ? p.season.goals / p.season.shots : null;
  if (sh !== null && p.season.shots >= 15 && p.shPct) out.push({ v: ((p.shPct - sh) / p.shPct) * 0.6, t: `shooting ${(sh * 100).toFixed(1)}% this season (${p.season.goals} on ${p.season.shots}); the model uses ${(p.shPct * 100).toFixed(1)}%, since finishing evens out` });
  if (oppG && lg.svPct) out.push({ v: (lg.svPct - oppG.svPct) * 25, t: `${oppG.name} ${(oppG.svPct * 100).toFixed(1)}% save rate vs league ${(lg.svPct * 100).toFixed(1)}%${oppG.projection?.confirmed ? '' : ' (projected starter)'}` });
  if (lg.sogPerTeam) out.push({ v: (opp.saPerGame - lg.sogPerTeam) / lg.sogPerTeam, t: `${opp.abbrev} allow ${opp.saPerGame} shots a game vs league ${lg.sogPerTeam}` });
  if (lg.goalsPerGame) out.push({ v: (g.total.mean - lg.goalsPerGame) / lg.goalsPerGame, t: `game total ${g.total.mean} goals vs league ${lg.goalsPerGame}` });
  return out.filter(x => x.v * dir > 0.02).sort((a, b) => b.v * dir - a.v * dir).slice(0, 3).map(x => x.t);
}

// Best plays: the lib/sharp rules applied to tonight's games. Every pick says what the model sees
// that his season numbers don't, the price it's worth, and how the rule has done.
function buildSharp(payload, games, book, priced, record) {
  const lg = payload.league || {}, cands = [];
  const leg = l => { const r = priced.get(legKey(l)); return { prob: legSeries(book, l).prob, book: r ? { raw: r.raw, dec: r.dec, implied: 1 / r.dec } : null }; };
  for (const g of games) {
    const sub = `${g.away.abbrev} @ ${g.home.abbrev}`;
    for (const p of g.players) {
      const L = { game: g.id, market: 'goal', player: p.id }, { prob, book: bk } = leg(L);
      for (const r of [SH.scorerRule(p, prob), SH.fadeRule(p, prob)].filter(Boolean)) cands.push({ ...L, ...r, prob, book: bk, sub, title: `${p.name} anytime goal`, team: p.team, badge: p.badge || null, count: p.count, p, g });
      const sl = SH.sogLine(p);
      if (sl) {
        const r = SH.sogRule(leg({ game: g.id, market: 'sog', player: p.id, side: 'over', line: sl.line }).prob);
        if (r) { const l2 = { game: g.id, market: 'sog', player: p.id, side: r.side, line: sl.line }; cands.push({ ...l2, ...r, ...sl, book: leg(l2).book, sub, title: `${p.name} ${r.side} ${sl.line} shots`, team: p.team, p, g }); }
      }
    }
    for (const k of ['home', 'away']) {
      const G = g.goalies[k], sl = G && SH.savesLine(G); if (!sl) continue;
      const r = SH.savesRule(leg({ game: g.id, market: 'saves', team: k, side: 'over', line: sl.line }).prob);
      if (r) { const l2 = { game: g.id, market: 'saves', team: k, side: r.side, line: sl.line }; cands.push({ ...l2, ...r, ...sl, book: leg(l2).book, sub, title: `${G.name} ${r.side} ${sl.line} saves`, team: G.team, G, g, home: k === 'home' }); }
    }
  }
  const shown = SH.capNight(cands);
  const rec = k => ({ set: SH.SET_RECORD[k], latest: record?.rules?.[k]?.n ? { ...record.rules[k], days: record.days, savedAt: record.savedAt } : null });
  const view = x => {
    const fair = american(x.prob), ev = x.book && x.rule !== 'fade' ? x.prob * x.book.dec - 1 : null;
    let insight, why;
    if (x.rule === 'edge' || x.rule === 'elite' || x.rule === 'fade') {
      insight = x.rule === 'fade'
        ? `His season rate says ${pct(x.base)} (around ${american(x.base)}); the model has ${pct(x.prob)} tonight. A price built on his season number is too short: pass, or play against him in a parlay.`
        : x.rule === 'elite'
          ? `${x.count} of 8 signals firing. Model ${pct(x.prob)}, ${x.ratio >= 1.05 ? `${x.ratio.toFixed(2)}× his season rate` : 'in line with his season rate'}. Worth it at ${fair} or longer.`
          : `Model ${pct(x.prob)} vs ${pct(x.base)} from his season scoring rate (${x.ratio.toFixed(2)}×). Fair ${fair}; a line set off his season rate would be near ${american(x.base)}, so ${fair} or longer is value.`;
      why = drivers(x.p, x.g, lg, x.rule === 'fade' ? -1 : 1);
      if (x.rule === 'elite') why.unshift((x.p.signals || []).filter(s => s.on).map(s => `${s.icon} ${s.label}`).join(' · '));
      const l = x.p.last10 || [];
      if (l.length >= 5) why.push(`Last ${l.length}: ${l.reduce((s, y) => s + y.goals, 0)} G on ${l.reduce((s, y) => s + y.shots, 0)} shots · season ${x.p.season.goals} G in ${x.p.season.gp} GP`);
    } else if (x.rule === 'savesOver' || x.rule === 'savesUnder') {
      const G = x.G, opp = x.home ? x.g.away : x.g.home;
      insight = `Model ${pct(x.prob)} to go ${x.side} ${x.line} saves (his season average ${x.avg.toFixed(1)}). Worth it at ${fair} or better.`;
      why = [`${G.saves.shotsAgainst} shots against projected: ${opp.abbrev} take ${opp.sfPerGame} a game`, `${G.saves.mean} saves on average; 80% of simulated games ${G.saves.p10}–${G.saves.p90}`, `Save rate ${(G.svPct * 100).toFixed(1)}% (model) · ${G.projection?.confirmed ? 'confirmed starter' : 'projected starter: bets void if he sits'}`];
    } else {
      insight = `Model ${pct(x.prob)} to go ${x.side} ${x.line} shots (his season average ${x.avg.toFixed(1)}; the model expects ${x.p.shots.mean}). Worth it at ${fair} or better.`;
      why = [`${x.p.toi} min a night · ${x.p.shots60.toFixed(1)} shots per 60`, ...drivers(x.p, x.g, lg, x.side === 'over' ? 1 : -1).slice(0, 2)];
    }
    if (x.book) why.unshift(x.rule === 'fade' ? `Your price ${x.book.raw} implies ${pct(x.book.implied)}; model ${pct(x.prob)}` : `Your price ${x.book.raw}: EV ${ev >= 0 ? '+' : '−'}$${Math.abs(ev).toFixed(2)} per $1`);
    const { p, G, g, ...rest } = x;
    return { ...rest, fairOdds: fair, ev, insight, why: why.filter(Boolean), record: rec(x.rule), ruleLabel: SH.RULES[x.rule].label };
  };
  const of = rules => shown.filter(x => rules.includes(x.rule)).map(view);
  return {
    groups: [
      { key: 'scorers', title: 'Goalscorers', note: 'Elite tags, then the biggest gaps between the model and the player’s season scoring rate (top 3 a night).', items: of(['elite', 'edge']).sort((a, b) => (b.rule === 'elite') - (a.rule === 'elite') || (b.prob - b.base) - (a.prob - a.base)) },
      { key: 'saves', title: 'Goalie saves', note: 'Against a line at his season saves per start; books hang theirs close to it. Paste the real line to check the price.', items: of(['savesOver', 'savesUnder']).sort((a, b) => b.prob - a.prob) },
      { key: 'sog', title: 'Shots on goal', note: 'Against a line at his season shots per game. Unders are the stronger rule.', items: of(['sogUnder', 'sogOver']).sort((a, b) => b.prob - a.prob) },
      { key: 'fades', title: 'Fades', note: 'Big names the model is well below tonight. Their price is probably built on the season number.', items: of(['fade']).sort((a, b) => (b.base - b.prob) - (a.base - a.prob)) },
    ],
    rules: SH.RULES, setWindow: SH.SET_RECORD.window, latestRecord: record ? { days: record.days, savedAt: record.savedAt } : null,
  };
}

function buildPlays(payload, book, bookRows = [], record = null) {
  const games = payload.games.filter(g => !g.unavailable && g.state === 'pre');
  const byId = new Map(games.map(g => [g.id, g]));
  const priced = new Map(bookRows.filter(r => byId.has(r.game)).map(r => [legKey(r), r]));
  const people = new Map(games.flatMap(g => [...g.players.map(p => [`${g.id}|${p.id}`, p]), ...['home', 'away'].filter(k => g.goalies[k]).map(k => [`${g.id}|G${k}`, g.goalies[k]])]));
  const item = l => {
    const g = byId.get(l.game), prob = legSeries(book, l).prob, r = priced.get(legKey(l));
    const p = l.player ? people.get(`${g.id}|${l.player}`) : null, G = l.market === 'saves' ? people.get(`${g.id}|G${l.team}`) : null;
    const reasons = p ? playerReasons(p, g) : G ? goalieReasons(G, g, l.team === 'home') : gameReasons(g, l.market === 'ml' ? l.side : null);
    if (l.proxy !== undefined && !r) reasons.unshift(`Line here is a stand-in from his season average (${l.proxy}); paste the real line for a price comparison`);
    return { ...l, badge: p && (l.market === 'goal' || l.market === 'goal2' || l.market === 'first') ? p.badge || null : null, count: p ? p.count : null, title: legTitle(g, l, p?.name || G?.name), sub: `${g.away.abbrev} @ ${g.home.abbrev}`, prob, fairOdds: american(prob), book: r ? { raw: r.raw, dec: r.dec, implied: 1 / r.dec, ev: prob * r.dec - 1 } : null, reasons };
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
  return { date: payload.date, minEv: MIN_EV, sharp: buildSharp(payload, games, book, priced, record), sections, sgp: suggestSgps(games, book, priced), priced: bookRows.length, generatedAt: new Date().toISOString() };
}

// Suggested same-game parlays: per game, two- and three-leg combinations of that game's leans
// (favorite, its top scorer, the total lean, each goalie's saves lean), ranked by how much the
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

module.exports = { buildPlays, buildSharp, suggestSgps, legTitle, candidates, MIN_EV };
