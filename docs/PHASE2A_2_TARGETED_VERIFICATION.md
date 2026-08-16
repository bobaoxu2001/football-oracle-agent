# Phase 2A.2 Targeted Independent Verification — Football Oracle

**Verifier:** independent targeted verifier (read-only production pass; all stateful tests ran in /tmp sandboxes)
**Date:** 2026-08-16
**Verified HEAD:** `13715b37ee9f016c2af9919d0ed7670636a37e45` (verified via `git rev-parse HEAD`)
**Scope:** live-season operating machinery only. Phase 2A remains CLOSED. No re-audit of the 380-fixture season, membership, HA/ρ, shrink, gap, Dixon-Coles significance, title model, or Phase 1 backtesting.
**Method:** (1) independent tsx gate harness executed against the implementation with every writable path redirected to /tmp (102 checks); (2) the repo's own suites (Phase 1/1.1/2A/2A.1/2A.2); (3) an independently started `next dev` on 127.0.0.1:3311 probed via API + headless Chrome; (4) World Cup shared-gate regression; (5) read-only inspection of the production ops ledger.

---

# 1. Verdict

```text
GO AFTER CODE FIXES
```

One required gate fails (Gate 5, Case B, bullet 4): once a fixture is POSTPONED, scheduling never resumes even after a new CONFIRMED kickoff arrives — the fixture's status is never reset to SCHEDULED, so zero future timed jobs are planned for the rearranged match. Everything else passes: 102/103 independent checks, all five suites green, the canonical tape byte-identical, and the World Cup surface unregressed. The fix is small and surgical (fixture-sync status reset). Deployment is additionally **NOT READY** (no live API keys, no working 5-minute scheduler, serverless-incompatible file persistence) — see §22–§23.

---

# 2. Audited Working-Tree Identity

| Item | Value |
| --- | --- |
| HEAD | `13715b37ee9f016c2af9919d0ed7670636a37e45` (matches the reported base commit) |
| Working-tree tracked diff SHA-256 | `53dd99ac6a29250b069b5d0cce3bca9fe44231b7925e5e3a4cb545554a606e4b` (start = end) |
| Tracked modifications | 13 files, +244/−35 (same set at start and end) |
| Untracked Phase 2A.2 files | `app/api/health/route.ts`, `app/api/live/fixture/[id]/route.ts`, `app/api/ops/tick/route.ts`, `app/health/page.tsx`, `app/live/fixture/[id]/page.tsx`, `lib/competitions/premier-league/ops/*` (17 files), `scripts/run-live-ops.ts`, `scripts/test-phase2a-2.ts`, `docs/PHASE2A_2_IMPLEMENTATION_LOG.md`, `docs/PHASE2A_2_LIVE_OPERATIONS_REPORT.md` — plus pre-existing `docs/PHASE2A_1_TARGETED_VERIFICATION.md` and the Phase 1.1 tmpdir |
| Untracked file hashes | recorded (sha256, see audit log); none changed during this audit |
| Production ops state (pre-existing, gitignored) | `ops/prediction-jobs.jsonl` sha256 `4d1534a7…`, `ops/tick-state.json` sha256 `874e3398…` — **byte-identical at end of audit** (read-only use only) |

The exact audited tree can be reproduced as: base commit + the recorded diff hash + the recorded untracked files. No production code or data was modified by this audit.

---

# 3. Trusted Tape Integrity

`data/processed/premier-league/live-oos-2026-27.jsonl` measured at start, during adversarial tests, and at end:

| Metric | Required | Start | End |
| --- | --- | --- | --- |
| Lines | 380 | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | ✓ | ✓ |
| SHA-256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | ✓ | ✓ |

**BYTE-IDENTICAL. PASS (Gates 14, 27).**

---

# 4. Scheduler Eligibility

Verified by execution (not by reading the suite):

| Kickoff | T24H | T2H | T60M | FINAL_PREKICK | Result |
| --- | --- | --- | --- | --- | --- |
| DEFAULT | no jobs planned | no jobs | no jobs | no jobs | BLOCKED at every layer: `canScheduleTimedPrediction` = false; planner skips; direct `freezeScheduledStage` **throws** | 
| CONFIRMED | 1 job | 1 job | 1 job | 1 job | ELIGIBLE only inside its declared window (verified: at T24H window center only the T24H job ran) |

Additional guard: `isTimedSchedulingBlocked` blocks SOURCE_CONFLICT, POSTPONED, CANCELLED, ABANDONED, SUSPENDED, FINISHED, non-CONFIRMED certainty, and missing kickoff. **PASS (Gate 1).**

