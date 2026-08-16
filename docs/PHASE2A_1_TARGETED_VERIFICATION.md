# Phase 2A.1 Targeted Independent Verification — Football Oracle

**Verifier:** independent targeted verifier (read-only production pass; all destructive tests ran in /tmp sandboxes and were deleted)
**Date:** 2026-08-16
**Verified HEAD:** `13715b37ee9f016c2af9919d0ed7670636a37e45` (verified via `git rev-parse HEAD`)
**Scope:** final narrow verification of the three Phase 2A P1 guardrail fixes (live-ledger double count, kickoff certainty, DATA_READY hardening). Not a general audit. HA/rho/shrink/gap/title-model/Dixon-Coles/architecture/Phase 1 backtesting were deliberately not revisited.
**Method:** independent execution of every gate against the current checkout; independent re-derivation of classification/counts in Python from the raw CSV and the committed tape; independent tsx gate script; own `next dev` instance on 127.0.0.1:3200 + headless Chrome; the repo's own suites run under the documented x64/Rosetta Node (per docs/DEVELOPMENT_ENVIRONMENT.md).
**Environment:** Node v22.22.0 x64 (Rosetta, `/usr/local/opt/node@22`); arm64 default node cannot run the checked-out x64 `node_modules` (documented in DEVELOPMENT_ENVIRONMENT.md, not an application defect).

---

# 1. Verdict

```text
PASS — PHASE 2A FROZEN, READY FOR LIVE OPERATIONS
```

All three P1 blockers are genuinely fixed at the underlying layer (not frontend-only). All 18 gates pass. The committed LIVE_OOS tape remained byte-identical before, during, and after verification. Zero blocker-level findings. Phase 2A is CLOSED; no further general audit is recommended.

# 2. Trusted Tape Integrity

`data/processed/premier-league/live-oos-2026-27.jsonl` — measured at the start, repeatedly during adversarial tests, and at the end:

| Metric | Required | Measured (start = end) |
| --- | --- | --- |
| Lines | 380 | **380** |
| Bytes | — | 569019 |
| MD5 | 34f7ca54025a3a48df9f1a169df66315 | **34f7ca54025a3a48df9f1a169df66315** |
| SHA-256 | a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da | **a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da** |

- The tape is git-tracked and byte-identical across the fix commit: `git show 6d293d0:data/…/live-oos-2026-27.jsonl` → same md5/sha256/380 lines; `git diff 6d293d0 HEAD` over that path is empty.
- Independent Python re-audit of all 380 lines: 380 unique provenance keys, LIVE_OOS × 380, model pl-live-v0.2.0 × 380, season 2026-27 × 380, single asOf 2026-08-16T05:33:34.616Z, 380/380 strictly asOf < kickoff, H+D+A = 1.0 for all, every fixtureId present in the fixture store.
- End of verification: `git diff HEAD` empty; only the pre-existing untracked `docs/.PHASE1_1_REAUDIT…tmpdir` remains (was present before this verification started).

# 3. Canonical Enumeration (Gate 1)

**Verified from code AND execution: canonical LIVE_OOS = 380 everywhere.**

| Layer | Check | Result |
| --- | --- | --- |
| Storage (`lib/snapshots/store.ts`) | `byUniqueKey` map holds one entry per canonical identity; `aliases` (modern + legacy 5-part) are lookup-only | PASS |
| `listSnapshots()` | enumerates `byUniqueKey.values()` only — no alias inflation | PASS (384 unique incl. 4 non-canonical working-store rows; see below) |
| `loadCommittedLiveOos()` | committed tape only, dedup by `provenance.uniqueKey` | PASS — **380** |
| `liveOosCount()` | reads the committed tape | PASS — **380** |
| LIVE API (`/api/live`) | `liveOos.nPredictions` | PASS — **380** |
| /live rendered page | headline stat | PASS — **380** (browser-verified, §9) |

