# Phase 1 Adversarial Audit — Football Oracle

**Auditor:** independent adversarial review (audit-only pass; no production code modified)
**Date:** 2026-08-16
**Repo:** `/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent` (working tree = Phase 1 changes on top of `9e540b3`)
**Source preserved at:** `archive/worldcup-2026-v1` → `9e540b34fec244efe3be1c0ee9c0ea29d0ada6e3` (verified: source repo HEAD unchanged, tree clean)

---

# 1. Independent Verdict

```text
PASS WITH MAJOR LIMITATIONS
```

The headline question — **can we trust the Premier League baseline evaluation?** — answers **yes**. I independently re-executed every claimed gate and re-derived the numbers from the code and raw CSVs:

- The held-out backtest reproduces **exactly** (Brier 0.6188 / RPS 0.2095 / LogLoss 1.0276 / top-pick 47.6%, n=380).
- The 2025-26 dataset is **real historical data** (cross-checked against the actual season: Arsenal champions with 85 pts, West Ham relegated, Tottenham 17th, final day 24/05/2026).
- A strict temporal test found **zero leakage**: 0 of 380 held-out predictions differ from an implementation restricted to `date < D`.
- The parameter fit provably never touches 2025-26; re-running it reproduces HA=72, ρ=−0.061 exactly, and the shipped model constants do **not** sit at held-out optima (no evidence of test-set tuning).
- All World Cup regression suites pass (73/73 routing, 24/24 track, 495/495 Annex C, Python DC selftest, and 15 further suites).

The **major limitations** are not in the evaluation but in what surrounds it:

1. **Snapshot immutability is broken for its intended purpose** (P1): the store is in-memory only (wiped on every redeploy), returned objects are not frozen, and the snapshot key omits season/date — the same fixture in two different seasons silently aliases to the first write.
2. **"ECE = 2.2%" is not ECE** (P2): it is a pooled classwise reliability MAE. The standard confidence-binned ECE is 3.48%.
3. **The Dixon-Coles gain over Elo+HA is not statistically significant** (P2): ΔBrier −0.0014, ΔRPS −0.0002, ΔLogLoss −0.0028, permutation p ≈ 0.11–0.12 on all three; DC "beats" Elo+HA on exactly the 104 draw matches and loses on the other 276. The release report's "improves on Brier, RPS, log-loss and ECE" is point-estimate-true but overstates the evidence.

---

# 2. Reproduction Status

## What I actually executed (all green unless noted)

| Command (exact) | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `node node_modules/tsx/dist/cli.mjs scripts/test-phase1-core.ts` (x64 node) | **55/55** |
| `… scripts/backtest-pl.ts` | reproduced exact table (see §3) |
| `… scripts/fit-pl-params.ts` (scratch cwd) | reproduced HA=72, ρ=−0.061, grid optimum HA=75/ρ=−0.04/LL 0.9763 |
| `… scripts/validate-bracket.ts` | 495/495 Annex C; top-5 37.3/30.9/15.3/7.0/2.4 |
| `… scripts/test-llm-routing.ts` | 73/73 |
| `… scripts/test-track-record.ts` | 24/24 |
| `… scripts/test-confidence-calibration.ts` | 12/12 |
| `… scripts/test-tournament-state.ts` | 52/52 |
| 15 further suites (ratings, availability, tactical, draw, stakes, path, qualification, intel, matchtype, bounce, form, completed, freshness, honesty, provenance) | all pass |
| `python3 betting-backtest/dc_model.py --selftest` | all self-tests pass |
| `… scripts/smoke-phase1.ts` | Arsenal 58.8/23.1/18.1, λ 1.9–1.0, 1–1; PL title Arsenal 57.2%; WC routes to WC plugin |

All suites were also re-run through an independent compiled-JS harness (see §20) with identical results, ruling out runner-specific artifacts.

## Environment caveat (important for the team)

The checked-out `node_modules` contains **only the x64 esbuild binary** (`@esbuild/darwin-x64`), while this machine is arm64. `npm run test:*` therefore fails with the default arm64 node:

```
You installed esbuild for another platform … "@esbuild/darwin-x64" … needs "@esbuild/darwin-arm64"
```

It runs with the x64 Homebrew node under Rosetta (`/usr/local/opt/node@22/bin/node`), which is evidently how the Phase 1 numbers were produced. A fresh `npm ci` could not be tested here (network blocked), but the lockfile contains all platform binaries, so `npm ci` on the target arch should fix it. **A "clean process" reproduction therefore requires one extra, undocumented step today** — record it in the Phase 2 runbook.

---