---

# 5. Stage Windows

Verified against the implementation with exact-boundary sweeps (before / opening / inside / closing / just-after, all four stages):

| Stage | Target | Eligible window | Boundaries |
| --- | --- | --- | --- |
| T24H | kickoff − 24h | [−26h, −22h] | inclusive at both ends; −22h+1s → missed ✓ |
| T2H | kickoff − 2h | [−150m, −90m] | inclusive; −90m+1s → missed ✓ |
| T60M | kickoff − 60m | [−75m, −45m] | inclusive; −45m+1s → missed ✓ |
| FINAL_PREKICK | kickoff − 10m | [−20m, −5m] | inclusive; −5m+1s → missed ✓ |

Windows do not overlap. `asOf` is always the deterministic stage target, and `asOf < kickoff` and `computedAt < kickoff` are asserted at freeze time. A freeze can only execute while `windowState === "eligible"`, so no snapshot can be created after its window and mislabeled. First-ever planning after a window has closed marks that stage MISSED at creation (verified: planning at T−60m produces T24H:MISSED, T2H:MISSED, T60M:ELIGIBLE). **PASS (Gate 2).**

---

# 6. Exactly-Once Prediction Behavior

T24H-window fixture, three scheduler ticks, then a simulated restart (cache wipes) and rerun, all persisted to disk in a sandbox:

- tick 1: 1 prediction job SUCCEEDED, exactly **1** canonical T24H snapshot;
- ticks 2 & 3: 0 attempted, 0 new snapshots;
- restart + rerun: 0 attempted; snapshot count still 1; snapshot-store file holds exactly **1** line;
- the pre-existing 120-job production ledger survives untouched.

Identity: job `fixtureId::stage::kickoffUtc`, snapshot `(competition, season, fixtureId, modelVersion, stage, asOf=target)` first-write-wins, retries consult both the ledger and the operational archive before writing. **PASS at persistent-storage level (Gate 3).**

---

# 7. Missed-Stage Integrity

T24H window occurs while offline; process restarts at T−20h: T24H → **MISSED** ("window closed without a successful freeze; not backfilled"), zero T24H snapshots, no retrospective creation; at T−100m T2H becomes ELIGIBLE and freezes normally. The MISSED row stays in the ledger and is visible on `/health`. **PASS (Gates 4, 24).**

---

# 8. Reschedule / Postponement

**Case A (kickoff updated before any stage) — PASS.** DEFAULT Sat 15:00 → live source CONFIRMED Sun 16:30: same fixture identity; certainty CONFIRMED; 4 new jobs all keyed on Sunday 16:30; zero jobs on the stale Saturday time.

**Case B (stage frozen, then postponed) — PARTIAL FAIL.**

| Expectation | Result |
| --- | --- |
| Old frozen prediction remains immutable | ✓ PASS (byte-stable) |
| No settlement | ✓ PASS (`canSettle(POSTPONED)` = false) |
| Stale future jobs cancelled | ✓ PASS (all PENDING/ELIGIBLE/BLOCKED → CANCELLED) |
| New CONFIRMED kickoff → future-stage scheduling resumes | **✗ FAIL** — sync updates kickoff+CONFIRMED and writes a revision, but fixture status stays POSTPONED (a SCHEDULED/TIMED/NS observation never resets status), so `planPredictionJobs` treats it as postponed-like and plans **0 new jobs** |
| Old prediction never erased | ✓ PASS |

Root cause: `lib/competitions/premier-league/ops/fixture-sync.ts` `applyNormalized()` only applies a source status when `n.status !== "SCHEDULED"`, so a rearranged match reported as TIMED/NS (mapped to SCHEDULED) updates kickoff/certainty but can never clear POSTPONED/CANCELLED/ABANDONED/SUSPENDED. Empirically reproduced: `status=POSTPONED certainty=CONFIRMED kickoff=2026-09-01T19:00Z revisions=1 → 0 jobs`. No evidence is corrupted (nothing invented, duplicated, or erased) — a rearranged fixture simply never receives its new staged predictions. **This is the single code-level failure of this audit (Gate 5).**

---

# 9. Result Verification

Verified by execution through `verifyFixtureResult` / `canSettleVerification` / `canSettle`:

| Ingested state | Outcome |
| --- | --- |
| LIVE | UNVERIFIED — no settlement, no rating update ✓ |
| FINISHED from untrusted source | not VERIFIED_FINAL — no settlement ✓ |
| Two trusted FINISHED scores disagree | CONFLICT — no settlement, no rating update; surfaced on `/health` (BLOCKED + conflict listed) ✓ |
| Trusted FINISHED (one source, or two agreeing) | VERIFIED_FINAL — the only state that can settle ✓ |