- **Backward compatibility preserved without double counting:** a legacy 5-part (no-stage) `getSnapshotByKey` lookup still resolves a committed snapshot, and a modern 6-part lookup returns the identical canonical row; `listSnapshots()` counts it once. The Phase 1 (55/55) and Phase 1.1 (33/33) suites pass, exercising the legacy path.
- **First-write-wins now uses the canonical 6-part key only**, so PRESEASON vs T24H at the same asOf remain distinct observations (tested).
- **Diagnostic transparency:** the API's `ledger` block reports `rawReferences: 768 / uniqueSnapshots: 384 / duplicatesSuppressed: 384` for the in-memory index. The index includes the gitignored working store, which holds 4 rows beyond the committed tape: 2 post-freeze smoke LIVE_OOS snapshots (real 2026-27 fixtures, genuine extra asOf) and 2 legacy Phase 1.1 2025-26 rows. None of these inflates any user-facing count — the headline reads the committed tape (380). The old defect (764 = 382 × 2 aliases) is gone at the enumeration layer, not masked in the UI.

# 4. Archive Idempotency / Overwrite Protection (Gates 2–3)

Executed in a /tmp sandbox (`SNAPSHOT_STORE_PATH`, `LIVE_OOS_ARCHIVE_PATH` pointed at temp files; canonical tape never a write target):

| Test | Result |
| --- | --- |
| Full-380 archive, run 1 | appended **380**, uniqueAfter **380** |
| Run 2 | appended **0**, uniqueAfter **380** |
| Run 3 | appended **0**, uniqueAfter **380** |
| Archive file line count after 3 runs | **380** (no 760/764 growth, no snapshot loss) |
| Duplicated keys inside one batch | deduped (per-line uniqueKey set) |
| Re-archive of already-present keys to the canonical path | no-op, 0 appended, tape hash unchanged |
| `replaceCanonicalLiveTape()` | **throws** (hard failure, never silent) |
| Append of a NEW key to the canonical tape (env flag unset) | **throws** before any write; tape unchanged |
| Working snapshot store pointed at the canonical path → `createSnapshot` | **throws** ("Refusing to write … append-protected evidence") |
| `clearSnapshotsForTests()` on the canonical path | **throws** |
| First-write-wins | second write of the same canonical key returns the original numbers; file keeps one line |
| Returned snapshots | deep-frozen clones; mutation rejected/ignored |

**Classification: PASS.** The guard is library-level (every production write path refuses destructively); a raw `fs.writeFileSync` from arbitrary code outside the library is not OS-intercepted — git history remains the ultimate restore. This is the same honesty boundary as the fix report states, and it satisfies the gate's required behavior: attempted destructive replace/truncate = hard failure, not silent replacement.

# 5. Kickoff Certainty (Gate 4)

End-to-end trace verified from raw source through every layer:

```text
data/raw/premier-league/official-2026-27-fixtures.csv (380 rows; 300×15:00, 58×20:00, 22 TV slots)
  → classifyOfficialKickoffCertainty(date, localTime)          [ingest]
  → fixtures-2026-27.json (kickoffCertainty + scheduledDate persisted on all 380)
  → liveFixtures()/loadSeasonBundle (applyKickoffCertainty)    [fixture store]
  → /api/live upcoming[] (kickoffCertainty + scheduledDate exposed)
  → stages.ts canScheduleTimedPrediction / assertTimedStageEligible consume the certainty flag
```

Counts verified from the canonical fixture store **and** independently recomputed in Python from the raw CSV:

| Certainty | Count | Composition (independently derived) |
| --- | ---: | --- |
| CONFIRMED | **30** | 22 explicit TV slots (12:30×4, 14:00×8, 16:30×5, 17:30×5) + 8 non-Wednesday 20:00 listed slots (Fri/Mon/Sat) |
| DEFAULT | **350** | 300 × 15:00 (280 Sat + 20 Sun) + 50 × Wednesday 20:00 midweek defaults |
| PROVISIONAL | **0** | unused on this tape |
| TBD | **0** | — |

