# nhlprob

NHL game and player-prop simulator: today's best goalscorer play, the slate with leans and
totals, anytime and first goalscorers, shots on goal, goalie saves, model picks with the price
each needs, a persistent slip priced inside the simulation, and an accuracy record scored against
real benchmarks, the betting market included. Same stack and
design kit as golfprob, nflprob, hrprob, nascarprob and ufcprob: Vercel serverless functions,
optional Supabase Postgres, one `app.html`.

## Deploy

1. Import the repo in Vercel (framework preset: Other). No build step.
2. Recommended: set `DATABASE_URL` (or `POSTGRES_URL`, which Vercel's Supabase integration sets)
   to a Postgres connection string. In Supabase: Project Settings → Database → Connection string
   → URI, transaction pooler (port 6543). Tables create themselves.
   Without a database the model runs on the last 28 days of games fetched live, and nothing is
   saved for grading.
3. With a database, open `/api/sync` and repeat until `remaining` is 0 (this season and last).
4. Open `/api/health`. It fetches the NHL feeds and fails (HTTP 503) on empty data, not just on
   errors. `/api/health?probe=1` shows the raw shapes the feeds return.

Two daily crons: `/api/sync?cron=1` at 09:00 UTC adds yesterday's games, grades yesterday's
projections, re-runs a 14-day replay test (stored for the Accuracy tab) and tests one model
effect on vs off (lib/effects.js); `/api/sync?snapshot=1` at 15:30 UTC (11:30am ET) saves each
game's pre-game projection even if nobody opens the site.

Optional: set `CRON_SECRET` in Vercel to lock `/api/sync` (Vercel's crons send it; for a manual
backfill add `?key=<CRON_SECRET>`). Without it the route stays open. `/api/backtest` is public on
purpose.

The default date rolls over at 6am Eastern, so late West Coast games stay on the default view.

### If Vercel shows the repo connected but no deployment

Vercel deploys on the first push after a project is connected. Project → Deployments → ⋯ →
Create Deployment → branch `main` starts one by hand; Settings → Git should list
`Haywood1033/nhlprob` with production branch `main`.

## Routes

| Route | What it does |
| --- | --- |
| `/` | The app |
| `/api/slate?date=` | The day's games: lineups, goalies, leans, every skater's goal/shot chances, saves, data freshness. `starters=` / `lineups=TOR:+id,-id` are one viewer's changes |
| `/api/plays` (GET, or POST `{book}`) | Model picks and suggested same-game parlays; pasted prices switch to value ranking |
| `/api/sgp` (POST `{legs}`) | Prices a ticket inside the simulated games |
| `/api/live?date=` | Scores, period, clock, goals |
| `/api/starters` (POST `{team, goalieId}`) | Set tonight's starting goalie (shared via the database; `goalieId: null` clears) |
| `/api/backtest?days=20` | Leak-free backtest (saves the calibration only if it passes its held-out check) |
| `/api/backtest?latest=1` | The last stored replay (nightly or button) |
| `/api/backtest?compare=team&days=7` | Test one model effect on vs off; `?effects=1` lists each effect's evidence |
| `/api/grades?page=0` | Graded pre-game snapshots: totals over every game, 60 games a page |
| `/api/sync` | History backfill / nightly update (`?snapshot=1` saves today's projections) |
| `/api/status`, `/api/health` | What history is loaded; source checks (`?probe=1` raw shapes) |

## Prices (Model picks tab, or any row)

Type a price on any row (scorers, saves, the player panel) or paste many at once. American odds
with or without a sign (`150` = +150), `EVEN`, or decimal (`2.50`). "Last, First" names work;
two players with one name need a qualifier, e.g. `Elias Pettersson (VAN)` or `Sebastian Aho (D)`.

```
Auston Matthews, anytime, +120
Auston Matthews, first, +900
Auston Matthews, sog o3.5, -130
Joseph Woll, saves o27.5, -115
TOR, ml, -150
TOR, pl -1.5, +170
TOR @ MTL, over 6.5, -110
TOR, tt o3.5, +105
```

## Tests

`npm test` runs everything against a synthetic league (`tests/fixtures.js`): fake teams,
players and games in the NHL API's shapes, through the real handlers. See
`docs/BUILD-READOUT.md` for the model.
