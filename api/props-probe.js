// GET /api/props-probe — temporary: does ESPN's public odds feed carry NHL player props (the
// DraftKings lines its app shows)? Reads tonight's games and summarizes what each odds provider
// lists: prop types, how many lines, and a few samples. Reads only; writes nothing. Cached 10 min.
const { fetchJson, mapLimit } = require('../lib/http');
const { slateDate } = require('../lib/store');
const { param, send, fail } = require('./_util');

const CORE = 'https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl';
const SB = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard';
const http = u => String(u || '').replace(/^http:/, 'https:');
const get = (u, ms = 12000) => fetchJson(http(u), { timeoutMs: ms, retries: 0 }).catch(err => ({ _error: err.message }));

module.exports = async (req, res) => {
  try {
    const date = param(req, 'date') || slateDate();
    const sb = await get(`${SB}?dates=${date.replace(/-/g, '')}`);
    const events = (sb.events || []).slice(0, Number(param(req, 'games', 2)));
    const games = await mapLimit(events, 2, async ev => {
      const comp = ev.competitions?.[0] || {};
      const odds = await get(`${CORE}/events/${ev.id}/competitions/${comp.id || ev.id}/odds?limit=50`);
      const providers = await mapLimit(odds.items || [], 3, async o => {
        const pid = o.provider?.id, name = o.provider?.name;
        if (!pid) return { name, note: 'no provider id' };
        const pb = await get(`${CORE}/events/${ev.id}/competitions/${comp.id || ev.id}/odds/${pid}/propBets?limit=1000`);
        if (pb._error) return { id: pid, name, error: pb._error };
        const items = pb.items || [];
        const types = {};
        for (const it of items) { const t = it.type?.name || it.type?.id || '?'; types[t] = (types[t] || 0) + 1; }
        // A few samples, with the player's name for the first two.
        const samples = await mapLimit(items.slice(0, 4), 2, async it => {
          const ath = it.athlete?.$ref ? await get(it.athlete.$ref, 6000) : null;
          return { player: ath?.displayName || null, type: it.type?.name || null, line: it.current?.target?.value ?? it.current?.target ?? null, odds: it.odds?.american?.value ?? it.odds?.american ?? null, raw: Object.keys(it).slice(0, 12) };
        });
        return { id: pid, name, count: items.length, total: pb.count ?? null, pages: pb.pageCount ?? null, types, samples };
      });
      return { game: ev.shortName, id: ev.id, oddsError: odds._error || null, providers };
    });
    send(res, 200, { date, scoreboardError: sb._error || null, events: (sb.events || []).length, games }, 600);
  } catch (err) { fail(res, err); }
};
