# Phase 1.1 Independent Re-Audit — Football Oracle

**Auditor:** independent adversarial reviewer (narrow re-audit of the Phase 1.1 remediation only)
**Date:** 2026-08-16
**Repo:** `/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent`
**Audited commits:** `a23d4ee` (Phase 1.1) + `7bc3f94` (docs) on top of `9e540b3` (Phase 1)
**Scope:** remediation gates only. No production code modified. All diagnostics were temporary under `/tmp` and removed.

---

# 1. Verdict

```text
PASS WITH MINOR NON-BLOCKING ISSUES — READY FOR PHASE 2A
```

Every blocker-class gate from the original audit now passes, and I verified each one by executing code, not by reading claims:

- Snapshots are **genuinely persistent** (cross-process test: values survive a fresh Node process), **immutable at runtime** (deep-frozen clones, first-write-wins, model-version change cannot touch old numbers), and **keyed by (competition, season, fixtureId, modelVersion, asOf)** (cross-season collision test passes).
- The walk-forward harness is now **structurally date-strict**: same-date fixtures never feed each other (proven with a same-club-twice-on-D tape), and future-append invariance holds at 12 random as-of boundaries.
- Metrics are **correctly defined and labeled**; the reported table reproduces exactly (Brier 0.6187 / RPS 0.2095 / LogLoss 1.0281 / standard confidence ECE 4.1% / pooled reliability MAE 2.1%), and the 3.48% → 4.1% ECE movement is fully explained by the prediction-set change, not the metric.
- The paired bootstrap reproduces exactly and the repository no longer claims DC superiority.
- 2026-27 outputs carry a prominent, user-visible caveat (match answer, title answer, slate).
- The promoted-team prior is real, tested, reaches real data, and its placeholder coefficients are explicitly labeled unfitted.
- World Cup regression is fully green; no Phase 2 scope creep found.

Five minor non-blocking issues remain (details in §13); none of them falsifies a metric or leaks data, and none should block Phase 2A.

---

# 2. Snapshot Persistence — PASS

`lib/snapshots/store.ts` writes every snapshot to a JSONL file (`SNAPSHOT_STORE_PATH` or `data/processed/predictions/snapshots.jsonl`), with an optional MongoDB replica (`prediction_snapshots`, `$setOnInsert`) when `MONGODB_URI` is set. The store reloads from disk whenever the in-process cache is empty.

**Executed proof (stronger than the shipped test — two separate OS processes):**

```text
WRITE process: created premier-league::2025-26::arsenal-vs-liverpool::pl-baseline-v0.1.0::2025-08-16  home=0.45
WRITE process: next-day asOf write → 0.5 (distinct key)
READ process (fresh Node): recovered 2 snapshots from disk
READ process: home/draw/away = 0.45 / 0.27 / 0.28   ✓ exact
READ process: next-day snapshot also present = 0.5   ✓
```

This is file-level persistence, not module-global memory. The shipped suite's cache-reset test (B) passes as well, and the committed smoke-run snapshot (Arsenal–Liverpool 0.5894, stage `preseason-baseline`) sits in the gitignored default store. **PASS.**

---

# 3. Snapshot Immutability — PASS

Verified at runtime (not just types):

- `createSnapshot` returns a **deep-frozen clone** (`structuredClone` + recursive `Object.freeze`); assignment to a returned object **throws** (test A executes this).
- The internal map holds the canonical object; all external reads return fresh frozen clones, so a caller can never mutate history.
- **First write wins** per unique key: re-creating the same key returns the original numbers.
- A **new model version is a different key**: writing `pl-baseline-v0.2.0` (0.1/0.2/0.7) left the `v0.1.0` snapshot at 0.45/0.27/0.28 (test C) — and I re-verified the same across process restart.
- Stored values round-trip **byte/value-equivalent** through JSONL.

The one honest caveat: the canonical object inside the module is not itself frozen — but it is unreachable except through frozen clones, so the guarantee holds at the API boundary. **PASS.**

---

# 4. Snapshot Identity — PASS (one noted edge)

Unique key = `competition::season::fixtureId::modelVersion::asOf` (string-joined; the key object is typed `SnapshotKey`).

- **PL / 2025-26 / Arsenal-Liverpool vs PL / 2026-27 / Arsenal-Liverpool: distinct keys, distinct values** — verified (test D and my own cross-process test).
- **Multiple snapshots for the same fixture at different as-of dates coexist** — verified (same fixture/version, asOf 2025-08-16 → 0.45 and 2025-08-17 → 0.5, both retrievable).
- **Competition and model version** are in the key; WC and PL snapshot namespaces cannot collide.

