# Phase 2A.2 Gate 5B Final Targeted Re-Audit — Football Oracle

**Verifier:** final narrow code verification (read-only; all stateful tests in /tmp sandboxes)
**Date:** 2026-08-16
**Base:** `13715b37ee9f016c2af9919d0ed7670636a37e45` (verified via `git rev-parse HEAD`)
**Scope:** the single Gate 5B fix and the exact working-tree identity to be committed. Phase 1 / Phase 2A research, HA/ρ/shrink/gap, title probabilities, and historical backtests were NOT reopened. No deployment, no odds, no production code/data changes.

---

# 1. Verdict

```text
PASS — GATE 5B CLOSED, PHASE 2A.2 CODE READY TO COMMIT
```

Independently re-verified: 34/34 targeted re-audit checks (end-to-end through the real tick + persisted fixture store), Phase 2A.2 suite **104/104**, typecheck pass, all earlier phase suites green, World Cup battery green, and the trusted 380-line tape byte-identical before and after. The exact commit set is pinned by a deterministic 41-file manifest.

---

# 2. Exact Working-Tree Manifest

Deterministic manifest: `docs/PHASE2A_2_COMMIT_MANIFEST.txt` — one line per file, format `path | size | sha256 | git-status`, lexicographically sorted (verified sorted).

| Property | Value |
| --- | --- |
| Files in manifest | **41** (13 tracked-modified + 28 untracked Phase 2A.2 files) |
| PHASE2A2_TREE_MANIFEST_SHA256 | `a5b5ed692cf2ef725a69b06991ac5d1b890304157cd32088fa17a4ffd58bc948` |
| Manifest file SHA-256 | `a5b5ed692cf2ef725a69b06991ac5d1b890304157cd32088fa17a4ffd58bc948` (regeneration reproduces the same hash — deterministic) |
| Tracked diff SHA-256 | `53dd99ac6a29250b069b5d0cce3bca9fe44231b7925e5e3a4cb545554a606e4b` (unchanged; the fix lives in untracked Phase 2A.2 files, so the ordinary diff hash alone is NOT sufficient identity) |
| Excluded from commit | `docs/.PHASE1_1_REAUDIT.md.<tmpdir>/` (Phase 1.1 leftover — must NOT be committed) |

Builder-reported changed files independently confirmed:

