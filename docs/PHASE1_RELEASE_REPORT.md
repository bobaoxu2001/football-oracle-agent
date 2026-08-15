# Phase 1 release report — Football Oracle

**Date:** 2026-08-16  
**Verdict:** **PASS WITH LIMITATIONS**

> **Phase 1.1 correction.** The 2.2% figure below is a **pooled reliability MAE**, not standard confidence ECE (that value is 3.48%). Dixon-Coles’ small point-estimate gain over Elo+HA is **not statistically significant**. See `docs/PHASE1_1_REMEDIATION_REPORT.md`. Frozen Phase 1 numbers: `data/processed/premier-league/backtest-heldout.phase1-frozen.json`.

Phase 1 produced a boring, honest, reproducible Premier League baseline on top of the preserved World Cup product. All acceptance gates that can be executed locally were executed. Limitations are listed in §10; none of them hide a failed gate.

---

## 1. Release verdict

**PASS WITH LIMITATIONS**

| Gate | Result |
| --- | --- |
| New `football-oracle-agent` exists | PASS |
| World Cup repo recoverable at `archive/worldcup-2026-v1` | PASS — SHA unchanged |
| `CompetitionConfig` + WC plugin + PL implementation | PASS |
| PL true home/away + league-scoped params | PASS |
| DC score sampling consistent with closed-form | PASS (tested) |
| No historical availability/tactical leakage | PASS (those features are off the PL path) |
| Honest expected-goals terminology | PASS (user-facing λ is not labelled xG) |
| `Arsenal vs Liverpool` returns 1X2 + goal expectation + scorelines + version | PASS (executed) |
| League-table title/position simulation | PASS (executed) |
| Walk-forward PL backtest with baselines | PASS (executed, n=380 held-out) |
| World Cup tests green | PASS |
| WC MC numbers unchanged | **NO** — documented below. Closed-form 1X2 unchanged. |

---

## 2. Repository state

| Item | Value |
| --- | --- |
| Source repo | `worldcup-oracle-agent` |
| Source SHA | `9e540b34fec244efe3be1c0ee9c0ea29d0ada6e3` |
| Preservation tag | `archive/worldcup-2026-v1` → **same commit** |
| New repo | `/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent` |
| New repo start | cloned from the tag; `origin` **removed** so it cannot push to the World Cup remote |
| World Cup working tree | untouched (`main` clean except the pre-existing untracked audit doc) |
| Final commit | not created in this phase (working tree is ready to commit) |

---

## 3. Architecture changes

Introduced `CompetitionConfig` (`lib/competitions/types.ts`) with typed `id`, `competitionType`, `footballDataCode`, `apiFootballLeagueId`, `teamKind`, `seasonFormat`, `allowsDraw`, `homeAdvantageMode`, `standingsRules`, `simulationMode`.

World Cup–specific modules were moved to `lib/competitions/world-cup/` (bracket, Annex C, draw propensity, stakes, bounce-back, confederation form, discipline). Old import paths remain as shims.

Premier League is a real plugin at `lib/competitions/premier-league/` (clubs, standings, season field, league-table MC, walk-forward ratings).

Shared engine (`lib/prediction-engine/elo.ts`) is competition-agnostic. League vs tournament behaviour is selected through config + `ModelParams`, not `if (competition === "PL")` sprinkled through the agent.

Simulation strategies:

```text
simulateTournament()          → World Cup plugin
simulateLeagueSeason()        → Premier League plugin
```

---

## 4. Donor migrations (world-cup-ai-lab)

| Imported | Where |
| --- | --- |
| Walk-forward harness + `baseK` / `gMult` | `lib/evaluation/backtest.ts`, `lib/prediction-engine/rating-core.ts` |
| `matchProbFromGoals` / `scorelineGridFromGoals` | `lib/prediction-engine/elo.ts` |
| `MODEL_VERSION` | `lib/model-meta.ts` (`pl-baseline-v0.1.0`) |
| Immutable snapshots keyed by (fixture, version) | `lib/snapshots/` |
| Model auditor | `lib/model-auditor/` (no WC `getTeam` dependency) |
| `sources.json` pattern | `data/sources.json` |

