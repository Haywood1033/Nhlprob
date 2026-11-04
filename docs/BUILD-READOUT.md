# nhlprob — build readout

## Data

NHL web API (`api-web.nhle.com/v1`):

- **`schedule/{date}`:** the day's games.
- **`score/{date}`:** every game's score and every goal in order (scorer, period, time,
  empty-net), one request per day.
- **`gamecenter/{id}/boxscore`:** each skater's shots, goals and ice time; each goalie's shots
  faced, saves and whether he started. The older "saves/shots" goalie format is also read.

One history row per completed game; two seasons when a database is connected.

## Model

1. **State as of the game's morning (leak-free).**
   - **Team:** shots for and against per game, with a 50-day half-life, regressed to the
     league over 8 games.
   - **Skater:**
     - Ice time: 14-day half-life, so it tracks his current role.
     - Shots per 60: 90-day half-life, regressed over 240 minutes to his position's rate.
     - Shooting %: 400-day half-life, regressed over 70 shots. It counts regulation shots with
       a goalie in net; empty-net and overtime goals are modelled separately.
   - **Goalie:** save %, 400-day half-life, regressed over 1,200 shots.
2. **Lineups and starters.**
   - Lineups are who dressed in the team's last game.
   - The starter is projected from the last 12 games; on the second night of a back-to-back,
     the backup is projected instead.
   - Both switch to the box score once a game is under way.
3. **League.**
   - Shots per game, shooting % by position, save %, and the home shot edge.
   - How often a one- or two-goal lead becomes an empty-net goal.
   - How often overtime ends before a shootout.
   - The spread of shot volume beyond chance, fitted from each team's game-to-game variance.
4. **Simulation (15,000 runs per game, shot by shot).**
   - **Volume:** a shared game-pace draw and each team's own draw; shots arrive at the team's
     shots-for × the opponent's shots-against × the home edge.
   - **Score effects:** the trailing team presses and the leader sits back.
   - **Each shot:** assigned to a skater by expected shots; it scores at his shooting % × the
     goalie factor.
   - **Pulled starters:** a starter with 4+ goals against can be pulled at an intermission.
   - **After regulation:** empty-net goals at the league rate; a tie goes to 3-on-3 overtime,
     then a shootout. In the playoffs, sudden-death periods instead.
   - Every market and same-game parlay counts from the same runs.

## Goalscorer signals and tags

- **Eight signals per skater (lib/signals.js):** shot volume, top-line minutes, finisher
  (regressed shooting % ≥ 1.2× position, 60+ shots), hot form, soft goalie, leaky defense,
  high-event game, tired opponent.
- **Tags:** Elite 6+, All-Star 5, Value 4. Each tag also needs a 20% / 20% / 15% anytime chance.
- **Today's best play:** strongest tag first, then the highest chance.
- **Backtest check:** reports each tag's actual scoring rate against the model's prediction
  for the same players.
  - On the synthetic league, tags don't beat their own predictions: most signals are already
    model inputs, and the synthetic world has no fatigue or streaks.
  - The real record decides whether they add anything.

## Synthetic backtest (20 days, 134 games)

| | Model | Baseline |
| --- | --- | --- |
| Anytime goal, log loss | 0.406 | 0.736 (raw goals per game) |
| Total over 6.5, Brier | 0.237 | 0.248 (base rate) |
| Goalie saves, average miss | 4.3 | 4.7 (season saves/start) |
| Shots on goal, average miss | 1.07 | 1.12 (season shots/game) |
| First goal, log loss | 3.52 | 3.58 (even split) |
| Moneyline, log loss | 0.684 | 0.685 (home rate) |

- The first-goal row only scores games where the scorer was in the projected lineups (92%
  were).
- Anytime calibration lands within a point at every level the model uses.
- The saves 10–90% range held 88% of the time; inclusive whole-number edges push that above 80%.
- These are synthetic. Real numbers come from `/api/backtest` once the database is synced.

## Known limits

- The NHL feed shapes were written from documentation and memory, and couldn't be checked
  from the build sandbox. Run `/api/health?probe=1` after the first deploy.
- **Lineups:** scratches and returns from injury aren't known until the box score. A
  returning player is missing until he plays.
- **Goalies:** starters are projections until confirmed. Books void saves bets on a goalie who
  doesn't start.
- **Power play:** not modelled separately; it's folded into each player's shot rate and
  finishing.
- **Stand-in lines:** model-only shots and saves leans use the player's season average as the
  line. Paste real lines for price comparisons.