| File | SHA-256 (current, in manifest) |
| --- | --- |
| `lib/competitions/premier-league/ops/fixture-sync.ts` | `5a951509a90dfa7f3c23f494d2d55dd78c7f94ed114047d08b87e1c163cccc5a` ✓ |
| `scripts/test-phase2a-2.ts` | `3ee85a0c77550bdb5722cc1a64b4b557a01125686a7a1929ff7cace6c1410591` (final 104-check suite; the fix report's earlier `be4c81f6…` reading predated two added same-kickoff resume checks — the fix report §12 was corrected to this value) |

The commit must contain exactly the 41 manifest files (plus, as audit artifacts, this report and the manifest file itself). The manifest pins the implementation tree; the two audit artifacts' hashes are recorded in §10.

---

# 3. Gate 5B End-to-End

Re-run the exact previously failing sequence through the **real sync → persisted fixture → scheduler path** (five `runLiveOpsTick` calls against a sandbox copy of the 380-fixture store; a live football-data.org-style source drives the feed):

```text
tick 1 (T−24h):  T24H frozen in window (1 succeeded); fixture SCHEDULED @ original kickoff
tick 2:          source reports POSTPONED → persisted POSTPONED + certainty TBD;
                 obsolete future jobs CANCELLED; frozen SUCCEEDED history kept
tick 3:          source reports SCHEDULED(TIMED) + new future CONFIRMED kickoff
  → status = SCHEDULED ✓
  → kickoff = 2026-09-01T19:00:00.000Z (new) ✓
  → kickoffCertainty = CONFIRMED ✓
  → exactly 1 fixture revision (POSTPONED → SCHEDULED) ✓
  → 4 future timed jobs (T24H/T2H/T60M/FINAL_PREKICK) replanned on the NEW kickoff ✓
```

**Gate 1: PASS** — future timed prediction jobs resume from the new confirmed kickoff.

---

# 4. Old vs New Job Semantics

| Expectation | Result |
| --- | --- |
| Old-kickoff SUCCEEDED history preserved | ✓ T24H job keeps SUCCEEDED status and its snapshot |
| Obsolete future jobs do not execute | ✓ zero PENDING/ELIGIBLE/BLOCKED rows on the old kickoff; nothing attempts |
| Pending obsolete jobs cancelled | ✓ ≥3 CANCELLED rows on the old kickoff; never revived (incl. after restart) |
| New T24H/T2H/T60M/FINAL_PREKICK on the NEW kickoff | ✓ all four stages PENDING with `kickoffUtc = new kickoff`, window offsets computed from the new time |
| Zero schedulable jobs on obsolete kickoff | ✓ |
| Old prediction snapshots immutable | ✓ frozen T24H unique key and probabilities byte-identical across postpone → reschedule → replays → restart |

**Gate 2: PASS.**

---

# 5. Terminal-State Regression

Executed per state with a stale SCHEDULED payload (live source, CONFIRMED, future kickoff):

| Stored | After stale SCHEDULED payload | Schedulable jobs | Executable attempts |
| --- | --- | --- | --- |
| FINISHED | stays FINISHED | 0 | 0 |
| CANCELLED | stays CANCELLED | 0 | 0 |
| ABANDONED | stays ABANDONED | 0 | 0 |
| SUSPENDED | stays SUSPENDED | 0 | 0 |

Only the intended POSTPONED → SCHEDULED resume path is reopened automatically (live source + explicit schedulable status + future valid kickoff + CONFIRMED certainty). **Gate 3: PASS.**

---

# 6. Replay / Restart Idempotency

Same resume payload replayed through full ticks 3×, then all in-memory caches wiped (job ledger, snapshot store, season bundle) and the tick run a 4th time:

| Check | Result |
| --- | --- |
| 1 logical fixture | ✓ (identity never changes) |
| 1 POSTPONED→SCHEDULED transition revision | ✓ (revision ledger for the fixture = `SCHEDULED→POSTPONED`, `POSTPONED→SCHEDULED` — exactly one of each) |
| 1 current confirmed kickoff | ✓ persisted `2026-09-01T19:00:00.000Z` |
| No duplicate jobs | ✓ exactly 4 rows on the new kickoff after every replay and after restart |
| No duplicate snapshots | ✓ exactly 1 snapshot for the fixture throughout |
| No resurrected obsolete jobs | ✓ zero schedulable rows on the old kickoff after restart; replay ticks produce `fixtureRevisions = 0` |
| Historical snapshots unchanged | ✓ probabilities byte-identical after restart |

**Gate 4: PASS.**

---

# 7. Trusted Tape Integrity

`data/processed/premier-league/live-oos-2026-27.jsonl` measured before every test run and at the end:

| Metric | Required | Measured |
| --- | --- | --- |
| Lines | 380 | **380** |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | **match** |
| SHA-256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | **match** |

**BYTE-IDENTICAL: YES.** Production ops state (`prediction-jobs.jsonl` sha256 `4d1534a7…`, `tick-state.json` sha256 `874e3398…`) also byte-identical — all tests ran against /tmp sandboxes. **Gate 5: PASS.**

---

# 8. Phase 2A.2 Regression

| Suite | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:phase2a-2` | **104/104** (71 original + 33 Gate 5B regression checks; suite's own tape-end check green) |
| `npm run test:phase1` | 55/55 |
| `npm run test:phase1-1` | 33/33 |
| `npm run test:phase2a` | 56/56 |
| `npm run test:phase2a-1` | 45/45 |
| Independent re-audit harness (Gates 1–4 above) | **34/34** |

**Gate 6 (suite part): PASS.**

---

# 9. World Cup Regression

| Suite | Result |
| --- | --- |
| routing | 73/73 |
| track | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| bracket | all checks pass; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 (unchanged) |
| ratings | pass |
| honesty | pass |
| DC selftest | pass |

**Gate 6 (World Cup part): PASS.**

---

# 10. Commit Readiness

- The Gate 5B blocker is CLOSED: reproduced-before, reproduced-after, re-verified end-to-end through the persisted tick path.
- Tree identity is pinned: base `13715b37`, tracked diff sha256 `53dd99ac…`, and the 41-file manifest with `PHASE2A2_TREE_MANIFEST_SHA256 = a5b5ed692cf2ef725a69b06991ac5d1b890304157cd32088fa17a4ffd58bc948`.
- No CODE BLOCKERS remain. Deployment configuration (API keys, 5-minute scheduler, persistent storage) remains out of scope and unchanged from `docs/PHASE2A_2_TARGETED_VERIFICATION.md` §23.
- Audit artifacts of this pass (to be committed alongside the manifest set): this report and `docs/PHASE2A_2_COMMIT_MANIFEST.txt` (`a5b5ed69…`).

```text
NEXT ACTION: commit the exact audited Phase 2A.2 tree (the 41 manifest files),
then proceed to production deployment/configuration.
```

No further general code audit is recommended.