Not imported: V2 ensemble, Stripe/paywall, marketing, martj42 internationals, Lab availability/tactical.

---

## 5. Modeling changes

### Home advantage

Premier League uses **true home/away**. Home λ gets `+HA` Elo; away λ is **not** given `−HA/2` (`awayHomeShare = 0`).

World Cup keeps the historic host-nation `+75` / `awayHomeShare = 0.5` path.

### Dixon-Coles ρ

Not reused from World Cup (`−0.13`).

Training-only grid (2018-19–2024-25, first season burn-in, 2,280 scored matches):

- Grid optimum: HA = **75**, ρ = **−0.04**, log-loss **0.9763**
- Shrunk 35% toward the labeled prior (HA 65, ρ −0.10)
- **Shipped:** HA = **72**, ρ = **−0.061**, `fittedAt` 2026-08-15, version `pl-baseline-v0.1.0`

ρ = 0 is almost as good on this Elo-λ model. The correction is kept, shrunk, and labelled. It is not fake precision.

### Monte Carlo sampling

`sampleMatch` now draws from the **same Dixon-Coles grid** as closed-form 1X2.

Phase 1 test (40k samples, HA 65, ρ −0.10):

| | Home | Draw | Away |
| --- | ---: | ---: | ---: |
| Closed-form | 0.433 | 0.268 | 0.299 |
| MC | 0.437 | 0.264 | 0.299 |

Grid Σp = 1.000000000000.

### Calibration

No extra draw-bias or gap-scale on the PL path. Held-out ECE is 2.2% without a second calibration layer.

### Early-season initialization

```text
season start:
  staying club  elo' = mean + 0.75 × (elo − mean)
  new / promoted club  elo' = mean − 80   (or Championship elo − 80 if present)

match n this season:
  K_eff = 20 × gMult(GD) × (0.55 + 0.45 × min(1, n/8))
```

Current-season results dominate after ~8 club matches. MW1–MW5 cannot rewrite a prior.

---

## 6. Leakage controls

Documented in `docs/BACKTEST_DATA_BOUNDARY.md`.

- Ratings for date D use only completed fixtures with `date < D`.
- ρ / HA were chosen on 2018-19–2024-25 only. **2025-26 was not used to pick them.**
- Availability, tactical styles, intel, news, bounce-back, confederation form are **not** on the PL backtest or PL live card.
- Snapshots are immutable per `(fixtureId, modelVersion)`.
- martj42 internationals are not used.

---

## 7. Premier League backtest (held-out 2025-26)

Source: football-data.co.uk E0, 8 seasons ingested, **3,040** completed PL matches.  
Held-out: **380** matches, 2025-08-01 → 2026-06-01.  
Training window for parameters: 2018-08-01 → 2025-05-31.

| Variant | N | Brier ↓ | RPS ↓ | LogLoss ↓ | ECE | Top-pick | Draw pred | Draw actual |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Uniform 1/3 | 380 | 0.6667 | 0.2322 | 1.0986 | — | 27.4%* | 33.3% | 27.4% |
| Elo + true HA (ρ = 0) | 380 | 0.6202 | 0.2097 | 1.0304 | 2.5% | 47.6% | 23.0% | 27.4% |
| **Candidate DC ρ = −0.061** | **380** | **0.6188** | **0.2095** | **1.0276** | **2.2%†** | **47.6%** | **24.3%** | **27.4%** |

† Phase 1 labeled this column “ECE”. It is pooled reliability MAE. Standard confidence ECE = 3.48%. The candidate’s point-estimate edge over Elo+HA is not statistically significant (Phase 1.1 bootstrap).