# 3. Claim-by-Claim Verification

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `CompetitionConfig` exists with typed id/type/codes/teamKind/seasonFormat/allowsDraw/homeAdvantageMode/standingsRules/simulationMode | **VERIFIED** | `lib/competitions/types.ts`; used by registry and both configs |
| 2 | World Cup isolated as a competition plugin | **VERIFIED** | 7 modules moved to `lib/competitions/world-cup/` with shims; no functional WC logic remains in shared/PL code (see §10) |
| 3 | Premier League implemented as first domestic league | **VERIFIED** | `lib/competitions/premier-league/` + `league-engine.ts`; live path executed |
| 4 | Original World Cup repo untouched | **VERIFIED** | source repo HEAD = `9e540b3…`, tag `archive/worldcup-2026-v1` → same SHA, tree clean |
| 5 | HA = 72, ρ = −0.061, version `pl-baseline-v0.1.0` | **VERIFIED** | `data/processed/premier-league/model-params.json`; fit re-run reproduces both numbers |
| 6 | Arsenal vs Liverpool: 58.8 / 23.1 / 18.1; λ 1.9–1.0; most likely 1–1 | **VERIFIED** | reproduced exactly (Elo 1816/1687, λ 1.92/0.98; top-5 scorelines in §15) |
| 7 | Held-out = 2025-26, 380 matches | **VERIFIED** | 20 clubs × 38; 0 duplicates; 0 postponed; dates 2025-08-15 → 2026-05-24; real data (§§1, 4) |
| 8 | Parameter fitting window 2018-19 … 2024-25 | **VERIFIED** | fit input filtered `date <= 2025-05-31` → 2,660 matches, 2,280 scored (380 burn-in) |
| 9 | Metrics table (0.6667/0.2322/1.0986 uniform; 0.6202/0.2097/1.0304 Elo+HA; 0.6188/0.2095/1.0276 DC) | **VERIFIED** | re-run byte-identical (`backtest-heldout.json` reproduced) |
| 10 | Predicted draws 24.3% vs actual 27.4% | **VERIFIED** | 24.30% vs 27.37% |
| 11 | Analytical 1X2 uses DC correction; MC samples the same DC grid | **VERIFIED** | code + 600k-sample consistency test (§7) |
| 12 | World Cup MC consequently changed slightly (34.9/31.8 → 37.3/30.9) | **PARTIALLY VERIFIED** | "after" reproduced exactly (37.3/30.9/15.3/7.0/2.4 at 2,000 sims); "before" not exactly reproducible from this tree (data state has moved) — direction verified (§18) |
| 13 | ECE 2.2% without a second calibration layer | **VERIFIED as computed** | harness computes 2.20% — but see §11: it is *not* a standard ECE |
| 14 | League-table MC for title odds | **VERIFIED** | Arsenal 57.2% title reproduced; points→GD→GF tiebreaks |
| 15 | Early-season init: staying clubs shrink 0.75×, promoted at mean−80 | **VERIFIED** | `rating-core.ts` + harness `openSeason`; **but** the "Championship Elo − 80 if present" sub-claim is **FALSE** (dead branch, §14) |
| 16 | Immutable snapshots keyed by (fixture, modelVersion) | **PARTIALLY VERIFIED** | first-write-wins works **in-process**; no durability, no freezing, key lacks season/date (§16) |
| 17 | WC suites green | **VERIFIED** | all re-run green (§18) |
| 18 | 2026-27 fixtures not invented; generated double round-robin | **VERIFIED** | `season.ts` falls back to a generated 380-fixture round-robin of the 2025-26 field (§9) |

---

# 4. Temporal Leakage Audit

**Method.** I wrote an independent strict walk-forward (temporary diagnostic in `/tmp`, not committed): predictions for date D use **only** fixtures with `date < D`; same-date fixtures never feed each other. Compared against the shipped harness for all 380 held-out predictions.

**Result.**

```text
held-out matches with a same-date predecessor in the harness sort order: 266 / 380
predictions differing between harness and strict (date < D):          0 / 380
max |Δp| = 0
```

Both variants produce **identical** metrics (Brier 0.6187722543…, RPS 0.2094775900…, LL 1.0275994594…).

**Feature-by-feature trace** for every input the held-out predictions use:

| Input | Known at kickoff? | Verdict |
| --- | --- | --- |
| Walk-forward Elo (rebuilt from PL results, updated after scoring) | yes — updated only by completed fixtures on earlier dates | clean |
| Same-date earlier results | 0 of 380 predictions affected (a club never plays twice in a day, so earlier same-day updates touch only *other* clubs) | empirically clean, but see P2 below |
| Season membership (the 20 clubs) | yes (membership known at season start; membership is the only future-scanned field) | allowed |
| Season-boundary shrink toward league mean | uses only the previous season's final rating | clean |
| Promoted prior (mean − 80) | constant prior | clean |
| HA / ρ | fitted on 2018-19…2024-25 only; 2025-26 never in the fit input | clean |
| Goal-expectation mapping (baseGoals/goalScale) | hardcoded constants | clean |
| `PREMIER_LEAGUE_MEAN_ELO = 1600` | hardcoded constant — not computed from the dataset (no full-dataset normalization anywhere) | clean |
| Availability / tactical / news / intel / odds | **not on the PL path at all** | clean |
| Any file generated after the held-out season | `fixtures.json` was imported 2026-08-15 but contains only raw match results; the walk-forward is date-strict regardless of file timestamp | clean |

**P2 (latent, zero observed impact):** the harness sorts by `(date, id)` and lets same-date matches feed each other's ratings in principle. It happens to be harmless for the PL (disjoint clubs per day), but the documented boundary says "date < D" strictly. This should be fixed so the harness's guarantee is structural, not accidental.

**No P0 leakage found. The backtest is not contaminated.**

---

# 5. Parameter Audit — Home Advantage = 72

**Procedure (reproduced):** grid {50, 55, 60, 65, 70, 75} × {−0.16, −0.13, −0.10, −0.07, −0.04, 0} evaluated by the same walk-forward harness on **training only** (2,280 scored matches after 380 burn-in), objective = log-loss, then shrink 0.35 toward the labeled prior (65, −0.10):

```text
HA = round(0.65·75 + 0.35·65) = 72     ρ = 0.65·(−0.04) + 0.35·(−0.10) = −0.061
```

**Findings:**

- **Joint fit** (HA×ρ grid), not independent. ✓ as claimed.
- **Search-space boundary hit:** the training optimum is at HA = **75, the maximum of the grid**. Extending the grid shows the unconstrained training optimum is ≈ 80 (LL 0.9762 vs 0.9763 at 75). The shipped 72 is the shrink artifact, not the grid optimum.
- **Held-out surface is flat — 72 is robust, not overfit:** (held-out, ρ = −0.061; diagnostic only, no new value selected)

| HA | Brier | RPS | LogLoss | Top-pick | ECE(harness def) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 40 | 0.6208 | 0.2106 | 1.0301 | 47.6% | 1.24% |
| 50 | 0.6200 | 0.2101 | 1.0290 | 47.6% | 1.43% |
| 60 | 0.6193 | 0.2098 | 1.0282 | 47.4% | 2.14% |
| 70 | 0.6188 | 0.2095 | 1.0277 | 47.4% | 2.17% |
| **72 (shipped)** | **0.6188** | **0.2095** | **1.0276** | **47.6%** | **2.20%** |
| 80 | 0.6186 | 0.2093 | 1.0274 | 48.7% | 2.15% |
| 90 | 0.6185 | 0.2092 | 1.0273 | 48.4% | 2.74% |
| 100 | 0.6185 | 0.2092 | 1.0275 | 48.4% | 2.96% |

Spread across the whole 40–100 range: 0.0003 Brier / 0.0028 LogLoss. **72 sits in a broad plateau; no evidence of overfitting; the value is defensible.** The only procedural weakness is the grid edge at 75 (P2): when Phase 2 refits, extend the grid upward (e.g. to 90) or use a 1-D line search.

- **Stability by season** (empirical home-win rate): 47.6% / 45.3% / **37.9% (2020-21, empty stadiums)** / 42.9% / 48.4% / 46.1% / 40.8% / 42.6%. Home advantage is clearly non-stationary across seasons — a single PL-wide HA is a pragmatic simplification, not a truth (P2 note for Phase 2).

---

# 6. Dixon-Coles ρ Audit

**Exact τ in `elo.ts` (Dixon-Coles 1997 sign convention — verified numerically):**

```text
τ(0,0) = 1 − λμρ      τ(0,1) = 1 + λρ      τ(1,0) = 1 + μρ      τ(1,1) = 1 − ρ
```

With ρ = −0.061, λ = 1.9, μ = 1.0: τ = 1.1159 / 0.8841 / 0.9390 / 1.0610 — ρ<0 boosts 0-0 and 1-1, damps 1-0 and 0-1. **Sign convention, formulas, and bounds all correct.** Numerical stability: with the λ clamp at 3.5 and ρ ≥ −0.16, τ(0,1) ≥ 0.44 — no negative cell probabilities in any reachable configuration; the grid is normalized so Σp = 1.000000000000 exactly.

