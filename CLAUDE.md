# nhlprob

NHL game and player-prop simulator: the slate with leans, the day's best goalscorer play (locked), goalscorers, shots, goalie saves, Model picks with the price each needs, a persistent slip / SGP pricer and an Accuracy tab scored against real benchmarks, the betting market included. Live at nhlprob-spgb.vercel.app.

One of the owner's seven sibling apps (cfbprob, golfprob, hrprob, nascarprob, nflprob, nhlprob,
ufcprob), each its own repo and Vercel project, sharing the same stack and design kit.

## Layout

- `lib/nhl.js`: NHL web API (schedule, scores with goals, box scores, standings, rosters).
- `lib/store.js`: game history (two seasons with a database), snapshots, starters, saved
  calibration / records. `slateDate()` rolls the default date over at 6am ET.
- `lib/ratings.js`: leak-free state as of a date, the fitted priors (empirical Bayes), late-game,
  back-to-back, home-finishing and dispersion fits, team finishing factors, lineup ratio.
- `lib/simulator.js`: shot-by-shot Monte Carlo (15,000 runs); `lib/markets.js` prices any leg or
  ticket from the same runs.
- `lib/effects.js`: which fitted model pieces are on, decided by stored per-game on/off evidence
  (300+ games, held-out log loss).
- `lib/calibration.js`: moneyline stretch, used only when it passes its held-out check.
- `lib/signals.js`, `lib/sharp.js`, `lib/plays.js`, `lib/lean.js`: tags, lists (ranked by chance
  or value), leans. `lib/market.js`: ESPN lines, a check only. `lib/props.js`: DraftKings player
  props (anytime / first / 2+ goals, shots, saves) from ESPN's public odds feed: default prices for
  EV and Model picks, saved with the snapshot (each line carries our chance at its exact line) and
  graded on Accuracy. Never an input. The feed doesn't label over/under: the over is listed first.
- `lib/lock.js`: write-once locks (`nhl_daily_picks`, `nhl_daily_plays`).
- `docs/BUILD-READOUT.md`: the model and its known limits in detail.
- Crons: `/api/sync?cron=1` (history, grading, nightly replay, one effect test),
  `/api/sync?snapshot=1` (pre-game snapshots). Optional `CRON_SECRET` locks `/api/sync`.
  `/api/backtest` is public on purpose.

## Rules specific to this app

- The betting line is never an input: it's shown for reference and graded as a benchmark only.
- A viewer's own starter picks or lineup changes never become the shared or graded projection.

## Open items

- The production database (Prisma Postgres) is connected to the Vercel project `nhlprob-spgb`
  (nhlprob-spgb.vercel.app), Production and Preview. A second Vercel project, `nhlprob`
  (nhlprob.vercel.app), deployed the same repo with no database, so it couldn't save, lock or grade;
  the owner is deleting it. Check a deployment's `/api/status` before calling its database
  connected or not: a local run has no database by design.
- Model effects (team finishing, lineup, back-to-back, home finishing) are off until the nightly
  tests collect evidence. Power play isn't modelled; half-lives are still hand-set.
- On synthetic data the first-goal "share of season goals" baseline edged out the model; watch
  the real Accuracy numbers.
- The local test DB used during development held a synthetic world; never quote its numbers as
  real.

## How to work in this repo

- **Commands:** `npm test` runs the test suite (synthetic data, no network). After editing
  `app.html`, extract its `<script>` block and run `node --check` on it.
- **Deploy:** Vercel deploys `main` automatically; there's no build step. Pushing straight to `main`
  is fine for this project. A hard refresh (Cmd+Shift+R) may be needed after a deploy.
- **Secrets:** the database URL and any keys live in Vercel's environment variables. Refer to
  variable names only; never put values in code, commits or messages.
- **Stack:** Vercel serverless functions in `api/` (one file per route, `_util.js` shared), model
  and data code in `lib/`, the whole frontend in one `app.html` (vanilla JS, no framework), optional
  Postgres via `lib/db.js` (`DATABASE_URL`, `POSTGRES_URL` or the Prisma/Supabase variants).

## House rules (the owner's preferences)

- **Data first, honestly reported.** Model changes are checked on real past games (a leak-free
  replay: each day predicted only from earlier days) before they're called improvements, and
  results are reported as measured, including when a change doesn't help.
- **Public pages speak plainly.** No internal jargon, debug chips or "how we built it" notes on the
  page: that knowledge stays in the code and docs.
- **Picks lock.** Anything shown as the day's pick is saved write-once before the first start and
  never changes after; a database that doesn't answer writes nothing and shows "unconfirmed".
- **Never** put an AI model name in commits or code.
