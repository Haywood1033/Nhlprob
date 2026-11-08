// lib/plays.js — the Best plays tab and the suggested same-game parlays.
//   sharp     the lib/sharp lists on tonight's games: Sharp plays (tag + workload + matchup +
//             form converging), every All-Star / Elite play across goalscorers, saves and shots,
//             and Risks & fades, with a short slate read. This is the tab's main content.
//   sections  with pasted prices (optional), every market ranked by expected value against them.
// Shots and saves have no line without prices, so the rules use the player's season average as a
// stand-in for the book line (books hang those lines close to it).

const { legSeries, priceTicket, legKey } = require('./markets');
const SH = require('./sharp');
const { GOALS_GAP } = require('./market');

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

// The market's red flag for a skater (lib/market): it expects his team to score 0.4+ goals fewer than
// the simulation does. Shown as a warning; it doesn't move anyone into Risks & fades until the
// backtest shows it predicts misses.
function marketFlag(g, team) {
  const side = team === g.home.abbrev ? 'home' : 'away', gap = g.market?.goalsGap?.[side];
  if (gap === null || gap === undefined || gap < GOALS_GAP) return [];
  const ours = g.teamTotal?.[side]?.mean, theirs = g.market.goals?.[side];
  return [{ key: 'market', text: `market disagrees: it expects ${team} to score about ${theirs?.toFixed(1)} goals, we have ${ours?.toFixed(1)}` }];
}

// Best plays: the lib/sharp lists for tonight's games — Sharp plays (several areas converging),
// every All-Star / Elite play across goalscorers, saves and shots, and Risks & fades — plus a
// short read of the slate. Each item carries what a card or row needs and opens the player panel.
function buildSharp(payload, games, book, priced, record) {
  const lg = payload.league || {};
  const leg = l => { const r = priced.get(legKey(l)); return { prob: legSeries(book, l).prob, book: r ? { raw: r.raw, dec: r.dec, ev: null } : null }; };
  const withEv = (x, bk) => (bk ? { ...bk, ev: x.prob * bk.dec - 1 } : null);
  const scorers = [], props = [];
  for (const g of games) {
    const sub = `${g.away.abbrev} @ ${g.home.abbrev}`;
    for (const p of g.players) {
      const { prob, book: bk } = leg({ game: g.id, market: 'goal', player: p.id }), opp = p.team === g.home.abbrev ? g.away.abbrev : g.home.abbrev;
      const areas = Object.fromEntries(Object.entries(SH.AREAS).map(([k, f]) => [k, f(p)]));
      scorers.push({ kind: 'goal', market: 'goal', game: g.id, player: p.id, name: p.name, team: p.team, opp, pos: p.pos, sub, title: `${p.name} anytime goal`, prob, base: SH.seasonRate(p), tier: p.badge || null, count: p.count ?? 0,
        signals: (p.signals || []).filter(s => s.on).map(s => ({ key: s.key, icon: s.icon, label: s.label, detail: s.detail })), areas, fair: american(prob), bookPrice: bk && withEv({ prob }, bk),
        sharp: SH.isSharp(p, prob), risk: SH.isRisk(p, prob), flags: [...SH.riskFlags(p, prob), ...marketFlag(g, p.team)], marketWarn: marketFlag(g, p.team)[0] || null, why: drivers(p, g, lg, 1), whyDown: drivers(p, g, lg, -1), last10: (p.last10 || []).slice(0, 10), season: p.season });
      const sl = SH.sogLine(p);
      if (sl) {
        const r = SH.propTier('sog', leg({ game: g.id, market: 'sog', player: p.id, side: 'over', line: sl.line }).prob);
        if (r && SH.tierRank(r.tier) >= 2) { const bk2 = leg({ game: g.id, market: 'sog', player: p.id, side: r.side, line: sl.line }).book;
          props.push({ kind: 'sog', market: 'sog', game: g.id, player: p.id, name: p.name, team: p.team, opp, sub, title: `${p.name} ${r.side} ${sl.line} shots`, ...r, line: sl.line, avg: sl.avg, fair: american(r.prob), bookPrice: bk2 && withEv(r, bk2),
            why: [`Season ${sl.avg.toFixed(1)} shots a game; the model expects ${p.shots.mean} tonight`, `${p.toi} min a night · ${p.shots60.toFixed(1)} shots per 60`, ...drivers(p, g, lg, r.side === 'over' ? 1 : -1).filter(t => !t.includes('expected shots')).slice(0, 1)] }); }
      }
    }
    for (const k of ['home', 'away']) {
      // Only a starter we can trust: a saves play on the wrong goalie is a voided bet at best.
      const G = g.goalies[k], sl = G && SH.starterReliable(G) && SH.savesLine(G); if (!sl) continue;
      const r = SH.propTier('saves', leg({ game: g.id, market: 'saves', team: k, side: 'over', line: sl.line }).prob);
      if (!r || SH.tierRank(r.tier) < 2) continue;
      const opp = k === 'home' ? g.away : g.home, bk2 = leg({ game: g.id, market: 'saves', team: k, side: r.side, line: sl.line }).book;
      props.push({ kind: 'saves', market: 'saves', game: g.id, goalieTeam: k, name: G.name, team: G.team, opp: opp.abbrev, sub, title: `${G.name} ${r.side} ${sl.line} saves`, ...r, line: sl.line, avg: sl.avg, fair: american(r.prob), bookPrice: bk2 && withEv(r, bk2), confirmed: !!G.projection?.confirmed,
        why: [`Season ${sl.avg.toFixed(1)} saves a start; the model has ${G.saves.mean} tonight (80% of sims ${G.saves.p10}–${G.saves.p90})`, `${G.saves.shotsAgainst} shots against projected: ${opp.abbrev} take ${opp.sfPerGame} a game`, G.projection?.confirmed ? 'Confirmed starter' : 'Projected starter: books void the bet if he sits'] });
    }
  }
  const sharp = scorers.filter(x => x.sharp).sort(SH.sortPlays).slice(0, SH.SHARP_MAX);
  const best = [...scorers.filter(x => (x.season?.gp || 0) >= 10 && SH.tierRank(x.tier) >= 2), ...props].sort(SH.sortPlays);
  const risks = scorers.filter(x => x.risk).sort((a, b) => (b.base - b.prob) - (a.base - a.prob)).slice(0, SH.RISKS_MAX);
  // The slate read: a few plain sentences, like nflprob's.
  const elite = scorers.filter(x => x.tier === 'Elite').length, hot = [...games].sort((a, b) => b.total.mean - a.total.mean)[0];
  const tired = new Set(scorers.filter(x => x.signals.some(s => s.key === 'tired')).map(x => x.opp)).size;
  const parts = [`${games.length} game${games.length === 1 ? '' : 's'} still to start.`];
  if (hot) parts.push(`Highest-event game: ${hot.away.abbrev} @ ${hot.home.abbrev} at ${hot.total.mean} goals.`);
  if (tired) parts.push(`${tired} team${tired === 1 ? ' is' : 's are'} on the second night of a back-to-back.`);
  parts.push(elite ? `${elite} Elite-tagged scorer${elite === 1 ? '' : 's'} on the board.` : 'No Elite-tagged scorers tonight.');
  parts.push(sharp.length ? `${sharp.length} play${sharp.length === 1 ? ' clears' : 's clear'} the sharp bar: these are the convergences worth trusting.` : 'Nothing clears the sharp bar tonight. Consider waiting for a better setup, or browse the All-Star plays below.');
  const rec = k => ({ latest: record?.rules?.[k]?.n ? { ...record.rules[k], days: record.days } : null });
  return {
    slateRead: parts.join(' '),
    criteria: 'All-Star+ tag · workload + matchup + form all firing · 20%+ to score',
    sharp, best, risks,
    record: { sharp: rec('sharp'), scorers: rec('scorers'), saves: rec('saves'), sog: rec('sog'), risks: rec('risks') },
    latestDays: record?.days || null,
  };
}

