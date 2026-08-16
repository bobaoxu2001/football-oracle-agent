# Phase 2A.1 guardrail report

**Date:** 2026-08-16  
**Verdict:** **PASS**

The 380 committed LIVE_OOS snapshots were not rewritten. Three P1 production blockers from the independent Phase 2A audit are closed. Phase 2B / scheduler / results / odds were not started.

---

# 1. Verdict

**PASS**

| Gate | Result |
| --- | --- |
| Snapshot enumeration | PASS — /live and API report 380 |
| Alias dedup | PASS |
| Archive idempotency | PASS — 1st/2nd/3rd run stay unique |
| No-overwrite historical guard | PASS — replace/truncate throws |
| Stage identity | PASS — PRESEASON vs T24H still distinct |
| Kickoff certainty | PASS — 30 CONFIRMED / 350 DEFAULT / 0 TBD |
| DEFAULT cannot schedule T60M | PASS |
| CONFIRMED can become eligible | PASS |
| Fixture reschedule identity | PASS |
| 379-fixture gate | BLOCKED |
| Outsider fixture gate | BLOCKED |
| Duplicate fixture gate | BLOCKED |
| Invalid pair / home=away / 18-20 split | BLOCKED |
| Missing provenance | BLOCKED |
| Real 2026-27 manifest | DATA_READY |
| /live browser count | 380 |
| Live tape checksum | PASS — byte-identical |
| World Cup | PASS |

---

# 2. Starting State

| Item | Value |
| --- | --- |
| Start HEAD | `6d293d0243ac68492a53b28139060620e5107ccb` |
| Implementation SHA | `1c78f3179408bddddc17d0e914e0a486cace7147` |
| Live tape | `data/processed/premier-league/live-oos-2026-27.jsonl` |
| Lines | 380 |
| Bytes | 569019 |
| md5 | `34f7ca54025a3a48df9f1a169df66315` |
| sha256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` |

---

# 3. LIVE Enumeration Fix

**Root cause of 764.** `loadFromDisk` registered every snapshot under both the canonical 6-part key and the Phase 1 legacy 5-part key (no `predictionStage`). `listSnapshots()` enumerated `Map.values()`, so each observation appeared twice. 380 × 2 = 760, plus two local post-freeze smoke snapshots also aliased → **764**.

The committed JSONL was never duplicated. The defect was index/query only.

**Fix.** The in-memory store now has:

- `byUniqueKey` — one entry per canonical identity  
  `competition::season::fixtureId::modelVersion::predictionStage::asOf`
- `aliases` — legacy keys resolve for *reads* only

`listSnapshots()` returns unique observations. First-write-wins uses the canonical key only, so PRESEASON and T24H at the same asOf still coexist.

`/live` and `/api/live` headline counts read the **committed tape** via `loadCommittedLiveOos()`, not the gitignored working store.

---

# 4. Archive / Durability

- `archiveLiveOosSnapshots` dedups by uniqueKey inside the batch **and** against existing lines.
- Three successive archives of the same set stay at the same unique count.
- The committed tape refuses truncate/replace (`replaceCanonicalLiveTape()` throws).
- New keys cannot be appended to the committed 380 unless `LIVE_OOS_ARCHIVE_ALLOW_APPEND=1`.
- Re-archive of already-present keys is a no-op.

---

# 5. Kickoff Certainty

Schema field: `kickoffCertainty` = `CONFIRMED | PROVISIONAL | DEFAULT | TBD`  
Plus `scheduledDate` so a Saturday date is not implied to be a confirmed 15:00.

Classification from the official 19 June 2026 release rule (“weekend/BH 15:00, midweek 20:00 unless otherwise stated”):

| Status | Count | Meaning |
| --- | ---: | --- |
| CONFIRMED | 30 | Explicit non-default slots (12:30 / 14:00 / 16:30 / 17:30) and Friday/Monday/Saturday 20:00 listed slots |
| PROVISIONAL | 0 | unused on this tape |
| DEFAULT | 350 | Saturday/Sunday 15:00 and Wednesday 20:00 conventional slots |
| TBD | 0 | — |

This is fixture **metadata**. Snapshot probabilities were not recomputed.

---

# 6. Timed Prediction Eligibility

`canScheduleTimedPrediction(fixture, stage)`:

- `T24H` / `T2H` / `T60M` / `FINAL_PREKICK` require `kickoffCertainty === CONFIRMED`.
- `EARLY` / `PRESEASON` remain allowed on DEFAULT/PROVISIONAL dates.

A Saturday 15:00 DEFAULT fixture that later becomes Sunday 16:30 CONFIRMED keeps the same fixture id; historical EARLY snapshots stay unchanged; future timed stages become eligible.

The scheduler itself is **not** implemented.

---

# 7. DATA_READY Validation

`evaluateSeasonData` returns `{ status, errors, warnings, checks }`. There is no force-promote override.

Required for DATA_READY on a complete PL season:

- competition + season identity
- 20 unique clubs; no relegated club active; promoted trio present
- 380 unique fixtures; home ≠ away; all clubs in the field
- 38 fixtures / 19 home / 19 away per club
- each unordered pair twice; one home and one away
- valid scheduled date; structurally valid kickoff metadata
- provenance present (`source` + `retrievedAt`)
- identities resolved

Kickoff confirmation completeness is **not** required. DEFAULT times still yield DATA_READY.

Verification is no longer self-referential Wikipedia-vs-itself. Membership is checked against a separately cited independent set (`verifiedAgainst` + `verificationArtifact: docs/PHASE2A_INDEPENDENT_AUDIT.md`).

---

# 8. Adversarial Gate Tests

| Mutation | Result |
| --- | --- |
| Real 2026-27 manifest | DATA_READY |
| 379 fixtures | DATA_BLOCKED |
| Outsider (West Ham) in a fixture | DATA_BLOCKED |
| Duplicate fixture id | DATA_BLOCKED |
| Same pair twice at one home venue | DATA_BLOCKED |
| home = away | DATA_BLOCKED |
| 18 home / 20 away | DATA_BLOCKED |
| Missing scheduled date | DATA_BLOCKED |
| Unresolved club id | DATA_BLOCKED |
| Missing provenance | DATA_BLOCKED |
| DEFAULT kickoff on a complete season | DATA_READY, timed-stage = false |

---

# 9. /live

API (`GET /api/live`):

```text
nPredictions: 380
settled: 0
stages: EARLY 15 · PRESEASON 365 · T24H/T2H/T60M/FINAL_PREKICK 0
model: pl-live-v0.2.0
gate: DATA_READY
```

Chrome headless `--dump-dom` on `http://127.0.0.1:3000/live`:

- LIVE_OOS snapshots **380** (764 absent)
- Settled **0**
- Brier/RPS/LogLoss **—**; ECE “n too small”; no fake scores
- Stage breakdown EARLY 15 / PRESEASON 365
- Upcoming real fixtures with CONFIRMED/DEFAULT labels
- No hydration error, no runtime exception
- Model `pl-live-v0.2.0`

---

# 10. Evidence Record Integrity

| | Start | End |
| --- | --- | --- |
| Lines | 380 | 380 |
| Bytes | 569019 | 569019 |
| md5 | 34f7ca54025a3a48df9f1a169df66315 | 34f7ca54025a3a48df9f1a169df66315 |
| sha256 | a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da | same |

**Byte-identical: YES.**

First forecasts unchanged (Arsenal–Coventry 0.712 / 0.1888 / 0.0992). Title MC file untouched. HA/ρ/shrink/gap untouched.

---

# 11. World Cup Regression

| Suite | Result |
| --- | --- |
| typecheck | pass |
| routing | 73/73 |
| track | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| ratings | pass |
| honesty | pass |
| dc:selftest | pass |
| validate:bracket | 495/495; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 |

---

# 12. Remaining P2/P3 Issues

Not promoted to P1. Unchanged research items from the independent audit:

- gap=120 is a grid-edge / feeder-regime mismatch (research)
- shrink sensitivity of the title board
- Championship feeder Wrexham-mapping / old-season decay
- scorelineDistribution is a top-6 subset
- sourceFixtureId is internal, not an official pairing id
- model-version bump is not mechanically enforced

---

# 13. Operationalization Readiness

**READY FOR TARGETED INDEPENDENT VERIFICATION**

Do not start the scheduler, results feed, or market layer until that verification. The trusted 380-line tape remains the evidence record.