LIVE/HT never settle; POSTPONED/SUSPENDED/ABANDONED/CANCELLED never settle. **PASS (Gate 6).**

---

# 10. Settlement Idempotency

Controlled VERIFIED_FINAL ingested 1×, then replayed 2×, then after a process restart a 4th time: still **exactly one settlement per snapshot identity**; settlement file has exactly 1 line; first-write-wins returns the original metrics; the prediction snapshot bytes are unchanged (settlement is a separate record). Multi-stage (Gate 8): a fixture with PRESEASON + EARLY + T24H + T2H + T60M + FINAL_PREKICK snapshots receives VERIFIED_FINAL → **6 settlements, one per snapshot unique key**, all keys distinct, all six stages settled independently; re-settle → still 6. Settlement is per snapshot identity, not per fixture. **PASS (Gates 7, 8).**

Metric implementation (Gate 9) independently recomputed and executed against the audited definitions, for `p = (0.5, 0.3, 0.2)`, actual = HOME: **Brier 0.38 · RPS 0.145 · LogLoss −ln(0.5) ≈ 0.693147** — code returns exactly these. Outcome mapping verified for HOME, DRAW, and AWAY, including top-pick correctness (0.33/0.33/0.34 with away win → topPickCorrect = true; 0.2/0.5/0.3 with draw → true). No metric-definition drift. **PASS (Gate 9).**

---

# 11. Rating Update Idempotency

VERIFIED_FINAL → one `RatingAppliedEvent` per `fixtureId` (pre/post ratings recorded and differing). Replayed 2×, then after cache wipe (restart) once more: `applied = false` every time; event file holds exactly 1 line; original `appliedAt` preserved. Enforcement is persistent through event identity (`byFixture` keyed on fixtureId, loaded from disk). **PASS (Gate 10).**

---

# 12. Future Rating-State Propagation

End-to-end: Prediction A frozen before Match 1 used pre-Match-1 Arsenal Elo (1827.6219…, matching `liveRatingsAsOf` pre-state to 1e-9); Match 1 applied exactly once; Prediction B for a later fixture sees post-Match-1 Arsenal Elo. Prediction A's stored probabilities are unchanged; model version stays `pl-live-v0.2.0` (only state changed); `ratingStateAsOf` is persisted on both snapshots. Same-kickoff batch (Gate 12): two matches with identical kickoff apply in `(kickoffUtc, fixtureId)` order from a shared prior state — no cross-update — and reversing ingestion order re-applies nothing (deterministic; no club plays two simultaneous PL matches). **PASS (Gates 11, 12).**

---

# 13. Restart Recovery

Scenario with pending future jobs (6), one succeeded freeze, one MISSED job, one settlement, one applied rating update; all caches wiped (process restart):

- 8 jobs restored from disk (statuses intact); ✓
- successful snapshot not duplicated (store file still 1 line for that key); ✓
- settlement not repeated; ✓
- rating event not re-applied; ✓
- missed stage not invented; ✓
- current rating state reconstructed correctly from events. ✓

**PASS (Gate 13).**

---

# 14. Stage-Specific Evaluation

Settled snapshots created from all six stages in a safe environment: `livePerformanceReport` returns 6 `byStage` rows with per-stage `nSettled` (PRESEASON=1, EARLY=1, T24H=1, T2H=1, T60M=1, FINAL_PREKICK=1) — stage performance is kept separate. Headline Brier/RPS/LogLoss/topPickAccuracy remain `null` below 20 settlements (no fake metrics); the honesty note is present; the report exposes `nCommitted=380 / nOperational=6` without double-counting (union dedupes by uniqueKey). Observation: once N ≥ 20 the headline aggregates across stages at **snapshot** level (the sample note says "N of M LIVE_OOS snapshots", and per-stage rows remain the canonical performance view) — acceptable, but see §23. **PASS (Gate 16, reporting half).**

---

# 15. `/live`

API (fresh `next dev`, 127.0.0.1:3311): 380 predictions · settled 0 · Brier/RPS/LogLoss `null` · stages PRESEASON 365 / EARLY 15 / T24H 0 / T2H 0 / T60M 0 / FINAL_PREKICK 0 · `stagePerformance` rows all N=0 with `null` metrics · honest sample note · upcoming[0] = Arsenal vs Coventry 2026-08-21T19:00Z CONFIRMED.