// Locks the day's Best plays at the first puck drop, like the play of the day: before any game
// starts the lists are rebuilt (and, with a database, saved) on every build; after, the saved lists
// are served unchanged, so a play doesn't vanish when its game starts or get replaced by a later
// game's player. Players in started games keep their card, with live goals shown on it. If nothing
// was saved in time, the lists lock on the first build after puck drop, from games not yet started.
// Only the shared view locks (a device's own starter picks without a database never save).
// lock: lib/lock lockFor('nhl_daily_plays') (write-once: drafts before the first start, sealed by the
// database at it, never overwritten; an unreachable database writes nothing → "unconfirmed").
async function lockSharp(date, games, sharp, { canSave, lock }) {
  const started = require('./lock').hasStarted(games);
  const keep = s => ({ ...s, sharp: s.sharp.map(strip), best: s.best.map(strip), risks: s.risks.map(strip) });
  const fromStore = (r, state) => ({ ...r.payload, record: sharp.record, latestDays: sharp.latestDays, lock: { state, savedAt: r.savedAt, lockedAt: r.lockedAt } });
  if (!started) {
    const r = canSave ? await lock.draft(date, keep(sharp)) : { state: 'off' };
    return r.payload ? fromStore(r, 'locked') : { ...sharp, lock: { state: r.state } };
  }
  const r = await lock.seal(date, { ...keep(sharp), lockedLate: new Date().toISOString() });
  return r.payload ? fromStore(r, r.state) : { ...sharp, lock: { state: r.state } };
}
// A locked play keeps its pre-game numbers, not a price pasted later.
function strip(x) { const { bookPrice, ...rest } = x; return rest; }

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
    const legs = [{ game: g.id, market: 'ml', side: fav }, ...['over', 'under'].map(side => ({ game: g.id, market: 'total', side, line: g.leans.total.line })),
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

module.exports = { buildPlays, buildSharp, lockSharp, suggestSgps, legTitle, candidates, MIN_EV };