- All 380 persisted rows satisfy `store.kickoffCertainty === classifyOfficialKickoffCertainty(date, kickoffLocal time)` — the classification is a reproducible rule, not hand-editing (0 mismatches).
- **Distinguishability is explicit, not incidental:** DEFAULT occupies exactly the slot set {15:00, 20:00}; CONFIRMED slots are {12:30, 14:00, 16:30, 17:30, 20:00} where every CONFIRMED 20:00 is a non-Wednesday listed slot. A Saturday 15:00 DEFAULT and a genuinely confirmed kickoff are distinguishable via `kickoffCertainty` (and `scheduledDate` vs kickoff metadata), even when a timestamp exists.
- Type semantics: `KickoffCertainty = "CONFIRMED" | "PROVISIONAL" | "DEFAULT" | "TBD"` (`lib/identity/types.ts`), with documented meanings (CONFIRMED = non-default slot, DEFAULT = official-release conventional slot, TBD = missing time). DEFAULT explicitly means "a schedule exists but this is the official placeholder slot".

# 6. Timed-Stage Eligibility (Gates 5–6)

Executed via `canScheduleTimedPrediction` and `assertTimedStageEligible` (the guard the future scheduler will use; the scheduler itself does not exist yet):

**Gate 5 — DEFAULT must never enable timed stages: PASS**

| Fixture | T24H | T2H | T60M | FINAL_PREKICK | EARLY | PRESEASON |
| --- | --- | --- | --- | --- | --- | --- |
| kickoffCertainty = DEFAULT | **NOT eligible** (assert throws) | **NOT eligible** (assert throws) | **NOT eligible** (assert throws) | **NOT eligible** (assert throws) | eligible | eligible |

Full-matrix sweep: every one of the 350 DEFAULT fixtures is ineligible for every timed stage.

**Gate 6 — CONFIRMED may enable timed stages: PASS**

- A CONFIRMED fixture is eligible for all four timed stages; `stageFromTiming` maps the pre-kickoff windows correctly (23 h → T24H, 1 h → T60M, post-kickoff → RETROSPECTIVE).
- **Reschedule scenario executed:** DEFAULT Sat 15:00 `pl-2026-27-arsenal-leeds` → official update CONFIRMED Sun 16:30 via `mergeFixtureUpdate`: same fixture identity; kickoffUtc/kickoffLocal updated to 2026-10-11 15:30Z/16:30 local; `scheduledDate` updated; `kickoffCertainty` = CONFIRMED; the pre-existing EARLY snapshot for that fixture is byte-for-byte unchanged after the merge (first-write-wins, key includes stage); timed-stage eligibility is now true and keys off the confirmed kickoff. The same rescheduled time with certainty flipped back to DEFAULT is NOT eligible — eligibility is driven by the certainty flag, not the timestamp.

# 7. DATA_READY Adversarial Tests (Gates 7–13)

`evaluateSeasonData` returns `{status, errors, warnings, checks}` with 18 concrete checks; the force-promote override is gone (verified in code and by the errors returned).

| Mutation (safe cloned inputs) | Result | Expected |
| --- | --- | --- |
| Real 2026-27 manifest (20 clubs / 380 fixtures) | **DATA_READY** — 18/18 checks true, 0 errors, evidence `verifiedAgainst[]` + `verificationArtifact: docs/PHASE2A_INDEPENDENT_AUDIT.md` | DATA_READY |
| 379 fixtures | **DATA_BLOCKED** — 5 concrete errors (count ≠ 380; per-club 38/19/19; pair completeness; same-venue pair) | DATA_BLOCKED |
| Outsider club (west-ham in a 2026-27 fixture) | **DATA_BLOCKED** | DATA_BLOCKED |
| Duplicate fixture id | **DATA_BLOCKED** | DATA_BLOCKED |
| Logical duplicate, distinct ids (clone of one fixture over another) | **DATA_BLOCKED** — caught by pair structure + per-club counts, not by the id set | DATA_BLOCKED |
| Exact logical clone (same pair + same date, new id) | **DATA_BLOCKED** | DATA_BLOCKED |
| Invalid home/away pair (same club pair twice at one home venue) | **DATA_BLOCKED** — "A club pair appears twice at the same home venue rather than reversed." | DATA_BLOCKED |
| home = away | **DATA_BLOCKED** | DATA_BLOCKED |
| 18 home / 20 away split | **DATA_BLOCKED** | DATA_BLOCKED |
| Missing scheduled date | **DATA_BLOCKED** | DATA_BLOCKED |
| Unresolved club id | **DATA_BLOCKED** | DATA_BLOCKED |
| Missing provenance on ONE fixture only (source removed; season provenance intact) | **DATA_BLOCKED** — "Missing required provenance (source / retrievedAt)." | DATA_BLOCKED |
| Season provenance missing (source/retrievedAt empty) | **DATA_BLOCKED** | DATA_BLOCKED |
| DEFAULT kickoff + otherwise complete 380 schedule | **DATA_READY** (structural) **AND** that same DEFAULT fixture is timed-stage-ineligible — both verified simultaneously | the required separation |