Browser (headless Chrome, DOM-normalized): renders 380 (no 764 anywhere), Settled 0, stage table with 365/15/0/0/0/0 and "—" metrics, "FINAL_PREKICK is not a lineup-confirmed model" note, sample-size honesty text, no hydration/runtime errors.

Fixture view `/live/fixture/pl-2026-27-arsenal-coventry` (API + page): 200, EARLY row present with the frozen tape probabilities, other stages `null`, lineup-confirmed disclaimer present.

**PASS (Gates 16, 22).**

---

# 16. `/health`

Semantics audited for truthfulness, distinguishing CODE HEALTH / DATA HEALTH / EXTERNAL-SOURCE HEALTH:

- **HEALTHY** = DATA_READY + recent successful tick + no conflicts/failed jobs/errors. It never claims "live sources connected": `configuredLiveSources` is exposed explicitly ("none configured").
- Source absence degrades exactly when it matters operationally: a CONFIRMED kickoff within 48h with zero live sources → **DEGRADED** with the explicit reason "no live structured result source configured near matchday" (executed and confirmed); past kickoff without VERIFIED_FINAL for 6h → DEGRADED; DEFAULT fixture inside 48h → DEGRADED; conflicts → BLOCKED.
- **Current checkout (measured live at 2026-08-16T09:54Z): overall = DEGRADED, reason "ops tick stale (expected ~5 minute cadence)".** That is truthful and self-revealing: the implementation's one manual tick ran at 08:49:53Z and nothing is automating it. Before any tick the state is also DEGRADED (tick + sync stale) — never a false HEALTHY.

The implemented semantics are defensible: HEALTHY means the code + data + ops loop are healthy, and the loop's own absence or a source gap near matchday degrades the state. Browser check: page renders Overall DEGRADED, DATA_READY, 120 pending, "Live sources: none configured", next job Arsenal–Coventry T24H. **PASS (Gate 17).**

---

# 17. Source Credential Readiness

| Question | Finding |
| --- | --- |
| Required env names | `FOOTBALL_DATA_API_KEY`, `API_FOOTBALL_KEY`, optional `CRON_SECRET` (route auth) |
| Missing-key behavior | source marked `configured: false`, skipped by the tick; baseline official schedule continues; no invented data |
| Secret hardcoding | none — grep across `lib/` shows only `process.env` reads; no key material in the tree |
| Source errors visible | thrown source errors → tick errors → `lastError` → DEGRADED (verified); see §19 for the silent-adapter caveat |
| No silent fake success | with no observations there is nothing to verify → no settlement, no rating update; verification requires a trusted FINISHED score |

**CODE READY ✓ / DEPLOYMENT CONFIGURED ✗** (no keys exist on this checkout or its env files). **PASS with deployment action (Gate 18).**

---

# 18. Scheduler Deployment Readiness

| Item | Finding |
| --- | --- |
| Scheduler code | `runLiveOpsTick` complete; 5-minute cadence constant; FINAL_PREKICK's 15-minute window is caught by any ≥5-min polling (≥3 polls in-window) |
| Declared automation | `vercel.json` cron `*/5 * * * *` → `GET /api/ops/tick`; local `npm run ops:tick` |
| Actually deployed scheduler | **None verified.** No `.vercel` project link, no deployment evidence for Phase 2A.2, no tick workflow (the only GitHub Action is the unrelated nightly DC backtest), and the live `/health` shows the tick is stale 64 minutes after its single manual run |
| Platform reality | Vercel **Hobby** does not honor 5-minute cron (minimum interval once/day); `*/5` needs Pro+ or an external cron (GitHub Actions scheduled workflow, always-on worker, or a persistent host running `npm run ops:tick`) |
| Storage reality | All ops state (jobs, snapshots store, settlements, rating events, operational archive) is local JSONL under `data/processed/`. Vercel serverless functions have an ephemeral, read-only filesystem — ticks there cannot persist job/settlement/rating state across invocations. A persistent volume, an external store, or a persistent host is required |
| Route notes | `/api/ops/tick` has `maxDuration: 60`; two 12s source timeouts could exceed Hobby's short function limits; `CRON_SECRET` unset leaves the endpoint open |

**Scheduler code: READY. Production automation: NOT DEPLOYED.** This is the most important deployment distinction of the audit (Gate 19).

---

# 19. Error Visibility

Executed simulations:

