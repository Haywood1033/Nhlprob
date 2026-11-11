# nhlprob — build readout

## Data

NHL web API (`api-web.nhle.com/v1`):

- **`schedule/{date}`:** the day's games.
- **`score/{date}`:** every game's score and every goal in order (scorer, period, time,
  empty-net), one request per day.
- **`gamecenter/{id}/boxscore`:** each skater's shots, goals and ice time; each goalie's shots
  faced, saves and whether he started. The older "saves/shots" goalie format is also read.

One history row per completed game; two seasons when a database is connected. A day is marked
synced only when every game the schedule lists for it was saved (an empty score page on a game
day no longer counts as done). A box score missing its shot totals is left out of shot rates
instead of counting as zero.

## Model

1. **State as of the game's morning (leak-free).**
   - **Team:** shots for and against per game, with a 50-day half-life, regressed to the
     league over 8 games.
   - **Skater:**
     - Ice time: 14-day half-life, so it tracks his current role.
     - Shots per 60: 90-day half-life, regressed over 240 minutes to his position's rate.
     - Shooting %: 400-day half-life, regressed toward his position's rate. How hard is
       **fitted** (empirical Bayes): the spread of players' shooting % beyond chance over the
       past year sets the prior's weight, separately for forwards and defensemen. It was
       hand-set at 70 shots. On the synthetic league the fit recovers the true spread (113 vs
       ≈100 shots for forwards, 261 vs ≈240 for defensemen).
   - **Goalie:** save %, 400-day half-life, regressed by a fitted prior the same way (it was
       1,200 shots; the synthetic fit recovers 1,502 vs ≈1,400).
2. **Lineups and starters.**
   - Lineups are who dressed in the team's last game; a viewer can mark a regular back in or a
     player out (that viewer only: never shared or graded).
   - The starter is projected from the last 12 games; on the second night of a back-to-back,
     the backup is projected instead.
   - Both switch to the box score once a game is under way.
3. **League.**
   - Shots per game, shooting % by position, save %, and the home shot edge.
   - How often a one- or two-goal lead after regulation becomes an empty-net goal.
   - How often a team down one at 57:00 ties it beyond what normal play does (the extra
     attacker), measured over every game.
   - How often overtime ends before a shootout.
   - The spread of shot volume beyond chance, fitted **after allowing for the opponent** (the
     old fit counted the opponent mix that the simulator adds again; on the synthetic league it
     reported 148 where the true answer is "no extra spread", 400).
4. **Simulation (15,000 runs per game, shot by shot).**
   - **Volume:** a shared game-pace draw and each team's own draw; shots arrive at the team's
     shots-for × the opponent's shots-against × the home edge.
   - **Score effects:** the trailing team presses and the leader sits back.
   - **Each shot:** assigned to a skater by expected shots; it scores at his shooting % × the
     goalie factor.
   - **Pulled starters:** a starter with 4+ goals against can be pulled at an intermission.
   - **Late:** down one, the extra attacker can tie it (the fitted extra rate); otherwise a
     one- or two-goal lead can become an empty-netter at the league rate.
   - **Overtime:** 3-on-3 with both teams' shots counted for the minutes played (for shots and
     saves props), then a shootout. In the playoffs, sudden-death periods instead.
   - Every market and same-game parlay counts from the same runs.

### Effects that switch on only with evidence (lib/effects.js)

Four team-level additions are fitted from history but off until the backtest shows they help:

| Effect | What it does |
| --- | --- |
| Team finishing / suppression | Goals for and against relative to what the shooters and goalies involved predict, shrunk by an empirical-Bayes spread across teams |
| Lineup-adjusted shots | Tonight's dressed lineup's expected shots vs the team's usual, so a missing top shooter means fewer team shots |
| Back-to-back | Shots for and against on the second night vs each team's norm |
| Home finishing | Home goals per shot vs away, beyond the shot edge |

The four estimation fixes above (priors, late game, overtime shots, dispersion) are on by
default but go through the same test. For each effect the backtest simulates every replayed game
twice (on and off, same ratings and random numbers) and stores the change in log loss per game.
An effect switches on after 300+ games show moneyline log loss falling by at least 0.0005 per
game with goalscorer log loss no worse, and off if it makes things worse. The nightly job tests
the least-tested effect each night; the Accuracy tab shows the evidence.

## Moneyline calibration (fitted by the backtest)

