# nhlprob

NHL game and player-prop simulator: today's best goalscorer play, the slate with leans and
totals, anytime and first goalscorers, shots on goal, goalie saves, best plays, a same-game
parlay builder priced inside the simulation, and an honest accuracy record. Same stack and
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

Two daily crons: `/api/sync?cron=1` at 09:00 UTC adds yesterday's games and grades yesterday's
projections; `/api/sync?snapshot=1` at 15:30 UTC (11:30am ET) saves each game's pre-game
projection even if nobody opens the site.

## Routes

| Route | What it does |
| --- | --- |
| `/` | The app |
| `/api/slate?date=` | The day's games: lineups, goalies, leans, every skater's goal/shot chances, saves |
| `/api/plays` (POST `{book}`) | Best plays and suggested same-game parlays; pasted prices switch to value ranking |
| `/api/sgp` (POST `{legs}`) | Prices a ticket inside the simulated games |
| `/api/live?date=` | Scores, period, clock, goals |
| `/api/backtest?days=20` | Leak-free backtest |
| `/api/grades` | Graded pre-game snapshots |
| `/api/sync` | History backfill / nightly update (`?snapshot=1` saves today's projections) |
| `/api/status`, `/api/health` | What history is loaded; source checks (`?probe=1` raw shapes) |

## Pasting prices (Best plays tab)

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