| Failure | Visibility |
| --- | --- |
| Prediction job failure | job → FAILED (ledger), `/health` DEGRADED + "N failed prediction job(s)" ✓ |
| Settlement failure | tick `errors` → `lastError` → DEGRADED ✓ |
| Result conflict | verification → CONFLICT, `/health` BLOCKED + conflict detail ✓ |
| Source adapter throws | tick `errors` → `lastError` → DEGRADED ✓ |
| Source adapter HTTP error/timeout (the real built-in path) | `fetchJson` converts failure to `null` → adapter returns `[]` → **invisible at tick/health level** (console.warn only); surfaces later only via the 48h-DEFAULT / 6h-post-kickoff staleness rules |

A failed job never silently disappears (FAILED/MISSED rows persist in the ledger and are exposed). The silent-`[]` adapter path is a genuine observability gap — no data is invented, but an outage is not immediately visible. Recorded as a required improvement, not an evidence-integrity blocker (Gate 23: PARTIAL, see §23).

---

# 20. World Cup Regression

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | pass |
| routing | 73/73 |
| track record | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| ratings | pass |
| honesty | pass |
| `dc:selftest` | pass |
| `validate:bracket` | 495/495; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 (unchanged) |
| Phase 1 / 1.1 | 55/55 · 33/33 |
| Phase 2A / 2A.1 | 56/56 · 45/45 |
| Phase 2A.2 | 71/71 |

**PASS — no material World Cup regression (Gate 26).**

---

# 21. Code Readiness

```text
FAIL (single gate) — GO AFTER CODE FIXES
```

Independent execution: **102 of 103 checks pass.** The only failure is Gate 5 Case B bullet 4 (postponed fixture's scheduling never resumes after a new CONFIRMED kickoff). None of the hard CODE-FAIL blockers fired: DEFAULT kickoffs cannot produce timed snapshots; duplicate retries/restarts never duplicate canonical predictions; missed stages are never backfilled; unverified/conflicting results never settle; replays never double-settle or double-apply ratings; restart duplicates no history; the frozen 380 tape is byte-identical; future predictions use updated rating state with `ratingStateAsOf` provenance; stage evaluations are separable; structural parameters (HA 72, ρ −0.061, shrink 0.75, gap 120, goal mapping) are never written by any ops path; the World Cup surface is unregressed.

---

# 22. Deployment Readiness

```text
NOT READY
```

1. **Live API credentials missing** (`FOOTBALL_DATA_API_KEY`, `API_FOOTBALL_KEY` not configured anywhere on this checkout).
2. **No working 5-minute scheduler deployed** — Vercel Hobby cannot honor `*/5`; no external cron/worker exists; `/health` itself proves the loop is not running (tick stale).
3. **Storage unsuitable for serverless** — job/settlement/rating/snapshot state lives in local JSONL files; a Vercel serverless tick cannot persist them. A persistent host, volume, or external store is required for autonomous operation.
4. Matchweek 1 will **not** run automatically as things stand.

---

# 23. Required Production Actions

**Code fix (blocker for committing the tree):**
1. `fixture-sync.ts applyNormalized()`: when a live observation carries status SCHEDULED (TIMED/NS) together with a kickoff/certainty change and the current canonical status is POSTPONED/CANCELLED/ABANDONED/SUSPENDED, reset status to SCHEDULED and record the schedule revision (reason "rescheduled by <source>"). Re-run `npm run test:phase2a-2` and the Gate 5B scenario above; verify old frozen snapshots stay immutable and stale jobs remain CANCELLED.

**Deployment actions (required before autonomous Matchweek 1 operation):**
2. Provision `FOOTBALL_DATA_API_KEY` and `API_FOOTBALL_KEY` in the deployment environment (never in the repo).
3. Deploy a real scheduler: Pro/Enterprise Vercel cron, a GitHub Actions scheduled workflow, or a persistent worker invoking `npm run ops:tick` / `GET /api/ops/tick` every ≤5 minutes; set `CRON_SECRET` and confirm the endpoint auth.
4. Provide persistent storage for `data/processed/predictions/snapshots.jsonl`, `data/processed/premier-league/settlements.jsonl`, and `data/processed/premier-league/ops/*` (persistent host/volume or external store), or run the ops loop only on a persistent host.
5. Run one full dry-run matchweek end-to-end (all four timed stages + a VERIFIED_FINAL settlement + rating apply) before MW1.

**Improvements (not blockers):**
6. Surface built-in adapter HTTP failures (fetchJson → null → `[]`) as tick errors/DEGRADED health reasons instead of console-only.
7. When the mixed-stage headline metric activates at N ≥ 20, label it explicitly as an all-stages snapshot aggregate; per-stage `byStage` rows should remain the canonical performance view.
