# Phase 2A.3 Final Production Deployment Audit — Football Oracle

**Verifier:** independent deployment audit (read-only against production; no production code/data modified)
**Date:** 2026-08-16 (observations 13:05Z–13:40Z)
**Production:** https://football-oracle-agent.vercel.app (Vercel, team ao-xus-projects, Hobby)
**Local checkout:** `1dab4715126410c2dd78e9fc71a8477df5214e22` (Phase 2A.3 deployment commit)
**Method:** Vercel CLI metadata, production HTTP via a reachable path, direct read-only MongoDB Atlas queries, headless-Chrome page checks, live football-data.org dry run, local suites, and code inspection. The audit machine's direct route to *.vercel.app is blocked at network level; all production HTTP was therefore performed through a local HTTP proxy that reaches the edge — the responses are the production lambdas' own.

---

# 1. Verdict

```text
GO AFTER DEPLOYMENT FIXES
```

- **CODE: PASS** — audited 2A.2 implementation + 2A.3 persistence/auth/lease code, all suites green, tape untouched.
- **PRODUCTION DATA: PASS** — Atlas-backed durable state verified end-to-end; 30 CONFIRMED / 350 DEFAULT; 120 valid pending jobs; 0 conflicts; 0 fabricated results.
- **AUTONOMOUS OPERATIONS: FAIL** — the 5-minute scheduler is not running anywhere verifiable and has no supervision; the only automatic trigger is a daily 04:00Z keep-alive cron, which cannot catch any timed prediction window.

> **The decisive question: if every developer closes their laptop tonight, will Football Oracle autonomously freeze Arsenal–Coventry T24H?**
> **Answer: NO.** Nothing is running the 5-minute tick loop. The observed production ledger stopped ticking at 2026-08-16T11:09:38Z and stayed frozen for the entire ~35-minute audit window (and hours before it). A T24H window (4h wide) or FINAL_PREKICK (15m wide) cannot be caught by a daily 04:00Z cron.

---

# 2. Production Deployment Identity

| Item | Verified |
| --- | --- |
| Project | `ao-xus-projects/football-oracle-agent` (NOT the World Cup project) |
| Production URL | https://football-oracle-agent.vercel.app (alias + `…-ao-xus-projects.vercel.app`) |
| Deployment id | `dpl_7ZSkZSfCJwAgcGvm6GnvdZoLsXEP` |
| Deployment created | Sun Aug 16 2026 19:08:33 +0800 (11:08:33Z), status ● Ready, target production, λ functions iad1 |
| Deployed revision | the local working tree that became commit `1dab4715` (CLI deploy, no git metadata on the project). Runtime behavior independently confirms 2A.3 code: `persistence.backend=mongo`, `freshness`, auth reasons `missing secret`/`invalid secret`, 409-on-lock route |
| World Cup isolation | `worldcup-oracle-agent` is a separate Vercel project with its own deployment history (verified via CLI) — not replaced, not touched |

---

# 3. Mongo Persistence

Direct read-only connection to MongoDB Atlas, database `football_oracle` (URI used programmatically, never printed):

