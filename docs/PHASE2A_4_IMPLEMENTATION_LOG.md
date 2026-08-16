# Phase 2A.4 implementation log — Production blocker remediation

**Start:** 2026-08-16  
**Phase 2A.3 audit verdict:** `GO AFTER DEPLOYMENT FIXES`  
**Independent conclusions:** CODE PASS · PRODUCTION DATA PASS · AUTONOMOUS OPERATIONS FAIL

This phase remediates the two remaining production blockers:

1. Settlement must enumerate frozen PRESEASON/EARLY tape rows **and** operational timed snapshots.
2. A real hosted ≤5-minute scheduler must tick production without a developer laptop.

The canonical tape is never a write target.

---

## Starting state (before any Phase 2A.4 write)

| Item | Value |
| --- | --- |
| HEAD | `1dab4715126410c2dd78e9fc71a8477df5214e22` |
| git status | clean tracked tree; untracked: `docs/PHASE2A_3_TARGETED_DEPLOYMENT_AUDIT.md`, leftover Phase 1.1 tmpdir |
| Production URL | https://football-oracle-agent.vercel.app |
| Production deployment | `football-oracle-agent-8g6vba267-ao-xus-projects.vercel.app` (Phase 2A.3, `dpl_7ZSkZSfCJwAgcGvm6GnvdZoLsXEP` lineage) |
| `/api/health` overall | DEGRADED — `ops tick stale (expected ~5 minute cadence)` |
| Last tick | `2026-08-16T11:09:38.937Z` |
| Persistence | mongo · durable · hydrated |
| football-data.org | configured |
| API-Football | not configured |
| Kickoff | 30 CONFIRMED / 350 DEFAULT / 0 conflicts |
| Jobs | 120 PENDING / 1400 CANCELLED (historical date-only misfire; not deleted) |
| LIVE_OOS | 380 total · settled 0 · PRESEASON 365 / EARLY 15 / timed 0 |
| Tape lines | 380 |
| Tape MD5 | `34f7ca54025a3a48df9f1a169df66315` |
| Tape SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` |
| Local scheduler processes | none |
| Vercel cron | daily `0 4 * * *` keep-alive only (Hobby) |
| Git remote | none |

---

## Architecture decisions

### Settlement: read-through composite, do not copy the tape

Production routing sets `SNAPSHOT_STORE_PATH` to the durable workdir, so `listSnapshots()` no longer auto-includes the committed tape. `/live` already unions `loadCommittedLiveOos()` + operational archive. `settleFixture()` did not.

Phase 2A.4 introduces `LiveSnapshotReader`:

```
FrozenBaseSnapshotStore   = data/processed/premier-league/live-oos-2026-27.jsonl
OperationalSnapshotStore  = ops/live-oos-operational.jsonl + working-snapshots.jsonl
```

Canonical identity remains the audited 6-part key via `canonicalSnapshotIdentity` / `snapshotUniqueKey`:

```
competition :: season :: fixtureId :: modelVersion :: predictionStage :: asOf
```

Dedup is first-seen with the frozen tape winning on collision. The 380 rows are never imported into Mongo.

### Scheduler: hosted HTTPS pinger, not a laptop worker

Vercel Hobby cannot honor `*/5`. The existing `scripts/ops-scheduler-worker.ts` is a laptop process.

Chosen class: **C — reliable external scheduler invoking `/api/ops/tick`**.

Provider: **GitHub Actions** on a dedicated private repository (`football-oracle-ops-scheduler`), cadence `*/5 * * * *`, `Authorization: Bearer $CRON_SECRET`. Recurrence and retry are provider-managed. Overlap is still serialized by the existing 90-second Mongo lease.

Forbidden as production scheduler: local terminal, launchd, `npm run ops:worker`, tmux/screen.

### Out of scope

- Phase 2B0 market odds / CLV / Kalshi
- Model parameter changes (HA 72, ρ −0.061, shrink 0.75, Championship gap −120)
- Deleting the 1400 CANCELLED historical jobs
- Making API-Football required
- Rewriting Mongo persistence before MW1

---

## Work log

### Composite settlement reader

- Added `lib/competitions/premier-league/ops/live-snapshot-reader.ts`.
- `listLiveSnapshots()` unions frozen tape + operational archive + working store, deduped by the audited 6-part identity. Tape wins on collision.
- `liveSnapshotUniverse()` is the `/live` / health headline view: tape + operational archive only (so working-store test rows cannot inflate the 380).
- `settleFixture()` now enumerates via `listLiveSnapshots()`, not `listSnapshots()`.
- Settlements remain a separate JSONL/Mongo record. Optional `verificationId` is stored on the settlement row only.
- Isolated `/tmp` VERIFIED_FINAL: Arsenal–Coventry frozen EARLY + synthetic PRESEASON + four timed stages → 6 settlements, replay/restart still 6, tape bytes unchanged.
- `scripts/test-phase2a-4.ts`: **62/62**.
- Prior suites: 2A 56/56, 2A.1 45/45, 2A.2 104/104, 2A.3 15/15.

### Hosted scheduler

Inspected: Vercel Hobby daily cron only; no laptop worker; no Render/Fly/Railway; Grok automations cannot do 5 minutes.

Deployed **GitHub Actions** on `https://github.com/bobaoxu2001/football-oracle-ops-scheduler` (public, so Actions minutes are not capped):

- `*/5 * * * *` one-shot pinger
- hourly supervised loop (`2 * * * *`) that ticks every 5 minutes and is restarted by GitHub
- `Authorization: Bearer $CRON_SECRET`
- Mongo 90s lease unchanged

Auth/lease against production (before observation): missing secret 401, wrong secret 401, overlap 200 + 409.

Automatic ticks observed **without** curling `/api/ops/tick`:

| n | lastTickAt |
| --- | --- |
| 1 | 2026-08-16T14:11:53.831Z |
| 2 | 2026-08-16T14:16:56.192Z |
| 3 | 2026-08-16T14:21:59.025Z |
| 4 | 2026-08-16T14:27:00.879Z |

A GitHub `schedule` run (`31952056118`) also queued at 14:12:57Z, proving provider-managed recurrence. No local scheduler process.

### Safety / regression

- 1400 CANCELLED jobs left in place; `/health` now exposes `activeJobs` = PENDING+ELIGIBLE+RUNNING.
- API-Football left optional.
- `scripts/export-ops-bundle.ts` + `docs/OPS_BACKUP_AND_RESTORE.md`.
- World Cup gates green (routing 73, track 24, calibration 12, tournament 52, ratings, honesty, DC selftest, bracket top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4).
- Tape hashes unchanged before and after.

### Commits / deploy

| Item | Value |
| --- | --- |
| Start | `1dab4715126410c2dd78e9fc71a8477df5214e22` |
| Settlement + first scheduler commit | `c5f7bbba8a3da3d9faba297410f7e5f7ea421902` |
| Supervised-loop workflow | `814650ddbcf032a9523963bfb64de2d52fdeeadf` |
| Production deployment | `dpl_8me2vnYixw8CiFkVawvD1uFnC17r` |
