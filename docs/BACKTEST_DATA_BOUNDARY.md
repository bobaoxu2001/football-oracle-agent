# Backtest data boundary (Phase 1)

Every historical Premier League prediction is stamped with:

```text
asOf = fixture date (YYYY-MM-DD)
dataCutoff = asOf
modelVersion
```

The walk-forward loop (`lib/evaluation/backtest.ts`) **groups fixtures by calendar date**.

For every date **D**:

1. Predict **all** fixtures on D from ratings built only from fixtures with `date < D`.
2. Only then apply every D result to the ratings.

Same-date fixtures never update each other, even if a club hypothetically played twice. Kickoff timestamps are not required. This is structural (`date < D`), not an accident of sort order.

## Allowed in Phase 1 historical evaluation

| Feature | Allowed? | Why |
| --- | --- | --- |
| Walk-forward Elo rebuilt from PL results | yes | date-strict |
| True home/away flag (schedule identity) | yes | known before kickoff |
| Season membership (the 20 clubs) | yes | known at season start |
| Promotion prior / season-boundary shrink | yes | uses only the previous season’s final rating |
| Championship feeder Elo for newly promoted clubs | yes | walk-forward on E1 results with `date <` the PL season’s first date |
| Championship-informed promotion prior | only if that club already has a pre-D rating | no current metadata |
| Dixon-Coles ρ / home-advantage | yes | fitted on **2018-19–2024-25 only** |
| Goal-expectation mapping from Elo | yes | function of pre-D ratings |

## Forbidden in Phase 1 historical evaluation

| Feature | Why excluded |
| --- | --- |
| Squad availability / injuries | Oracle tables are current-time, not as-of |
| Tactical style profiles | 2026 styles were rescored after matchday 1 |
| Pre-match intelligence | not timestamped for clubs |
| News 1X2 nudge | not a historical tape |
| Confederation form / bounce-back / group-draw | World Cup plugins |
| Frozen May-2026 national Elo | wrong population |
| martj42 internationals | not club football |
| Closing / live odds | not ingested |
| Current-season aggregates that include later matches | would leak |

If a feature cannot be proven to have existed at kickoff, it is not used.

## Held-out season

`2025-26` is never used to pick `homeAdvantage` or `dcRho`. Those are chosen on 2018-19–2024-25 (with shrinkage toward a labeled prior) and then **frozen** before the held-out walk-forward is scored.

## Phase 2A production vs benchmark

The frozen `pl-baseline-v0.1.0` benchmark is unchanged. The live 2026-27 model is a **new** version (`pl-live-v0.2.0`). Season-init coefficients for production are fit on transitions through 2024-25 only. Using 2025-26 *final ratings* as the starting state for 2026-27 is previous-season information, not a retune of HA/ρ.

Genuine `LIVE_OOS` snapshots are only those frozen with `asOf < kickoff`. Reconstructions are `RETROSPECTIVE` and must never enter the live ledger.