- Collections: `pl_ops_bundle` (the durable state doc), `pl_ops_locks` (tick lease).
- `pl_ops_bundle.current` holds all 13 state keys (jobs 1.03 MB, sourceObservations 5.38 MB, scheduleRevisions 310 KB, fixturesOverlay, tickState, ratingEvents, settlements, operationalLiveOos, workingSnapshots, …). `updatedAt` = 2026-08-16T11:09:39.659Z (the 9th tick's flush).
- Production routing (`PL_OPS_BACKEND=mongo` on Vercel): every request hydrates the bundle into a per-invocation `/tmp` workdir, runs the existing 2A.2 file logic, and flushes back. **No production truth lives on a writable Vercel filesystem** — `/tmp` is scratch; Mongo is the store.
- Tick lease doc currently free (no stuck lock; 90s TTL would self-expire anyway — expiry verified in code: `lockedUntil <= now` → reacquire).

**Vercel functions do not depend on writable local filesystem for production truth. PASS.**

---

# 4. Production Cold-Start Test

Three independent `GET /api/health` requests (distinct cache-busting params, 12s apart), each served by a fresh lambda (distinct `lastHydratedAt`: 13:24:54Z, 13:25:07Z, 13:25:20Z):

- All three recovered **identical** core state from Mongo: `lastTickAt=2026-08-16T11:09:38.937Z`, 120 PENDING, 1400 CANCELLED, backend mongo/durable/hydrated.
- No process-memory dependency. State survives separate serverless invocations. **PASS.**

---

# 5. Scheduler Runtime

| Question | Finding |
| --- | --- |
| Code mechanism | `scripts/ops-scheduler-worker.ts` — an infinite `setInterval` pinger that calls `GET /api/ops/tick` with `Authorization: Bearer <CRON_SECRET>` every 5 min |
| Actual runtime location | **NONE.** No worker process on this machine (`ps`, launchd, LaunchAgents, crontab, pm2 all empty); no CI workflow (only the unrelated nightly DC backtest); no evidence of any VPS/cloud worker |
| Vercel cron | `0 4 * * *` daily keep-alive only (Hobby cannot honor 5-minute cron; `*/5` was rejected at deploy time per the report) |
| Observed behavior | 9 ticks, all clustered in 8 minutes (11:01–11:09Z, three bursts), then zero ticks for 2.5+ hours including the entire audit window |

The worker is a manually launched local script. It is not running. **Autonomous scheduling does not exist.**

---

# 6. Scheduler Autonomy

> If the developer closes their laptop right now, will the 5-minute scheduler continue?

**NO.** There is no hosted worker, no supervised process, no CI recurrence. The only remaining automatic trigger is the daily 04:00Z Vercel cron, which fires at a fixed time of day that is essentially guaranteed to miss every T24H/T2H/T60M/FINAL_PREKICK window (they are fixture-relative, 4h/1h/30m/15m wide). **AUTONOMOUS OPERATIONS: FAIL.**

---

# 7. Scheduler Restart / Supervision

For the actual scheduler host — there is none. No systemd, pm2, Docker restart policy, launchd, supervisor, or CI recurrence exists for `ops-scheduler-worker.ts`. A manually launched infinite-loop script without supervision is not production-ready. **FAIL (part of the same blocker).**

---

# 8. Tick History

Independent reconstruction from Mongo (tick state + source-observation/revision timestamps):

| Evidence | Value |
| --- | --- |
| tickState.ticks | **9** |
| Observation batches (380 FD rows each) | 11:01Z ×3, 11:03Z ×2, 11:07Z ×2, 11:09Z ×2 → exactly 9 ticks |
| Revisions | 700 total: 350 at 11:01Z (date-only misfire), 20 at 11:03Z (TIMED-default-slot), 330 at 11:07Z (corrective revert) |
| Last tick | 2026-08-16T11:09:38.937Z — **unchanged through 13:40Z** |

All 9 ticks are manual/verification bursts (deployment session). None came from an autonomous scheduler. The daily cron had not fired for this deployment at audit time.

---

# 9. Health Truthfulness

- Production `/api/health` and `/health` (browser) currently report **DEGRADED** with the single reason "ops tick stale (expected ~5 minute cadence)" — because the last tick is hours old. This is **truthful**: the system honestly signals that the scheduler is not running. It does not claim HEALTHY while idle.
- Staleness threshold: `TICK_STALE_MS = 15 minutes` (code-verified) → stale ticks degrade health; a dead worker can never leave HEALTHY forever. **PASS.**

---

# 10. Live Source

- football-data.org: **configured and working.** Local dry run with the production key (not printed): HTTP 200, 380 PL 2026 matches, 0 errors, all 380 identities resolved, 0 finished observations (no result hallucination), certainty before=after=30/350/0/0. Production Mongo holds 3420 persisted FD observations (9 ticks × 380) — consistent.
- API-Football: not configured (optional corroboration — acceptable per design).
- Date-only placeholder safety (production): the 330 FD `SCHEDULED T00:00:00Z` rows are mapped to `kickoffUtc=null`/certainty TBD and cannot erase official DEFAULT times; live rows at Sat 15:00/Wed 20:00 classify as **DEFAULT**, not CONFIRMED (code: `certaintyFromLiveStatus` now uses the official classifier). Production overlay verified: **30 CONFIRMED / 350 DEFAULT** — not 380. **PASS.**

---

# 11. Cancelled Misfire Jobs

Direct row-level audit of the 1400 CANCELLED rows in Mongo:

1. **Why 1400:** the first bad date-only planning pass created jobs for 350 fixtures (330 date-only + 20 TIMED-at-default-slot) × 4 stages = 1400; the corrective pass cancelled them (`cancelled: kickoffCertainty=DEFAULT`).
2. **Scope:** all 1400 belong to DEFAULT fixtures — **0 rows on any of the 30 CONFIRMED fixtures**; 1320 carry midnight kickoffs, 80 carry the official default slot times.
3. **Terminal:** all 1400 are CANCELLED; the planner/upsert/refresh code never revives terminal rows (code-verified; the 2A.2 suite covers this).
4. **Re-eligibility:** none — CANCELLED rows are never promoted.
5. **Counts:** they appear honestly in `/health` job counts (cancelled 1400) but never as pending work; `nextJob` only considers PENDING/ELIGIBLE.
6. **/health impact:** none beyond the visible cancelled count.
7. **Uniqueness:** 0 active rows share a jobId with a cancelled row.
8. **Future collision:** none possible under the current certainty policy — a fixture can only become CONFIRMED at a non-default slot, i.e. a kickoff different from the cancelled rows' kickoffs (15:00/20:00 defaults, or midnight). The 80 default-slot rows would only collide if the policy ever started confirming fixtures at default slot times.

**Classification: SAFE HISTORICAL OPS NOISE** (with the policy caveat above; do not delete during this audit — no deletion was performed).

---

# 12. First Real T24H Path

Current production state (independently recomputed from the Mongo fixture overlay + `/api/health`):

| Field | Value |
| --- | --- |
| Fixture | pl-2026-27-arsenal-coventry (Arsenal vs Coventry City) |
| Kickoff | 2026-08-21T19:00:00.000Z · CONFIRMED · SCHEDULED |
| Stage | T24H |
| eligibleFrom | 2026-08-20T17:00:00.000Z |
| target | 2026-08-20T19:00:00.000Z |
| eligibleUntil | 2026-08-20T21:00:00.000Z |
| Job status | PENDING (one of exactly 120) |

The freeze path — tick → planner ELIGIBLE → `snapshotPremierLeagueMatch` (audited engine, HA/ρ untouched) → immutable snapshot with canonical 6-part identity (competition, season, fixtureId, modelVersion, predictionStage, asOf) → `workingSnapshots` + `operationalLiveOos` in the bundle → flush to Mongo → visible via `/live` — has **no remaining local-filesystem dependency for production truth** (routeDurablePaths pins every store to the /tmp workdir; the canonical tape is never a write target; exactly-once is enforced by first-write-wins at snapshot and job level). A production T24H would survive a Vercel cold start.

**Caveat (see §17):** if the tick fires, everything works — but nothing will fire it at the right time (daily cron only).

---

# 13. Result Path

- football-data.org FINISHED observation → normalized (`mapFootballDataMatch`) → `verifyFixtureResult`.
- **Single-source semantics:** with only FD configured, one trusted FINISHED row with numeric score → **VERIFIED_FINAL immediately** (the `othersOpen` provision only applies when a second trusted source exists). This matches the declared trust policy: one trusted structured feed is sufficient; two agreeing sources also verify; two disagreeing → CONFLICT (no settlement); LIVE/HT never settle.
- Settlement → `settlements.jsonl` in the bundle (first-write-wins per snapshotUniqueKey) → rating event exactly-once per fixtureId → both flushed to Mongo. Persistence adapters exist through the entire path (verified in code + 2A.3 suite). Adding API-Football later can only change **future** verifications (existing settlements are immutable first-writes; a correction path exists but does not run automatically). Health with one source is truthful: HEALTHY (when the tick is fresh) is legitimate because FD alone is the declared verifier; the reason list would degrade only if no live source at all were configured near matchday.
- **Production settlement surface gap (new finding, §17):** in Mongo routing, `SNAPSHOT_STORE_PATH` is pointed at the /tmp workdir, so `listSnapshots()` no longer includes the 380 committed tape rows. `settleFixture` therefore settles only operational (timed) snapshots; the frozen PRESEASON/EARLY rows of a finished fixture would remain unsettled in production (empirically confirmed: production routing yields `listSnapshots()=0` while the tape reads 380). The tape itself is untouched; stage-completeness for PRESEASON/EARLY is silently lost in production.

---

# 14. Browser Verification

Headless Chrome against production (through the reachable proxy):

- **/live:** 380 LIVE_OOS · settled 0 · stage table PRESEASON 365 / EARLY 15 / T24H 0 / T2H 0 / T60M 0 / FINAL_PREKICK 0 with "—" metrics · no fake headline metrics · "FINAL_PREKICK is not a lineup-confirmed model" · model pl-live-v0.2.0 · DATA_READY · upcoming fixtures with CONFIRMED/DEFAULT labels · no hydration/runtime errors.
- **/health:** Overall DEGRADED (tick stale) · DATA_READY · store "mongo · durable · mongo URI present" · football-data.org configured / API-Football not configured · 30/350/0/0 · pending 120 / cancelled 1400 · cadence 5 min · freshness stale · next eligible job Arsenal–Coventry T24H with full window + target · no hydration/runtime errors.
- `/api/live` JSON: 380 / settled 0 / all metrics null / stagePerformance 6 rows N=0 → null / model HA=72 ρ=−0.061 unchanged / DATA_READY. **PASS.**

---

# 15. Trusted Tape

Local canonical tape measured before and after all audit activity:

| Metric | Required | Measured |
| --- | --- | --- |
| Lines | 380 | **380** |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA-256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

**BYTE-IDENTICAL: YES.** No deployment operation touched it.

---

# 16. Backup / Recovery

Actual status: production operational evidence lives in Atlas as a **single `pl_ops_bundle` document** (no versioned history; each flush overwrites it). The frozen 380 tape remains in git. Rating state is rebuildable from `RatingAppliedEvent` rows while the bundle survives. No Atlas PITR/export runbook exists (free-tier Atlas has no point-in-time recovery by default). This is a minimal-but-workable arrangement; a bundle-export script or periodic dump is recommended (non-blocking).

---

# 17. Required Deployment Fixes

**Blockers (must fix before MW1):**
1. **Run the 5-minute scheduler on a persistent, supervised host.** Options: a small VPS with systemd/pm2/Docker restart policy running `ops:worker`; a GitHub Actions scheduled workflow (cron `*/5 * * * *` with concurrency guard + the repo's missing remote); or a Vercel plan upgrade that honors 5-minute cron. Until then the system is a manual tool, not an autonomous operator.
2. **Fix the production settlement surface** so the committed 380 EARLY/PRESEASON tape rows are enumerable by `settleFixture` in Mongo routing (seed the workdir store with the tape on hydrate, or union `loadCommittedLiveOos()` in the production settlement path, keeping first-write-wins). Required before the first VERIFIED_FINAL.

**Recommended (non-blocking):**
3. Periodic export/backup of `pl_ops_bundle` and a documented rebuild runbook.
4. Monitoring/alerting on `/health` freshness (the DEGRADED signal already exists — 15-minute threshold verified).
5. Document the 1400-row cancellation history once (no deletion needed).

---

# 18. Phase 2B0 Go / No-Go

```text
WAIT
```

Phase 2B0 (market odds) must not start until the autonomous 5-minute scheduler is actually hosted and supervised, and the settlement-surface fix lands. Code and data are otherwise production-worthy.
