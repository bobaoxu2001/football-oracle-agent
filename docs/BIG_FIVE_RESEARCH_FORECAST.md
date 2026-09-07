# Big Five research forecasts (`big-five-research-v0.1.0`)

Labeled, PIT-safe 1X2 for La Liga, Bundesliga, Serie A and Ligue 1.

This is **not** Premier League production. It does not unfreeze, refit, or
re-version `pl-live-v0.2.0`. It does not write the LIVE_OOS tape.

```text
canonical match ledger
        ↓  admissibleMatches (resultObservedAt ≤ asOf AND kickoffUtc < asOf;
           predicted fixture excluded by id; competition and season isolated)
walk-forward Elo from a 1500 mean
        ↓
Dixon-Coles 1X2 with a labeled domestic prior
        ↓
research board / JSON  — computed on read, not frozen
```

## What it is

- Per-match research probabilities for the four ledger-only leagues
- Walk-forward Elo + true home advantage + Dixon-Coles τ
- Leakage rule identical to the feature layer in `lib/match-ledger/features.ts`
- Honest evidence labels: `PRIOR_ONLY` (0 results), `THIN` (<20), `SEASON_STARTED` (≥20)

## What it is not

- Not a production champion
- Not a frozen pre-kickoff snapshot
- Not fitted on these leagues
- Not the Premier League coefficients (HA=72, ρ=−0.061)
- Not World Cup host-nation constants
- Not title odds, season simulation, injuries, lineups, or market prices
- Not served by the leftover public `/api/agent/predict` path

## Parameters

Labeled domestic prior, copied as numbers only from the documented PL *prior*
(not from the fitted production file):

| Symbol | Value | Status |
| --- | --- | --- |
| Home advantage | 65 Elo | unfitted prior |
| Dixon-Coles ρ | −0.10 | unfitted prior |
| K | 20 | unfitted prior |
| Mean Elo | 1500 | no feeder / no previous season |
| awayHomeShare | 0 | true home/away |

A result updates **model state**. Changing HA, ρ, K, or the mapping is a new
**model version**.

## Premier League isolation

Requesting `competition=premier-league` returns HTTP 409 `PRODUCTION_ISOLATION`.
The research engine will not mint a parallel Premier League number. Production
Match Rooms continue to hydrate frozen `pl-live-v0.2.0` snapshots only.

## Surfaces

| Route | Role |
| --- | --- |
| `/research/big-five` | Labeled research board |
| `GET /api/research/big-five` | JSON board |
| `/` | Production only; links here, does not mix 1X2 |
| `/matches` | Completed history; still no frozen production snapshot for these leagues |

Forecasts are computed at request time from whatever the ledger currently
contains. `ledgerLastIngestAt` is shown so a stale tape cannot be mistaken for
a live freeze.

## Remaining limitations

- No previous-season ratings and no promotion feeder. Opening weekends are
  close to home-advantage-only.
- `resultObservedAt` for backfilled rows is the backfill instant. That can only
  delay evidence, never smuggle a future result.
- No freeze tape, so a later ingest changes the next on-read forecast. That is
  labeled on the page.
- The production agent still treats La Liga / Bundesliga / Serie A / Ligue 1 as
  out of scope so it cannot launder research numbers as production truth.