**Edge (minor, non-blocking):** `predictionStage` and `createdAt` are stored but **not** in the key. Two same-day snapshots of the same fixture/version with different stages (e.g., a morning `preseason-baseline` and an evening `as-of-kickoff` on the same asOf date) alias to the first write — verified experimentally: the second write returned the first snapshot, silently dropping its stage. In today's product stages are tied to different asOf dates, so no practical collision exists; but Phase 2A (fixture ingestion, intraday updates, odds captures) should either add stage/timestamp to the key or decide the alias is intended. **PASS** for the required separations; edge flagged for Phase 2A.

---

# 5. Temporal Leakage Gates — PASS

`lib/evaluation/backtest.ts` now groups fixtures by calendar date: **all** fixtures on date D are predicted from ratings built on `date < D` only, then the whole day's results are applied. The guarantee is structural, not ordering-accidental.

Executed proofs:

1. **Same-date non-leakage (shipped test, re-run):** tape where club `alpha` plays twice on D (d1a then d1b); d1b's prediction is bit-identical to a run containing only d1b (Δ < 1e-12). A same-date earlier result cannot reach a same-date later prediction.
2. **Future-append invariance (shipped test + my stress test):** at 12 random as-of targets across all 8 seasons, `prediction(N, data through N-1) == prediction(N, data with future matches appended)` exactly (Δ < 1e-12 on all three probabilities). Future results cannot change a historical prediction.
3. The only future-scanned information remains season **membership** (the 20 clubs), which is legitimately known at season start — unchanged from the Phase 1 audit.

**PASS.** The latent P2 from the Phase 1 audit (same-date ordering) is closed structurally.

---

# 6. Metric Definitions — PASS

`lib/evaluation/metrics.ts` is now the single definition source, and every reported number is labeled with its definition:

| Metric | Definition (code) | Formula check |
| --- | --- | --- |
| Brier | mean over matches of Σ_k (p_k − y_k)², k ∈ {H,D,A}, unscaled | uniform = 2/3 = 0.6667 ✓ (reproduced) |
| RPS | mean ½[(P_H−y_H)² + (P_H+P_D−y_H−y_D)²], ordered H>D>A | uniform = 0.2322 ✓ |
| LogLoss | mean −ln(max(p_actual, 1e-12)) | uniform = ln 3 = 1.0986 ✓ |
| **Standard confidence ECE** | one point per match, binned by max(p) into 5 equal-width bins, hit = top-pick correct, N-weighted | ✓ |
| **Pooled reliability MAE** | 3 points per match (one per class), 5 equal-width bins, weighted by bin n / 3N | ✓ (formerly mislabeled "ECE") |

**Independent reproduction (strict date<D harness, n=380):**

| Variant | Brier | RPS | LogLoss | Pooled Rel MAE | Conf. ECE | Top-pick |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| uniform | 0.6667 | 0.2322 | 1.0986 | 0.0% | 6.0% | 27.4% |
| Elo + HA (ρ=0) | 0.6201 | 0.2098 | 1.0309 | 1.9% | 2.9% | 48.2% |
| **candidate DC** | **0.6187** | **0.2095** | **1.0281** | **2.1%** | **4.1%** | **48.2%** |

Matches the remediation report exactly (its "2.1%"/"4.1%" are rounding of my computed 2.07%/4.13%; Brier/RPS/LogLoss identical to 4 decimals). The script output additionally prints the correct interpretation for each label ("Pooled reliability MAE bins (candidate; NOT standard ECE)"). Legacy `calibrationError` field remains as an explicit alias of pooled MAE (documented in code). The frozen Phase 1 file still contains the old `"ece": "2.2%"` label — a deliberately frozen historical artifact, correctly annotated in the 1.1 report as mislabeled. **PASS.**

---

# 7. ECE Reconciliation — EXPLAINED, NOT A BUG

Why the standard confidence ECE moved 3.48% → 4.1%:

