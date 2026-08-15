# Phase 1.1 remediation report

**Date:** 2026-08-16  
**Verdict:** **PASS WITH LIMITATIONS**  
**Phase 2 status:** **READY FOR INDEPENDENT RE-AUDIT** (do not start Phase 2)

---

# 1. Verdict

**PASS WITH LIMITATIONS**

P1 snapshot persistence/immutability is fixed with executed restart, freeze, and cross-season tests. Metrics are no longer mislabeled. DC vs Elo is reported with bootstrap CIs. Same-date leakage is structurally impossible. 2026-27 outputs carry a prominent caveat. Promoted-team initialization is a real, tested module. World Cup suites remain green.

Limitations: 2026-27 fixtures still uningested (Phase 2A); HA/ρ remain training-window estimates; Championship feeder is wired and tested but **off** the frozen Phase 1 held-out path so the 380-match benchmark is not retuned.

---

# 2. Source state

| Item | Value |
| --- | --- |
| Starting SHA | `9e540b34fec244efe3be1c0ee9c0ea29d0ada6e3` |
| Ending SHA | `a23d4ee822832fcd13a3c763d53d2b9fead886d2` |
| World Cup repo | HEAD + `archive/worldcup-2026-v1` = `9e540b3…`, tree clean except pre-existing untracked audit |
| Frozen Phase 1 backtest | `data/processed/premier-league/backtest-heldout.phase1-frozen.json` |

HA and ρ were **not** re-fit. 2025-26 was not used for parameter search.

---

# 3. P1 resolution — snapshots

Store: `lib/snapshots/store.ts`

**Unique key:** `(competition, season, fixtureId, modelVersion, asOf)`

**Durability:** JSONL file (`SNAPSHOT_STORE_PATH` or `data/processed/predictions/snapshots.jsonl`). Process restart reloads from disk. Optional replica to existing MongoDB collection `prediction_snapshots` when `MONGODB_URI` is set. No second database product.

**Immutability:** first write wins; returned objects are **deep-frozen clones**. Assignment throws. Mutating a returned object cannot change the store.

**Executed tests** (`npm run test:phase1-1`):

| Test | Result |
| --- | --- |
| A persist `pl-baseline-v0.1.0` | pass |
| B reset in-process cache, reload from disk, numbers identical | pass |
| C write `v0.2.0`, old snapshot still 0.45/0.27/0.28 | pass |
| D 2025-26 vs 2026-27 Arsenal–Liverpool are distinct keys | pass |
| Frozen write throws | pass |

---

# 4. Metric corrections

| Name | Definition | Bins | Weight | Multiclass |
| --- | --- | --- | --- | --- |
| Brier | mean Σ_k (p_k−y_k)² | — | matches | 3-way unscaled |
| RPS | mean ½[(P_H−y_H)²+(P_H+P_D−y_H−y_D)²] | — | matches | ordered H>D>A |
| LogLoss | mean −ln(max(p_actual, 1e-12)) | — | matches | — |
| **Pooled reliability MAE** | formerly mislabeled “ECE” | 5 equal-width on each class probability | bin n / 3N | 3 points per match |
| **Standard confidence ECE** | bin by max(p); hit = top-pick correct | 5 equal-width | bin n / N | one point per match |

Phase 1 “ECE 2.2%” = pooled reliability MAE on the **frozen** 0.6188 prediction set.  
Audit’s standard ECE 3.48% is the correct name for the confidence-binned number on that same set.

After the structural date-group harness (training seasons included), the **current** candidate reports:

- Pooled reliability MAE **2.1%**
- Standard confidence ECE **4.1%**

Uniform standard confidence ECE is **6.0%** (not “—”).

---

# 5. Statistical uncertainty

Paired bootstrap, **20,000** resamples, seed **20260816**, n=380.  
Δ = candidate DC − Elo+HA (negative = DC better).

| Metric | Δ | 95% CI |
| --- | ---: | ---: |
| Brier | −0.00140 | [−0.00323, +0.00038] |
| RPS | −0.00023 | [−0.00054, +0.00006] |
| LogLoss | −0.00275 | [−0.00612, +0.00057] |

**Interpretation:** DC produced a small point-estimate improvement on the held-out season, but the improvement is **not statistically distinguishable from noise** under the current sample. Dixon-Coles stays as a principled low-score correction. It is not claimed as a proven performance gain.

