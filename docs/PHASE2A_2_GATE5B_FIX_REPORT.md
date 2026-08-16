# Phase 2A.2 Gate 5B Fix Report — Football Oracle

**Fix author:** surgical remediation pass (single state-transition bug)
**Date:** 2026-08-16
**Base:** `13715b37ee9f016c2af9919d0ed7670636a37e45` (Phase 2A.2 working tree, uncommitted)
**Scope:** exactly one bug — a POSTPONED fixture never returned to a schedulable state after a live source reported the rearranged confirmed kickoff. No deployment, no model, no market-data, no UI work. Nothing else touched.

---

# 1. Verdict

```text
PASS
```

The Gate 5B blocker from `docs/PHASE2A_2_TARGETED_VERIFICATION.md` is fixed, proven by reproduction-before/after, 33 new regression checks in the Phase 2A.2 suite, a full tick-level end-to-end replay, and a re-run of all critical integrity gates (33/33) plus the complete Phase 1 → 2A.2 suite chain and the World Cup battery. The trusted 380-line tape is byte-identical.

---

# 2. Original Failure Reproduction

Recorded BEFORE any code change (standalone script against the audited tree, sandboxed state):

```text
stored fixture: status=POSTPONED kickoff=2026-08-21T19:00:00.000Z certainty=CONFIRMED
after sync:   status=POSTPONED kickoff=2026-09-01T19:00:00.000Z certainty=CONFIRMED
revisions:    oldStatus=POSTPONED newStatus=POSTPONED newKickoff=2026-09-01T19:00:00.000Z (kickoff-only revision)
planned jobs: total=0 on-new-kickoff(pending/eligible)=0
Gate 5B bullet 4: FAIL (status stayed POSTPONED → 0 jobs)
```

Exactly as the independent audit reported: kickoff and kickoffCertainty updated, status stuck at POSTPONED, scheduler produced zero future timed jobs for the rearranged fixture.

---

# 3. Root Cause

`lib/competitions/premier-league/ops/fixture-sync.ts` — `applyNormalized()` applied an incoming status only when it was anything OTHER than SCHEDULED:

```ts
if (n.status && n.status !== "SCHEDULED") { next.status = n.status; ... }
```

A rearranged match reported by football-data.org as `TIMED` / by API-Football as `NS` is normalized to `SCHEDULED` (`mapSourceStatus`), so that branch never fired for the resume case. The kickoff/certainty branches ran, but the fixture's `POSTPONED` status was never cleared. `planPredictionJobs` then treated the fixture as postponed-like (`POSTPONED/CANCELLED/ABANDONED`) and skipped it forever. There was no other code path that could return a postponed fixture to a schedulable status.

---

# 4. State-Transition Policy

Explicit policy implemented and documented in the code:

| Stored (canonical) | Incoming live payload | Allowed automatic transition |
| --- | --- | --- |
| POSTPONED | SCHEDULED + live source + future valid kickoff + certainty CONFIRMED | **POSTPONED → SCHEDULED (resume)** — the only auto-resumable state |
| POSTPONED | SCHEDULED but certainty not CONFIRMED, or kickoff not in the future, or non-live source | stays POSTPONED |
| CANCELLED / ABANDONED / SUSPENDED | any SCHEDULED payload | **never auto-reopened** (operator action only) |
| FINISHED / LIVE | any SCHEDULED payload | **never reopened** |
| SCHEDULED | POSTPONED/CANCELLED/ABANDONED | normal postpone handling (unchanged) |

The resume is source-driven and explicit: a kickoff timestamp change alone is never sufficient. The incoming normalized source state must itself say the fixture is schedulable (SCHEDULED/TIMED/NS), from a live structured source (`football-data.org` / `api-football`), with a CONFIRMED kickoff strictly in the future relative to the sync time.

---

# 5. Code Change

One file changed: `lib/competitions/premier-league/ops/fixture-sync.ts` (+29 lines, surgical).

1. New policy constant: `AUTO_RESUMABLE_STATUSES = { POSTPONED }` (documented: CANCELLED/ABANDONED/SUSPENDED/LIVE/FINISHED are never auto-reopened).
2. `applyNormalized(current, obs, now?)` gained a resume branch executed before the kickoff/certainty branches:

```ts
const currentStatus = canonicalizeFixtureStatus(current.status);
if (
  n.status === "SCHEDULED" &&
  AUTO_RESUMABLE_STATUSES.has(currentStatus) &&
  LIVE_SOURCES.includes(obs.source) &&
  Boolean(n.kickoffUtc) &&
  Number.isFinite(Date.parse(n.kickoffUtc)) &&
  Boolean(now) && Date.parse(n.kickoffUtc) > Date.parse(now) &&
  n.kickoffCertainty === "CONFIRMED"
) {
  next.status = "SCHEDULED";
  next.statusUpdatedAt = obs.retrievedAt;
  resumed = true;
}
```

3. The revision reason is explicitly recorded (overriding the kickoff-only reason): `rescheduled: POSTPONED → SCHEDULED (<source>; kickoff <utc>; CONFIRMED)`. The existing revision machinery persists `oldStatus/newStatus/oldKickoff/newKickoff/oldCertainty/newCertainty/source/changedAt` — the historical postponement event and its revision are never erased.
4. `syncFixturesFromObservations` passes `input.now` into `applyNormalized` (single call site).

No changes to the scheduler, settlement, ratings, model, or any other module. The scheduler resumes automatically because it already keys on `status + kickoffUtc + kickoffCertainty`; old jobs stay terminal (CANCELLED/SUCCEEDED) and new jobs get new identities (`fixtureId::stage::newKickoff`).

---

# 6. Gate 5B Reproduction After Fix

Same standalone scenario, fixed tree:

```text
stored fixture: status=POSTPONED kickoff=2026-08-21T19:00:00.000Z certainty=CONFIRMED
after sync:   status=SCHEDULED kickoff=2026-09-01T19:00:00.000Z certainty=CONFIRMED
revisions:    oldStatus=POSTPONED newStatus=SCHEDULED newKickoff=2026-09-01T19:00:00.000Z
              reason: "rescheduled: POSTPONED → SCHEDULED (football-data.org; kickoff 2026-09-01T19:00:00.000Z; CONFIRMED)"
planned jobs: total=4 on-new-kickoff(pending/eligible)=4
Gate 5B bullet 4: PASS (resumes)
```

Tick-level end-to-end (real `runLiveOpsTick` + persisted 380-fixture store in sandbox): tick 1 freezes T24H in-window → tick 2 persists POSTPONED (certainty TBD) and cancels future jobs, frozen snapshot kept → tick 3 persists SCHEDULED + new CONFIRMED kickoff with exactly 1 fixture revision and replans 4 future jobs on the new kickoff → old frozen prediction preserved, zero schedulable jobs on the obsolete kickoff. **Gate 5B: PASS.**

---

# 7. Idempotency

- Same resume payload replayed 3× through fixture sync: sync #2 and #3 produce **no logical change and no revision** (`changedFixtureIds = 0`); exactly **one** POSTPONED→SCHEDULED revision is persisted for the fixture.
- Full-tick replay (tick 4, same payload): `fixtureRevisions = 0`, still exactly 4 jobs for the new kickoff, still exactly 1 snapshot for the fixture. No duplicate jobs, no duplicate snapshots, no duplicate revisions.

---

# 8. Restart Behavior

After POSTPONED → rescheduled → replanned, all in-memory caches wiped (job ledger, snapshot store, rating events): jobs reload from disk (new jobs PENDING on the new kickoff; old jobs remain SUCCEEDED/CANCELLED — never revived); the pre-postponement frozen snapshot reloads byte-identical; the persisted fixture store still reads SCHEDULED + new kickoff + CONFIRMED.

---

# 9. Conflict / Terminal-State Regression

All executed against the fixed code:

| Scenario | Result |
| --- | --- |
| Source A still POSTPONED, source B SCHEDULED + different kickoff | fixture stays POSTPONED (postponement source wins); **no schedulable jobs** |
| Two live sources SCHEDULED with different rearranged kickoffs | SOURCE_CONFLICT; verificationStatus blocked; **no schedulable jobs** |
| FINISHED + stale SCHEDULED payload | stays FINISHED; nothing can execute (`executeEligibleJobs` attempts 0) |
| CANCELLED + SCHEDULED payload | stays CANCELLED (never auto-reopened) |
| ABANDONED + SCHEDULED payload | stays ABANDONED (never auto-reopened) |
| SUSPENDED + SCHEDULED payload | stays SUSPENDED (never auto-reopened) |
| POSTPONED + SCHEDULED but certainty ≠ CONFIRMED | stays POSTPONED |
| POSTPONED + SCHEDULED with non-future kickoff | stays POSTPONED |
| POSTPONED (rearranged kickoff already known, TBD) + SCHEDULED + CONFIRMED same kickoff | resumes SCHEDULED + 4 jobs (the postpone-obs-already-carried-the-date flow) |
| Rearranged fixture synced late (T−80m) | already-passed T24H/T2H windows created as **MISSED** (never backfilled); T60M/FINAL_PREKICK remain schedulable; zero jobs on the original kickoff |