1. **The metric definition did not change.** I reimplemented the exact Phase 1 sequential harness (match-by-match, same-day feeding) and scored it with the *new* `confidenceEce` definition: it reproduces the frozen set precisely — Brier 0.6188 / RPS 0.2095 / LL 1.0276 / top-pick 47.6% / pooled 2.20% / **confidence ECE 3.48%** — confirming the Phase 1 audit's 3.48% was computed with this same definition.
2. **The prediction set changed.** Structural date-grouping applies to *training* seasons too, so the Elo trajectory entering 2025-26 shifts slightly for every club: **380/380** held-out predictions changed (mean |Δp| 6.8e-3, max 5.6e-2), and **2** matches flipped top-pick correctness (47.6% → 48.2%).
3. **ECE is high-variance here.** The movement concentrates in one small bin: the 20–40% confidence bin (n = 49 → 48) saw its observed hit rate move 39% → 46%, contributing ~1pp of ECE by itself. With n=380 and tail bins of n=2–3, neither 3.48% nor 4.13% should be over-interpreted; both are consistent with the same calibrated-ish model.

No contamination: HA/ρ are byte-identical (`model-params.json` untouched since the Phase 1 fit), and the freeze file proves the benchmark was not silently retuned. The report's explanation ("movement is from structural same-date grouping in training seasons, not from retuning") is **correct and now quantified**. **PASS.**

---

# 8. Bootstrap Verification — PASS

`lib/evaluation/bootstrap.ts`:

- **Paired resampling:** each bootstrap iteration draws a single index j and uses baseline[j] and candidate[j] together — matches are sampled as pairs. ✓
- **Fixed seed reproducibility:** `mulberry32(20260816)`, n=20,000; two runs at fixed seed produce identical Δ and CI (suite test verifies). ✓
- **CI construction:** 2.5/97.5 percentile of the bootstrap distribution, correctly ordered (suite test). ✓
- **Sign convention:** documented in code and in the script output — Δ = candidate − Elo+HA, negative = candidate better. ✓

**Independent reproduction (exact match to the report):**

| Metric | Δ | 95% CI |
| --- | ---: | ---: |
| Brier | −0.00140 | [−0.00323, +0.00038] |
| RPS | −0.00023 | [−0.00054, +0.00006] |
| LogLoss | −0.00275 | [−0.00612, +0.00057] |

All CIs include zero. The scripted interpretation is the correct one: *"DC produced a small point-estimate improvement … not statistically distinguishable from noise … Keep DC as a principled low-score correction; do not claim a proven performance gain."* No superiority claim anywhere. **PASS.**

---

# 9. 2026-27 Caveat — PASS

`PRESEASON_BASELINE_CAVEAT` is wired into all three user-facing surfaces and verified in live output:

- **Match answer** (smoke): the caveat is the *first* paragraph, followed by "— featured orientation, not an official 2026-27 fixture listing" and "Preseason baseline from last completed season's ratings, not an as-of-kickoff fixture forecast."
- **Title answer** (smoke): caveat is the first paragraph of the title board.
- **Slate UI** (`weekend-slate.tsx`): renamed "Featured Premier League matchups", amber-highlighted caveat, plus "These are example home/away orientations, not this weekend's official fixture list."
- The condition is data-driven (`fixturesForSeason("2026-27").length > 0`), so it will switch itself off when real fixtures land.
- Snapshots taken now are stamped `season: "2025-26"` and `predictionStage: "preseason-baseline"` — the honesty is embedded in the stored record too.

**PASS.** (Nit: the caveat string hardcodes "2026-27"; when 2027-28 rolls around it would need updating — P3, non-blocking.)

---

# 10. Promoted-Team Prior — PASS

`lib/prediction-engine/season-init.ts` implements the three documented paths, and `lib/competitions/premier-league/championship.ts` builds walk-forward Championship (E1) ratings with `date < asOf` filtering:

- **Execution reaches the promoted path** — proven with real data: the 2019-20 promoted trio (Norwich, Sheffield United, Aston Villa) has 2018-19 E1 tape; `initializeSeasonRatings` routes all three `promoted-from-championship` (Norwich 1620 → 1555 = 1600 + 0.75·(1620−80−1600)). Formula tests in the suite assert exact translations.
- **Coefficients explicitly labeled placeholders:** `coefficients.fitted === false`, `note: "Placeholder coefficients. Not fitted…"` (tested), plus `docs/PL_MODEL_PARAMETERS.md`.
- **No invented 2026-27 promoted clubs:** `currentPremierLeagueField()` still returns the 2025-26 field (verified: includes relegated West Ham/Burnley/Wolves; 380 generated RR fixtures).
- **Benchmark protected:** `useChampionshipFeeder` defaults false; I verified the option executes (feeder ON changes held-out Brier 0.6187 → 0.6259) and the canonical run keeps it OFF.
- `ClubSeason` records are now actually emitted by season init (tested).