\* Uniform top-pick is the draw rate because the 1/3 vector’s argmax is coded as draw. Probability scores (Brier / RPS / log-loss) are the right comparison.

Candidate calibration (pooled 1X2):

| Bucket | n | Mean pred | Observed |
| --- | ---: | ---: | ---: |
| 00–20% | 121 | 15% | 15% |
| 20–40% | 688 | 27% | 29% |
| 40–60% | 253 | 48% | 45% |
| 60–80% | 75 | 66% | 60% |
| 80–100% | 3 | 83% | 100% |

---

## 8. Baseline comparison

DC produced a small point-estimate improvement on Brier / RPS / log-loss. That improvement is **not statistically distinguishable from noise** on this 380-match sample. Keep Dixon-Coles as a principled correction; do not claim it clearly beats Elo+HA.

Both Elo variants beat uniform on every probability metric.

This is a clean benchmark, not a leaderboard-hacked model.

---

## 9. World Cup regression

Executed and green:

`typecheck`, `test:phase1` (55/55), `test:routing` (73/73), `test:track` (24/24), `test:calibration` (12/12), `test:tournament` (52/52), ratings / availability / tactical / draw / stakes / path / qualification / intel / matchtype / bounce / form / completed / freshness / honesty / provenance, `dc:selftest`, `validate:bracket` (495/495 Annex C).

### Intentional numerical change

Monte Carlo now samples the Dixon-Coles grid. Closed-form match 1X2 is unchanged. Tournament title shares moved:

| | Argentina | Spain | France | England | Brazil |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before (independent Poisson) | 34.9% | 31.8% | 15.4% | 5.9% | 3.4% |
| After (DC grid) | 37.3% | 30.9% | 15.3% | 7.0% | 2.4% |

No golden files were silently rewritten. This table is the record.

---

## 10. Known limitations

1. **2026-27 fixtures are not ingested.** The slate is featured matchups from the last completed 20-club field, not a live weekend list. Title MC simulates a generated double round-robin of those 20 clubs.
2. **Promotion/relegation for 2026-27 is not applied.** We refused to invent promoted sides.
3. **Championship mapping is incomplete** (some E1 clubs unmapped). Promoted priors therefore often use `mean − 80`.
4. **Dixon-Coles adds only a small held-out gain** over Elo+HA. That is reported, not dressed up.
5. **Draws are still slightly under-predicted** (24.3% vs 27.4% actual).
6. **No market odds** in Phase 1. Snapshot schema has a reserved `market` field.
7. **PL live card has no injuries / tactics / news.** Deliberate.
8. **Title board is last-season Elo**, so a club that finished 2025-26 poorly will look weak for 2026-27 until new results land.
9. **World Cup chat retrospective** still uses the live stacked engine (pre-existing). The honest WC number remains `/accuracy`.
10. **Tests are still `tsx` scripts**, not Jest/Vitest.

---

## 11. Phase 2 recommendation

**Do not implement now.** Next useful step, in order:

1. Ingest the official 2026-27 PL fixture list (football-data.org `PL` or football-data.co.uk `2627/E0`) and condition season MC on **remaining** fixtures.
2. Apply real promotion/relegation once 2025-26 Championship play-offs / 2026-27 membership are in the file.
3. Only after that: live odds snapshots, then a second league.

Do not add V2 ensembles, injuries, or a five-league fan-out until the 2026-27 tape is honest.

---

## Executed evidence (not “code exists”)

```text
Who wins Arsenal vs Liverpool?
  Home 58.8% · Draw 23.1% · Away 18.1%
  Goal expectation 1.9 – 1.0 · most likely 1–1
  Model pl-baseline-v0.1.0

Who is most likely to win the Premier League?
  League-table MC (not a bracket). Lead: Arsenal 57.2% title.

Who will win the World Cup?
  Still routes to the World Cup plugin.
```