**Stationarity — the single-ρ assumption is false (P2):** per-season best ρ (walk-forward, HA=72, log-loss):

```text
2018-19:  0     2019-20: −0.10 (COVID restart)   2020-21:  0 (empty stadiums)   2021-22: −0.061
2022-23: −0.04  2023-24:  0                      2024-25: −0.10                2025-26: −0.16 (grid edge)
```

Per-season optima span the entire grid, and the COVID-era seasons behave differently from normal ones. The shipped −0.061 is a sensible shrunk estimate of a non-stationary quantity — fine for a Phase 1 baseline, but do not treat one PL ρ as a stable parameter. (Also note: the held-out season itself would have preferred ρ = −0.16, the most negative value — because 2025-26 was an unusually draw-heavy season, 27.4% vs 22.4% training average.)

---

# 7. Dixon-Coles Analytical vs Monte Carlo Consistency

Five representative matchups, 600,000 seeded samples each, sampled via `sampleMatch` from the same grid as `matchProb`:

| Match | λ / μ | Closed-form H/D/A | MC H/D/A | max \|Δ\| |
| --- | ---: | ---: | ---: | ---: |
| strong home fav | 2.13 / 0.78 | 67.918 / 20.163 / 11.920 | 67.938 / 20.174 / 11.887 | 0.021 pp |
| balanced | 1.56 / 1.35 | 41.577 / 26.006 / 32.417 | 41.590 / 26.015 / 32.395 | 0.021 pp |
| strong away fav | 0.98 / 1.92 | 18.246 / 23.136 / 58.618 | 18.253 / 23.120 / 58.627 | 0.015 pp |
| high-total | 2.41 / 0.49 | 79.612 / 14.994 / 5.394 | 79.677 / 14.925 / 5.398 | 0.069 pp |

All deviations are within the binomial MC error (SE ≈ 0.05–0.06 pp at 600k). The grid-implied 1X2 equals the closed form to machine precision. **MC and analytical are consistent.** ✓

**Truncation:** the grid is 0–8 goals per side; cells above 8 are discarded and the rest renormalized (Σp = 1). At the maximum clamped λ = 3.5 the discarded mass is 0.99% per side — negligible, and the renormalization is applied identically in the closed form and the sampler, so they stay consistent. (Standard practice; no issue.)

---

# 8. Statistical Significance — Does Dixon-Coles Actually Help?

Paired per-match comparison on the 380 held-out matches (Elo+HA ρ=0 vs DC ρ=−0.061), 20,000 bootstrap resamples + paired permutation test:

| Metric | Elo+HA | DC | Δ | 95% bootstrap CI | permutation p |
| --- | ---: | ---: | ---: | ---: | ---: |
| Brier | 0.6202 | 0.6188 | −0.00143 | [−0.00321, +0.00035] | 0.120 |
| RPS | 0.2097 | 0.2095 | −0.00024 | [−0.00053, +0.00006] | 0.120 |
| LogLoss | 1.0304 | 1.0276 | −0.00278 | [−0.00607, +0.00054] | 0.105 |

**DC is better on exactly 104 matches and worse on 276** — and the 104 are precisely the 104 draws. The mechanism is textbook: raising draw probability pays off exactly when a draw occurs and costs everywhere else.

**Classification: SMALL / UNCERTAIN IMPROVEMENT — no statistically significant difference at 5% on any metric.** The direction is consistent with theory (more draws → a draw-boosting correction should help), but one season cannot resolve it. The release report's own caveat ("extremely small") is fair; the phrasing "improves Elo+HA on Brier, RPS, log-loss and ECE" should be downgraded to "directionally better, not significant" in future reports.

---

# 9. Current 2026-27 Validity

**What the code does today (verified):**