**PASS** — with one new finding (P2-minor): the **live** ratings path (`ratings.ts applySeasonBoundary`) passes `championshipRatingsAsOf` unconditionally, so live predictions run with the feeder ON while the frozen benchmark is feeder OFF. Proven: Arsenal's live Elo 1828 vs 1816 is *entirely* explained by the feeder (feeder-less re-run reproduces 1816 exactly). Not a blocker — placeholder coefficients, plausible direction — but the evaluated-vs-live pipeline difference must be documented or aligned in Phase 2A.

---

# 11. Environment Reproducibility — PASS

`docs/DEVELOPMENT_ENVIRONMENT.md` accurately states: host arm64, x64 Node under Rosetta at `/usr/local/opt/node@22`, `@esbuild/darwin-x64` only, the exact mismatch error, and a "use one architecture for install and run" workflow. Verified on this machine:

```text
PATH="/usr/local/opt/node@22/bin:$PATH" npm test          → 55 + 32 pass (npm 10.9.4, x64)
PATH="/usr/local/opt/node@22/bin:$PATH" npm run typecheck → exit 0
backtest:pl / validate:bracket / tsx suites               → all pass via the x64 node
```

`npm ci` itself could not be re-executed here (no network in this session) — the lockfile contains both darwin esbuild variants, and the doc's guidance (native arm64 Node + `npm ci`, or x64 Node for everything) is the correct remedy. One nit (P3): the doc could spell out that `npm` itself must be invoked with the x64 PATH prefix on this machine. **PASS.**

---

# 12. World Cup Regression — PASS

Re-run in this audit (original tsx runner, x64 node):

| Suite | Result |
| --- | --- |
| `test:phase1` | 55/55 |
| `test:phase1-1` | 32/32 |
| routing | 73/73 |
| track | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| `validate:bracket` | 495/495 Annex C; top-5 **37.3/30.9/15.3/7.0/2.4** (unchanged) |
| ratings / honesty / DC selftest (Python) | pass |
| draw, stakes, path, qualification, intel, matchtype, bounce, form, completed, freshness, provenance, availability, tactical | all pass |

No new World Cup regression. The documented intentional DC-MC change is unchanged.

---

# 13. Remaining Issues

**Minor, non-blocking (carry into Phase 2A):**

1. **Live-vs-benchmark pipeline mismatch (P2-minor):** feeder ON in the live ratings path, OFF in the frozen 380-match benchmark. Document or align.
2. **Snapshot key lacks stage/timestamp (P2-minor):** same-fixture, same-asOf, different-stage snapshots alias to first write. Relevant once intraday/odds updates arrive.
3. **Live card numbers shifted ~0.2–0.3pp under the same model version string** (harness plumbing change; HA/ρ unchanged). Fine, but versioning semantics should be documented (plumbing vs parameters).
4. **Caveat string hardcodes "2026-27"** (P3).
5. **Environment doc could name the exact x64 npm invocation** (P3).

**Honest remaining limitations (confirmed, and correctly NOT blockers):** 2026-27 official membership/fixtures absent; HA/ρ non-stationary training-window estimates (the parameter doc is candid about the grid edge, per-season ρ span, and COVID non-stationarity); Championship feeder coefficients unfitted; tests still tsx scripts.

---

# 14. Phase 2A Go / No-Go

Blocker check (against the agreed standard):

| Blocker criterion | Status |
| --- | --- |
| snapshots not genuinely persistent | **closed** — cross-process persistence verified |
| snapshots can mutate/recompute historically | **closed** — frozen clones, first-write-wins |
| cross-season prediction identities collide | **closed** — season in key |
| walk-forward temporal boundary can leak | **closed** — structural date<D + same-date + append-invariance proofs |
| metric definitions materially false | **closed** — definitions corrected and labeled |
| 2026-27 synthetic state presented as official/live | **closed** — caveat on match answer, title answer, slate |
| required regression tests fail | **closed** — all green |

```text
GO — Phase 2A may start, carrying the five minor non-blocking issues from §13 as its first work items.
```

The forecasting foundation is now safe enough to receive real 2026-27 season data: the benchmark is frozen and reproducible, the harness cannot leak, the metrics are honestly defined, and the product no longer overstates itself.