Conflict safety is unchanged — the resume path sits behind the existing `detectKickoffConflict` / source-precedence logic and can never bypass it.

---

# 10. Phase 2A.2 Regression

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run test:phase2a-2` | **104/104** (71 original checks all still green + 33 new Gate 5B regression checks) |
| `npm run test:phase1` | 55/55 |
| `npm run test:phase1-1` | 33/33 |
| `npm run test:phase2a` | 56/56 |
| `npm run test:phase2a-1` | 45/45 |
| Condensed independent integrity harness (critical gates on the fixed tree) | **33/33** — DEFAULT blocked · scheduler exactly-once + restart · MISSED no-backfill · verified-final-only settlement · settlement exactly-once · rating exactly-once · restart recovery · future-prediction uses new rating state · stage-separated evaluation · tick-level Gate 5B end-to-end · tape unchanged |

Critical integrity gates re-verified: DEFAULT timed stages blocked ✓; scheduler exactly-once ✓; MISSED stage no backfill ✓; VERIFIED_FINAL-only settlement ✓; settlement exactly-once ✓; rating update exactly-once ✓; restart recovery ✓; future prediction uses new rating state ✓; stage-separated evaluation ✓; trusted tape unchanged ✓.

---

# 11. Trusted Tape Integrity

`data/processed/premier-league/live-oos-2026-27.jsonl` measured before the fix, after the fix, and after every test run:

| Metric | Required | Measured |
| --- | --- | --- |
| Lines | 380 | **380** |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | **match** |
| SHA-256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | **match** |

**BYTE-IDENTICAL: YES.** Production ops state (`data/processed/premier-league/ops/prediction-jobs.jsonl` sha256 `4d1534a7…`, `tick-state.json` sha256 `874e3398…`) also byte-identical — all tests ran in /tmp sandboxes.

---

# 12. Working-Tree Identity

| Item | Value |
| --- | --- |
| HEAD | `13715b37ee9f016c2af9919d0ed7670636a37e45` |
| Tracked working-tree diff SHA-256 | `53dd99ac6a29250b069b5d0cce3bca9fe44231b7925e5e3a4cb545554a606e4b` (unchanged — the fix touches only untracked Phase 2A.2 files) |
| Files changed by the fix | `lib/competitions/premier-league/ops/fixture-sync.ts` — sha256 `dcb0bde1…` → `5a951509a90dfa7f3c23f494d2d55dd78c7f94ed114047d08b87e1c163cccc5a`; `scripts/test-phase2a-2.ts` — sha256 `417c3411…` → `3ee85a0c77550bdb5722cc1a64b4b557a01125686a7a1929ff7cace6c1410591` (final 104-check suite; two same-kickoff resume checks were added after the first capture, updating the earlier `be4c81f6…` reading) |
| Other files | untouched (git status set identical to the audited tree) |
| New artifact | this report (`docs/PHASE2A_2_GATE5B_FIX_REPORT.md`) |

The Phase 2A.2 implementation is preserved in full; only the two files above changed on top of the audited tree.

---

# 13. Targeted Re-Audit Readiness

```text
READY FOR TARGETED RE-AUDIT
```

A targeted reviewer should re-run: (a) `npm run test:phase2a-2` (104 checks incl. the 33 Gate 5B regression checks), (b) the Gate 5B scenario from `docs/PHASE2A_2_TARGETED_VERIFICATION.md` §8, (c) `npm run typecheck`, (d) the tape identity above. Deployment items (API keys, 5-minute scheduler, persistent storage) remain explicitly OUT OF SCOPE and still apply per `docs/PHASE2A_2_TARGETED_VERIFICATION.md` §23 — this fix does not change the deployment readiness assessment (`NOT READY`).

Remaining code blockers: **none known.** The single audited CODE FAIL (Gate 5B) is fixed; all 102/103 audit checks and all critical integrity gates remain green.