---

# 6. Temporal integrity

`runRollingBacktest` groups by calendar date:

1. Predict every fixture on D from ratings with `date < D` only.
2. Then apply all D results.

Regression: a same-date later fixture does not see a same-date earlier result.  
Regression: appending later matches does not change the prediction for match N at fixed asOf.

Frozen Phase 1 metrics used accidental same-day updates **during training**. Structural grouping slightly moves the 2025-26 score (see §11). Parameters were not retuned.

---

# 7. Current 2026-27 honesty layer

Constant: `PRESEASON_BASELINE_CAVEAT` in `lib/competitions/premier-league/honesty.ts`.

Shown **at the top** of:

- PL match agent answers
- PL title agent answers
- Featured matchup card (no longer “this weekend’s slate”)

Smoke output starts with:

> 2026-27 official fixtures and the finalized promoted/relegated club set have not yet been loaded into this model. This is a temporary preseason baseline generated from the previous season's club/rating state and should not be treated as a live 2026-27 forecast.

Match copy also says featured orientation, not an official fixture, not an as-of-kickoff forecast.

---

# 8. Promoted-team / season initialization

`lib/prediction-engine/season-init.ts` implements:

```text
priorSeasonFinalRating
  → shrink toward mean          (staying)
  → Championship − gap + shrink (promoted, if feeder rating exists)
  → mean − gap                  (promoted, no feeder)
```

`SEASON_SHRINK=0.75`, `PROMOTION_GAP=80` are labeled **unfitted placeholders**.

Championship walk-forward: `championshipRatingsAsOf`. Tests prove the feeder path.

**Not used** on the canonical Phase 1 held-out backtest (`useChampionshipFeeder` default false) so we do not retune the 380-match benchmark. Flip-on belongs with official 2026-27 membership (Phase 2A). 2026-27 promoted clubs were not invented.

`ClubSeason` records are emitted by season init.

---

# 9. Parameter status

See `docs/PL_MODEL_PARAMETERS.md`.

| | Value | Status |
| --- | --- | --- |
| HA | 72 | Training-window estimate. Grid edge at 75. Not a timeless constant. |
| ρ | −0.061 | Training-window estimate. Per-season optima ~0 to −0.16. Not “true PL ρ”. |

Neither was re-fit in 1.1.

---

# 10. Reproducibility

See `docs/DEVELOPMENT_ENVIRONMENT.md`.

This checkout’s `node_modules` is **x64 esbuild**. Host CPU is arm64. Use the same Node arch for `npm ci` and tests.

```bash
npm ci
npm test
npm run backtest:pl
npm run dev
```

---

# 11. Test evidence

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` (phase1 55 + phase1.1 32) | pass |
| `test:routing` 73 | pass |
| `test:track` 24 | pass |
| `test:calibration` 12 | pass |
| `test:tournament` 52 | pass |
| `test:ratings` | pass |
| `test:honesty` | pass |
| `dc:selftest` | pass |
| `validate:bracket` 495 + title 37.3/30.9/15.3/7.0/2.4 | pass |
| `backtest:pl` | pass (see table) |
| `smoke-phase1.ts` | caveat present; WC still routes |

### Held-out 2025-26 (n=380, HA/ρ unchanged)

| | Brier | RPS | LogLoss | Pooled Rel MAE | Conf. ECE | Top-pick |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Phase 1 frozen (same-day training updates) | 0.6188 | 0.2095 | 1.0276 | 2.2%* | 3.48%† | 47.6% |
| **1.1 structural date&lt;D** | **0.6187** | **0.2095** | **1.0281** | **2.1%** | **4.1%** | **48.2%** |

\* mislabeled ECE in Phase 1  
† audit, on the frozen prediction set

Movement is from structural same-date grouping in **training** seasons, not from retuning.

---

# 12. Remaining limitations

- No official 2026-27 fixtures or finalized promoted set (Phase 2A).
- Title MC still uses last season’s 20 clubs + generated RR (now labeled).
- Championship feeder not on the frozen backtest path.
- HA/ρ non-stationary; not re-fit.
- Snapshot Mongo replica is optional; file is the guarantee.
- Tests remain `tsx` scripts.

---

# 13. Phase 2 readiness

**READY FOR INDEPENDENT RE-AUDIT**

Do not start official 2026-27 ingestion, odds, or another league until that re-audit.