- **The finding behind it:** a 60-day backtest (265 games) had strong-lean favorites winning
  83% against 65% predicted. That slice was small (the audit estimated about 20 games, under two
  standard errors), so the calibration is now guarded.
- **The fit:** calibrated p = σ(k·logit p), with k searched only from 0.7 to 1.3, plus a 90%
  bootstrap range.
- **The gate:** it's fitted on the older half of the games and scored on the newer half. Only
  if that held-out log loss improves by 0.0005+ per game is it used live; otherwise the saved
  value is k = 1 (no stretch), so a stretch that made predictions worse is never applied.
- **Shrinking:** k_applied = 1 + (k_fit − 1)·n/(n + 400).
- **Applied across every market** by re-weighting the simulated games, and the backtest now
  grades totals, players, saves and the lists with the same live stretch.

## Goalscorer signals, tags and the lists

- **Eight signals per skater (lib/signals.js):** shot volume, top-line minutes, finisher, hot
  form, soft goalie, leaky defense, high-event game, tired opponent.
- **Tags:** Elite 6+, All-Star 5, and 4 (shown as "Solid"; it was "Value", which read as a
  price call). Each tag also needs a 20% / 20% / 15% anytime chance.
- **Ranking:** by chance, or by expected value once prices are entered; tags only break ties.
  The backtest's tag table hasn't shown tagged players beating their own predicted rate, so a
  21% Elite no longer outranks a 35% untagged scorer. Today's best play is the highest chance.
- **Converging plays** (was "Sharp plays"): tag + workload + matchup + form, ranked by chance.
- **Value:** a priced play must clear 3% expected profit **and** two standard errors of
  simulation noise (at 15,000 runs a 7% first-goal chance is ±0.2 points, ±2.7% of EV at +1200).

## Benchmarks (Accuracy tab)

| Market | Model is scored against |
| --- | --- |
| Moneyline | the home team's usual rate, and the de-vigged betting line (replay: ESPN's past lines when it returns them; tracked: the line saved with each pre-game snapshot) |
| Anytime goal | each player's season scoring rate shrunk toward his position (was raw goals per game, which gave a scoreless player a near-zero chance) |
| First goal | each lineup player's share of season goals (was an even split) |
| Totals, saves, shots | the base rate, season saves per start, season shots per game |

One-sided ESPN lines (only the favourite's price) are divided by a typical overround (1.045).
Tracked totals are aggregated in SQL over every graded game (they used to stop at the latest 300).
Saves and shots list records are graded against an estimated line (the player's season average)
and are labelled that way.

## Synthetic backtest (earlier build, 20 days, 134 games)

| | Model | Baseline |
| --- | --- | --- |
| Anytime goal, log loss | 0.406 | 0.736 (raw goals per game; the new shrunk-rate baseline is much harder) |
| Total over 6.5, Brier | 0.237 | 0.248 (base rate) |
| Goalie saves, average miss | 4.3 | 4.7 (season saves/start) |
| Shots on goal, average miss | 1.07 | 1.12 (season shots/game) |
| First goal, log loss | 3.52 | 3.58 (even split) |
| Moneyline, log loss | 0.684 | 0.685 (home rate) |

These are synthetic. On a short synthetic replay after the audit changes, the share-of-goals
first-goal baseline edged out the model (3.448 vs 3.458): the old even-split baseline made the
first-goal model look better than it is. Real numbers come from `/api/backtest` once the
database is synced.

## Known limits

- The NHL feed shapes were written from documentation and memory, and couldn't be checked
  from the build sandbox. Run `/api/health?probe=1` after the first deploy.
- **Lineups:** scratches and returns aren't known until the box score, unless a viewer marks
  them. The NHL's roster and pre-game endpoints weren't probed (not reachable from the build).
- **Goalies:** starters are projections until confirmed. Books void saves bets on a goalie who
  doesn't start.
- **Power play:** still not modelled separately (it needs power-play ice time from the box
  score, which wasn't verifiable here); it's folded into each player's shot rate and finishing.
- **Half-lives** (team 50, ice time 14, shots 90, finishing and saves 400 days) and the
  position shot rates are still hand-set; the priors on them are now fitted, the half-lives
  aren't. They could join the effects test as discrete alternatives.
- **Nightly replay** is 14 days (the function's 60-second limit), not two seasons; the stored
  effect evidence and the tracked record are what build up over a season.
