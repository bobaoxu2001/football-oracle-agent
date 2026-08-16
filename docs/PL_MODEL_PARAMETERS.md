# Premier League model parameters (Phase 1)

These are **training-window estimates**, not timeless Premier League constants.

Shipped file: `data/processed/premier-league/model-params.json`  
Version: `pl-baseline-v0.1.0`

## Home advantage = 72 Elo

| Item | Value |
| --- | --- |
| Training seasons | 2018-19 … 2024-25 (2,280 scored matches after 380 burn-in) |
| Held-out | 2025-26 — **not used to pick HA** |
| Objective | walk-forward log-loss |
| Search grid | {50, 55, 60, 65, 70, **75**} × ρ grid |
| Raw grid optimum | HA = **75** (upper edge of the grid) |
| Unconstrained hint | training optimum near ~80 (audit) |
| Shrinkage | 35% toward labeled prior HA=65 |
| **Shipped** | **72** |

**Boundary concern:** the search hit the top of the grid. 72 is a shrink artifact of that edge, sitting on a flat held-out plateau (HA 40–100 changes Brier by ~0.0003). It is defensible as a Phase 1 baseline and **is not a fitted law of Premier League football**.

Home-win rates by season are not stationary (COVID 2020-21 empty stadiums 37.9% vs mid-40s otherwise). Future work should use rolling / season-specific HA. Do not re-fit on 2025-26.

## Dixon-Coles ρ = −0.061

| Item | Value |
| --- | --- |
| Training seasons | 2018-19 … 2024-25 |
| Held-out | 2025-26 — **not used to pick ρ** |
| Objective | walk-forward log-loss (joint with HA) |
| Search grid | {−0.16, −0.13, −0.10, −0.07, −0.04, 0} |
| Raw grid optimum | ρ = −0.04 (with HA=75) |
| Shrinkage | 35% toward prior −0.10 |
| **Shipped** | **−0.061** |

Per-season training optima span roughly **0 to −0.16**. COVID-era seasons behave differently. 2025-26 itself was draw-heavy (27.4% vs 22.4% training average) and would have preferred a more negative ρ — that is why we do **not** retune on it.

**Modeling justification:** Dixon-Coles τ is the standard low-score dependence correction.  
**Empirical evidence:** small point-estimate gain vs Elo+HA on one held-out season; **not statistically distinguishable from noise** (see Phase 1.1 bootstrap). Keep DC; do not oversell it.

## Season initialization coefficients

### Benchmark track (`pl-baseline-v0.1.0`)

`SEASON_SHRINK = 0.75`, `PROMOTION_GAP = 80`, `PREMIER_LEAGUE_MEAN_ELO = 1600` remain **placeholders**. Championship feeder is **OFF**. This path is frozen.

### Production track (`pl-live-v0.2.0`)

Coefficients live in `data/processed/premier-league/season-init-params.json`. They are fitted by `scripts/fit-season-init.ts` on historical Premier League season transitions (scored seasons 2019-20–2024-25). **2025-26 is not used to pick them.** Championship feeder is **ON**. HA and ρ are the same training-window estimates as the benchmark; they were not recalibrated.

A rating update after a verified 2026-27 result changes **model state**, not the model version.

See `lib/competitions/premier-league/model-tracks.ts`.