- `PREMIER_LEAGUE_CURRENT_SEASON = "2026-27"`; no 2026-27 rows exist in the ingested file.
- `currentPremierLeagueField()` returns the **2025-26 20-club field**; `remainingPremierLeagueFixtures()` generates a 380-fixture double round-robin of that field (played=0).
- Ratings `asOf` today = final 2025-26 walk-forward Elo, with **no season-boundary shrink applied** (the shrink only fires when a new season's fixtures first appear — none exist for 2026-27).
- The generated field **includes the three relegated clubs** (West Ham 39 pts, Burnley 22, Wolves 20 per the data) and **excludes the three promoted clubs** (refused to invent them — correct instinct).

**Classification: `TEMPORARY BASELINE` — legitimately labeled in the slate UI, but the agent's own answers do not carry the caveat.**

- The slate component does disclose: *"2026-27 fixtures are not in the ingested file yet. These are featured home/away matchups from the last completed field (2025-26, 20 clubs)."* ✓ honest.
- The agent's match answer ("Arsenal (home) vs Liverpool (away) … 58.8% …") and the title board ("Arsenal 57.2% title") are math-valid **conditional on last season's tape**, but a user asking `?q=Who wins Arsenal vs Liverpool?` sees no disclaimer that (a) no 2026-27 fixture is being modeled and (b) home/away orientation is arbitrary. The prediction is stamped `asOf` and carries the model version, but that does not say "the fixture itself is not real yet". **P2 — add one sentence of caveat to both agent answers.**
- The title MC on a wrong membership (3 relegated clubs still in) should not be presented as a 2026-27 title forecast without the field caveat.

---

# 10. Architecture Audit — Competition Isolation

**World Cup leakage into shared/league code: NONE functional.** A global search for `host / confederation / knockout / best-third / Annex C / 48 teams / group / national team` in the shared engine, evaluation, snapshots, auditor, model-params, and all `premier-league/` files finds only comments and explanatory strings (e.g. "Not a World Cup host-nation bonus" in a user-facing factor label). The WC-specific modules (bracket, Annex C, draw propensity, stakes, bounce-back, confederation form, discipline) live in `lib/competitions/world-cup/` and are invoked only from the WC paths; the PL simulator explicitly does not route through them, and the agent simulator gates `applyDrawPropensity` behind `applyWorldCupDraw === false` for PL.

**PL-specific hacks in shared code: NONE.** No `if (competition === "PL")` anywhere; league-vs-tournament behavior is selected via `CompetitionConfig` + `ModelParams` (true home/away via `awayHomeShare: 0` vs WC's 0.5; `simulateLeagueSeason` vs `simulateTournament`). The one arguable smell is `baseK()` regex-matching competition strings, which is legitimate dispatch, not leakage.

**Verdict: the isolation claim is VERIFIED.**

---

# 11. Metric Audit — Brier / RPS / LogLoss / ECE

**Brier (multiclass, Σ_k (p_k − y_k)²):** implementation correct, no scaling, no /3, mean over matches. Uniform = 2/3 = 0.6667 analytically — reproduced. ✓

**RPS (ordered Home/Draw/Away):** standard 2-cumulative formulation `RPS = ((P_H−y_H)² + (P_H+P_D−(y_H+y_D))²)/2`; ordering consistent across all matches. Uniform weighted by the held-out outcome mix (42.6/27.4/30.0%) = 0.2322 — reproduced. ✓ (The definition treats H>D>A as an ordinal "home-ness" scale — the conventional football choice; documented here for clarity.)

**LogLoss:** natural log, clip at 1e-12 (no zeros), mean over matches. Uniform = ln 3 = 1.0986 — reproduced. ✓

**ECE — the label is wrong (P2).** The harness computes a **pooled classwise reliability MAE**: every (match, class) triple contributes its probability and 0/1 outcome to 5 equal-width bins, and ECE = frequency-weighted mean |predicted − observed|. That is a legitimate reliability diagnostic, but it is **not** the standard confidence-binned ECE and cannot be compared to published ECEs:

| Definition | Value (DC candidate, 380 matches) |
| --- | ---: |
| harness "ECE" (pooled classwise reliability MAE, 5 equal-width bins) | 2.20% |
| standard confidence ECE (binned by max-probability, equal-width) | **3.48%** |
| classwise one-vs-rest ECE — Home | 3.05% |
| classwise one-vs-rest ECE — Draw | 3.07% |
| classwise one-vs-rest ECE — Away | 4.01% |

The Away class is the weakest: in its 60–80% bin (n=19) the model predicted 64% and away teams won 47%. The release report and README must state the definition whenever the number appears, or switch to the standard metric. (Minor: the report prints "—" for the uniform ECE while the script prints 0.0% — cosmetic inconsistency.)

**Sanity vs trivial baselines (no bookmaker data used):**

| Variant | Brier | RPS | LogLoss | Top-pick |
| --- | ---: | ---: | ---: | ---: |
| Uniform | 0.6667 | 0.2322 | 1.0986 | 27.4% |
| Training class frequencies (22.4% draws) | 0.6572 | 0.2280 | 1.0865 | 42.6% |
| Held-out class frequencies (oracle ceiling) | 0.6534 | 0.2273 | 1.0793 | 42.6% |
| Always-home | 1.1474 | 0.4368 | — | 42.6% |
| **Candidate DC** | **0.6188** | **0.2095** | **1.0276** | **47.6%** |

The candidate beats every baseline **including the test-set-peeking class-frequency ceiling** — strong evidence the Elo+HA+goal-mapping signal is real, not an artifact. These numbers are entirely plausible for an Elo+HA+Poisson model on PL data.

---

# 12. Draw Underprediction Diagnosis

Predicted 24.30% vs actual 27.37%. Findings:

- **Mostly random season variation:** training-period draw rate was 22.4%; 2025-26's 27.4% is a +5pp outlier season. The model (24.3%) sits between the training average and DC's draw boost — it could not have known.
- **Reliability is decent:** draw predictions bin at 17%→obs 22% (n=18) and 25%→obs 28% (n=362). Mild underconfidence in the 20–40% bucket, consistent with a ρ that is slightly too weak for a draw-heavy season.
- **Draw Brier component:** 0.1998 per match (vs 0.1405 for a perfectly calibrated constant 27.4% — i.e. most of the draw-component loss is the irreducible variance of a 27% event, not miscalibration).
- ρ is not the culprit (a stronger ρ would have helped this season but hurt others — see §8); home advantage isn't either (draw rate is almost HA-invariant in §5's surface).

**Diagnosis: random variation + mild structural underprediction. Do not tune.** ✓ matches the report's position.

---

# 13. Early-Season Initialization

Code (`rating-core.ts` + harness `openSeason`):

- Staying clubs: `elo' = 1600 + 0.75·(elo − 1600)` — 25% regression toward a hardcoded league mean. Applied on the first fixture of each new season. ✓
- New clubs: `mean − 80` (= 1520). ✓
- Early-season K: `K_eff = 20 · gMult(GD) · (0.55 + 0.45·min(1, n/8))` per club. ✓

**Flagged aggressively (as requested):**

1. **The Championship (E1) mapping does not exist.** The release report's "or Championship Elo − 80 if present" is a dead branch: `promotedPrior(championshipElo?)` is never called with a Championship rating (the ratings state only ever holds PL-rated slugs, and `ratings.ts`/`backtest.ts` contain zero E1 references). Every promoted club enters at the flat 1520 regardless of whether it was a title-winning or a barely-promoted side. E1 CSVs are ingested but unused.
2. **The 2026-27 live path applies no boundary at all today** (no fixtures → no boundary event), so "current" predictions are raw end-of-2025-26 Elo. The shrink/promotion-prior logic is therefore **untested in production use** — only exercised inside the historical walk-forward.
3. **Transfers are ignored** (acceptable for a Phase 1 Elo baseline, but say so).
4. Sensitivity check (held-out, diagnostic only): promotion gap 0 scored *better* (Brier 0.6166, LL 1.0250) than the shipped 80 — i.e. the shipped value was **not** chosen to look good on the test set (good for honesty), but it is also not clearly right.

**These are exactly the seams Phase 2 will hit first — they must be addressed when 2026-27 fixtures land, not after.**

---

# 14. Current Arsenal vs Liverpool Claim

Reproduced exactly: Elo 1816 vs 1687, +72 home → λ 1.92 / μ 0.98 → 58.8% / 23.1% / 18.1%, most likely 1–1. **The 1–1 result is legitimate**, not a bug: P(1-1) = 10.96% vs P(2-0) = 10.13% — the Poisson mass for 1-1 is intrinsically high and the DC τ(1,1) boost (+6.1%) makes it the mode even though the mean scoreline is 1.9–1.0.

Top scorelines: 1–1 10.96% · 2–0 10.13% · 2–1 9.94% · 1–0 9.90% · 3–0 6.50% · 3–1 6.38%.

**Data used:** final 2025-26 walk-forward Elo (all 3,040 completed matches), no 2026-27 fixtures, no season-boundary shrink, no injuries/tactics/news/odds — exactly the documented Phase 1 path. **Honesty:** calling this "as-of today" is honest *only* with the caveat that no 2026-27 fixture is modeled and home/away is a featured orientation, not a scheduled match. The model card stamps `asOf` and version; the caveat sentence is missing from the answer (P2, §9).

---

# 15. Snapshot / Model-Version Audit

Verified behaviors:

- **(fixtureId, modelVersion) first-write-wins:** creating a second snapshot for the same key returns the first object; a v0.2.0 write leaves the v0.1.0 numbers intact. ✓ (in-process)
- **Tests** (`test-phase1-core.ts` "same version does not overwrite", "new version is a separate snapshot") cover exactly this in-memory behavior.

**Three real defects found (P1):**

1. **No durability.** The store is a `globalThis` array — nothing is written to disk or MongoDB. A fresh process sees **0 snapshots** (verified: two node processes, second finds nothing). A redeploy wipes the entire "immutable history". The whole point of snapshots — never recompute a past review with later overlays — does not survive a restart.
2. **No freezing.** `Object.isFrozen(snapshot) === false`; mutating the returned object changes the stored history in place (verified). "Immutable" is a convention, not an invariant. `assertImmutable` only compares 5 fields and is never called by the store.
3. **Key lacks season/date.** `fixtureId = "arsenal-vs-liverpool"` — identical across every season. Verified: snapshots for "arsenal-vs-liverpool" in 2026-27 and 2027-28 under the same model version return the **same object** (store size 1, not 2). Cross-season history silently aliases.

TypeScript typing is fine; the runtime behavior is what fails. Phase 2's odds-snapshot plans build on this layer, so this must be fixed before Phase 2.

---

# 16. World Cup Regression

Reproduced green (original tsx runner): typecheck; `test:phase1` 55/55; routing 73/73; track 24/24; calibration 12/12; tournament 52/52; ratings, availability, tactical, draw, stakes, path, qualification, intel, matchtype, bounce, form, completed, freshness, honesty, provenance — all pass; `dc:selftest` (Python) passes; `validate:bracket` 495/495 Annex C.

**Monte Carlo change attribution:** the tournament MC now samples the DC grid (WC defaults ρ=−0.13, awayHomeShare 0.5). Re-running with the sampler patched back to independent Poisson moves the title board in the direction reported:

```text
my runs (10k sims):  before 34.3/31.2/17.0/6.1/2.9  →  after 36.2/31.4/16.0/6.3/2.9
report:              before 34.9/31.8/15.4/5.9/3.4  →  after 37.3/30.9/15.3/7.0/2.4  (2k sims)
```

The "after" numbers reproduce **exactly** (37.3/30.9/15.3/7.0/2.4 at the same 2,000 sims). The "before" numbers are directionally consistent but not exactly reproducible from the current tree (ratings data has since moved — semifinals etc. recorded after the table was made) — a documentation traceability gap (P3), not a regression. No unrelated regressions observed.

---

# 17. Findings by Severity

## P0 — none

## P1 — Major

- **P1-1 Snapshot immutability is broken for its purpose:** in-memory only (no persistence across processes), objects not frozen, and the (fixtureId, modelVersion) key lacks season/date so cross-season snapshots alias. Does not affect backtest trustworthiness; does invalidate the "immutable historical record" promise the mechanism exists for.

## P2 — Moderate

- **P2-1 "ECE 2.2%" is a pooled classwise reliability MAE, not ECE.** Standard confidence ECE = 3.48%; classwise: H 3.05% / D 3.07% / A 4.01%. Label and definition must be published together.
- **P2-2 DC vs Elo+HA improvement is not statistically significant.** ΔBrier −0.0014 [−0.0032, +0.0004], ΔRPS −0.0002, ΔLogLoss −0.0028 [−0.0061, +0.0005]; p ≈ 0.11–0.12; DC better on 104/380 matches. Reporting should carry uncertainty.
- **P2-3 Agent answers lack the 2026-27 caveat.** The Arsenal–Liverpool card and the title board present last-season-field math as current without the disclaimer the slate UI carries; title MC includes 3 relegated clubs and no season-boundary shrink.
- **P2-4 Harness same-date ordering** permits (but in PL never realizes) same-day leakage; guarantee should be structural (`date < D`), not accidental.
- **P2-5 Single PL ρ and HA are non-stationary** (per-season best ρ ∈ {0, −0.16}; COVID seasons differ; 2025-26 draws 27.4% vs 22.4% training). OK for a baseline; don't reify.
- **P2-6 HA grid hit its upper edge (75);** unconstrained training optimum ≈ 80. Shipped 72 is plateau-robust (held-out surface flat 40–100), but the fit procedure should extend the grid.
- **P2-7 Championship (E1) promoted-prior mapping not implemented** despite the release report's "if present" wording; all promoted clubs enter at 1520.
- **P2-8 Reproducibility environment:** node_modules ships only x64 esbuild; default arm64 node cannot run `npm run test:*`. Needs a documented runner (x64 node under Rosetta) or a re-install.

## P3 — Minor

- **P3-1** Report shows uniform ECE "—" while the script prints 0.0%.
- **P3-2** `uniformBaseline()` in `lib/evaluation/backtest.ts` is dead code with a wrong placeholder Brier (1.111) and RPS (0.239) — misleading if ever used.
- **P3-3** README/HANDOFF still describe only the World Cup product; no Phase-1/PL section.
- **P3-4** "This weekend's slate" headline is not an actual fixture slate (disclaimer present, headline optimistic).
- **P3-5** WC "before" title numbers (34.9/31.8/…) not reproducible from the current tree — no script or file records them.
- **P3-6** `ClubSeason` type is unused beyond typing; "ClubSeason separation" is fixture-season strings, not persisted records.

---

# 18. Required Fixes Before Phase 2 (genuine blockers)

1. **Snapshot layer (P1-1):** persist snapshots to disk/MongoDB keyed by (competition, season, fixtureId, modelVersion); freeze returned objects (`Object.freeze`); include season + kickoff date in the key so cross-season fixtures never alias.
2. **Metric labeling (P2-1):** rename or define the "ECE" everywhere it appears (report, UI, logs); preferably compute the standard confidence ECE alongside.
3. **Significance reporting (P2-2):** carry Δ + CI (or at minimum "not significant") in any DC-vs-Elo comparison.
4. **Agent caveats (P2-3):** append the fixture-status caveat to PL match and title answers while 2026-27 fixtures are uningested.
5. **Strict date<D harness (P2-4):** group same-date fixtures so predictions use only earlier dates (structural guarantee).
6. **Promotion priors (P2-7):** either wire Championship Elo in or delete the "if present" wording; decide before 2026-27 fixtures arrive.
7. **Runner documentation (P2-8):** document the node/esbuild environment needed to run the suites.

---

# 19. Safe-to-Defer Items (should NOT block Phase 2)

- Re-fitting HA/ρ with an extended grid (the current values are plateau-robust; refit when new data lands, not before).
- Odds ingestion, injuries, tactics, news for PL — explicitly out of Phase 1 scope by design.
- Promotion/relegation automation — impossible without official 2026-27 membership data; use the generated baseline honestly in the meantime.
- README/Phase-1 documentation refresh (P3-3).
- Removing dead code (`uniformBaseline`) and the WC before/after provenance gap.
- Second league, V2 ensembles, any new features.

---

# 20. Reproducibility Notes

Exact commands that reproduce the Phase 1 numbers on this machine:

```bash
cd "/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent"
/usr/local/opt/node@22/bin/node node_modules/tsx/dist/cli.mjs scripts/test-phase1-core.ts   # 55/55
/usr/local/opt/node@22/bin/node node_modules/tsx/dist/cli.mjs scripts/backtest-pl.ts       # exact table
/usr/local/opt/node@22/bin/node node_modules/tsx/dist/cli.mjs scripts/fit-pl-params.ts     # HA=72 ρ=-0.061
/usr/local/opt/node@22/bin/node node_modules/tsx/dist/cli.mjs scripts/validate-bracket.ts  # 495/495 + 37.3/30.9
python3 betting-backtest/dc_model.py --selftest
```

Also reproduced independently via a tsc-compiled CommonJS build with an `@/` resolver (identical outputs — the code, not the runner, produces the numbers). No hidden files, environment variables, or caches are needed beyond the raw CSVs, which are committed in `data/raw/premier-league/`. `npm ci` could not be tested (no network in this session). The scripts are deterministic (re-runs byte-identical); `fit-pl-params.ts` stamps `fittedAt` with the run date (cosmetic only).

**Diagnostic scripts used:** temporary, clearly labeled, under `/tmp/foa-audit/` only. Nothing was committed or left in production paths; the working tree and `data/` were byte-identical before and after this audit.

---

# 21. Statistical Sanity Summary

- Real signal beyond uniform: candidate beats the test-set-peeking class-frequency ceiling on Brier, RPS, and LogLoss. Elo+HA+goal-mapping is doing genuine work.
- Numbers are in the expected range for a no-odds Elo/DC baseline on PL data (log-loss ≈ 1.03; literature models with odds/injuries reach lower).
- Draw handling is honest: slight structural underprediction, mostly an unusually draw-heavy held-out season.
- Nothing about the evaluation appears engineered to look good: the shipped constants are repeatedly **not** the held-out optima (promotion gap 0 > 80, K=10 > K=20 on Brier, baseGoals 1.2 > 1.35 on LogLoss) — consistent with genuine training-only choices.

---

# 22. Phase 2 Go / No-Go

```text
GO AFTER REQUIRED FIXES
```

The baseline evaluation itself is trustworthy — Phase 2 can be planned against the 0.6188/1.0276 numbers with confidence. But Phase 2 builds directly on the two weakest layers (snapshots for odds capture, fixture ingestion for 2026-27), and the current snapshot mechanism is not fit for that purpose. Fix P1-1 and the P2 items in §18 first; do not start fixture ingestion or odds capture on top of the present snapshot store.