No degraded state exists (statuses are READY or BLOCKED), so there is no pathway for prediction/simulation to silently treat a corrupted manifest as fully verified. Verification is no longer self-referential: membership is checked against the separately cited independent set (`INDEPENDENT_MEMBERSHIP_2026_27` + `INDEPENDENT_MEMBERSHIP_SOURCES` referencing the Phase 2A independent audit), replacing the old Wikipedia-vs-itself constant.

# 8. /live API (Gate 14)

`GET /api/live` called against an independently started `next dev` (127.0.0.1:3200) and cross-checked against the existing 127.0.0.1:3000 instance:

```text
liveOos.nPredictions: 380        (no alias inflation)
liveOos.nSettled:     0
stages:  EARLY 15 · PRESEASON 365 · T24H 0 · T2H 0 · T60M 0 · FINAL_PREKICK 0 · HISTORICAL 0 · RETROSPECTIVE 0
ledger:  LIVE_OOS 380 · RETROSPECTIVE 0 · BACKTEST 0
brier / rps / logLoss: null      (0 settled → no fake metrics)
model: pl-live-v0.2.0 (HA 72, ρ −0.061 unchanged)
dataGate: DATA_READY
upcoming[]: fixtureId, date, kickoffUtc/Local, kickoffCertainty, scheduledDate, names, status
```

The stage breakdown matches the canonical 380-line tape exactly (independent tape count: EARLY 15, PRESEASON 365).

# 9. /live Browser (Gate 16)

Real headless Chrome (system Google Chrome, `--headless=new --no-sandbox --no-proxy-server --dump-dom --virtual-time-budget`) against the independent 3200 server, with the DOM normalized (React text-node comments stripped) and checked:

| Check | Result |
| --- | --- |
| Renders **380** | PASS |
| **764** absent | PASS |
| Settled = **0** | PASS |
| Brier / RPS / LogLoss = **"—"** (no fake values from 0 settled) | PASS |
| Calibration ECE "n too small"; top-pick "—" | PASS |
| Honesty text + "Sample size is 0" note | PASS |
| Season **2026-27** · LIVE_OOS only | PASS |
| Model **pl-live-v0.2.0** | PASS |
| Stage counts EARLY 15 / PRESEASON 365 / T24H-T2H-T60M-FINAL_PREKICK 0 — agree with API | PASS |
| 8 upcoming fixture links render (`/?q=Who wins …`) with CONFIRMED/DEFAULT labels | PASS |
| No hydration/runtime error in DOM | PASS |

Cross-check: the existing 3000 server renders the same 380/0/15/365 set. **PASS.**

# 10. EARLY vs PRESEASON Reconciliation (Gate 15)

Programmatic count of `predictionStage` in the committed tape (the tape is the evidence; it was not touched):

```text
EARLY 15 · PRESEASON 365 · HISTORICAL 0 · T24H 0 · T2H 0 · T60M 0 · FINAL_PREKICK 0 · RETROSPECTIVE 0
```

1. **15/365 is the true original distribution.** The tape has been byte-identical (md5/sha256 unchanged) since before the fix commit, so its stage field today is exactly what was committed at the freeze. The earlier Phase 2A summary that described all 380 as "stage = EARLY" was inaccurate; the Phase 2A independent audit itself (§11) already correctly reported "EARLY × 15 (opening fortnight), PRESEASON × 365".
2. **Why 15 are EARLY:** the stage rule is `stageFromTiming` — EARLY iff 0 < hours-to-kickoff ≤ 336 (14 days). At the freeze asOf (2026-08-16T05:33:34.616Z) the 14-day window ends 2026-08-30T05:33Z. The 15 EARLY are the 10 matchweek-1 fixtures plus the first 5 matchweek-2 fixtures (through Saturday 2026-08-29; Sunday's five MW2 games fall outside the window). All 15 were listed individually and verified.
3. **Rule-based and reproducible:** re-computing the rule from the tape's own asOf/kickoff fields reproduces the stage of every line — **380/380, 0 mismatches**.
4. **Neither category is misclassified.** Every EARLY is within 14 days; every PRESEASON is beyond; the labels are consistent with the enum's documented semantics (stage = time-to-kickoff, not lineup confirmation).
5. **Action:** correct the earlier documentation; the tape is history and was not rewritten.

# 11. World Cup Quick Regression (Gate 18)

All shared gates re-executed green under the documented x64 Node:

| Suite | Result |
| --- | --- |
| typecheck (`tsc --noEmit`) | pass |
| routing | **73/73** |
| track record | **24/24** |
| calibration | **12/12** |
| tournament | **52/52** |
| ratings | pass |
| honesty | pass |
| dc:selftest | pass |
| validate:bracket | **495/495**; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 (unchanged) |
| Full `npm test` | Phase 1 55/55 · Phase 1.1 33/33 · Phase 2A 56/56 · Phase 2A.1 45/45 |

**PASS.** No material World Cup regression.

# 12. Remaining Non-Blocking Issues

None blocker-level. Unchanged research/P2 items carried from the independent audit: gap = 120 is grid-edge/regime-mismatched (research); title-board shrink sensitivity; Championship feeder Wrexham mapping / old-season decay; scorelineDistribution is an unmarked top-6 subset; sourceFixtureId is internal, not an official pairing id; model-version bump is not mechanically enforced. P3: raw CSV header retrieved timestamp (12:00Z vs actual 05:32Z); same-asOf re-freeze reports "380 frozen" though 0 new.

Observations specific to this verification (non-blocking):

1. The two post-freeze smoke snapshots remain in the gitignored working store as genuine extra-asOf LIVE_OOS for real fixtures (documented decision). They appear in the in-memory index diagnostic (384 unique) but never in the committed-tape headline (380). If they are ever to migrate into the committed archive, that requires the explicit `LIVE_OOS_ARCHIVE_ALLOW_APPEND=1` escape hatch — a deliberate, documented action.
2. The overwrite guard is enforced at the library level (hard throws on every production write path). Raw filesystem access from code outside the library is not intercepted; git history remains the restore mechanism. Acceptable for the gate, worth remembering operationally.
3. `PROVISIONAL` is declared but unused on this tape (0 fixtures) — fine; it exists for broadcast-rescheduling states.

# 13. Live Operations Go / No-Go

```text
GO — PHASE 2A CLOSED
```

The verification's single purpose is confirmed: Football Oracle can safely begin generating NEW live-season evidence without endangering or misrepresenting the 380 prospective snapshots already frozen. The ledger enumerates the committed 380 exactly (storage, API, and rendered page agree); archival is idempotent and refuses destructive writes; kickoff certainty is explicit end-to-end and DEFAULT kickoffs cannot enable timed prediction stages; the DATA_READY gate genuinely blocks every tested corruption while accepting structurally complete schedules with DEFAULT kickoffs; the trusted tape is byte-identical; and the World Cup surface is unregressed. No further general audit is recommended before operationalization.
