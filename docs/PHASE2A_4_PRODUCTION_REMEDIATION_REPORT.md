# Phase 2A.4 production remediation report — Football Oracle

**Date:** 2026-08-16

---

# 1. Verdict

**PASS WITH LIMITATIONS**

Both production blockers from the 2A.3 deployment audit are remediations, not remaining failures:

1. Settlement now enumerates the frozen 380-row tape **and** operational timed snapshots, without copying or mutating the tape.
2. A hosted GitHub Actions scheduler is ticking production every ~5 minutes independently of any developer laptop.

Limitations are operational, not evidence-integrity: GitHub cron can jitter; the first real T24H window has not occurred yet; API-Football is still optional; 1400 historical CANCELLED jobs remain as auditable noise.

---

# 2. Source State

| Item | Value |
| --- | --- |
| Start commit | `1dab4715126410c2dd78e9fc71a8477df5214e22` |
| End commit | `814650ddbcf032a9523963bfb64de2d52fdeeadf` |
| Settlement implementation | `c5f7bbba8a3da3d9faba297410f7e5f7ea421902` |
| Production deployment | `dpl_8me2vnYixw8CiFkVawvD1uFnC17r` |
| Production URL | https://football-oracle-agent.vercel.app |
| Deployment created | 2026-08-16T13:54:56Z · Ready · iad1 |

---

# 3. Settlement Surface Fix

Production routing still hydrates Mongo into `/tmp` and sets `SNAPSHOT_STORE_PATH` to the workdir, so `listSnapshots()` cannot see the committed tape. That is unchanged and correct — the tape must not be a write target.

`settleFixture()` no longer calls `listSnapshots()`. It calls `listLiveSnapshots()`, a read-through union of:

```
FrozenBaseSnapshotStore   = data/processed/premier-league/live-oos-2026-27.jsonl
OperationalSnapshotStore  = ops/live-oos-operational.jsonl + working-snapshots.jsonl
```

The 380 rows are never imported into Mongo. Settlements persist as separate first-write-wins records (`snapshotUniqueKey` + actuals + metrics + optional `verificationId`).

---

# 4. Composite Snapshot Enumeration

Canonical identity is the audited 6-part key via the shared `canonicalSnapshotIdentity` / `snapshotUniqueKey` helper:

```
competition :: season :: fixtureId :: modelVersion :: predictionStage :: asOf
```

Dedup: frozen tape wins, then operational archive, then working store.

`liveSnapshotUniverse()` (used by `/live` and `/health`) unions **tape + operational archive only**, so the user-facing headline stays:

```
380 total · settled 0 · PRESEASON 365 · EARLY 15 · timed 0
```

and cannot jump to 760.

Production-like isolated check (`SNAPSHOT_STORE_PATH` set, empty working store):

| Surface | Count |
| --- | --- |
| `listSnapshots()` | 0 (tape hidden, as in production routing) |
| composite LIVE_OOS | **380** |
| operational | **0** |

Copying one tape row into the operational archive still yields composite **380**.

---

# 5. Settlement Test

Isolated `/tmp` storage only. No production result was fabricated.

Fixture: `pl-2026-27-arsenal-coventry` (real frozen EARLY tape row) plus isolated operational PRESEASON / T24H / T2H / T60M / FINAL_PREKICK.

| Check | Result |
| --- | --- |
| Canonical snapshots | 6 |
| Settlements after VERIFIED_FINAL | 6 |
| Frozen EARLY settled | yes |
| Operational timed stages settled | yes |
| Replay | same 6 identities, original `settledAt` kept |
| Restart (cache wipe) | still 6, 0 extras |
| Base EARLY probabilities | byte-stable |
| Tape row not copied into working store | yes |
| Rating apply | once; replay/restart skipped |
| `/live` stage rows | PRESEASON/EARLY/T24H/T2H/T60M/FINAL_PREKICK each N settled = 1 |
| Test state removed | composite returned to 380 / 0 |

Suite: `npm run test:phase2a-4` → **62/62**.

---

# 6. Scheduler Architecture

Inspected infrastructure: Vercel Hobby (daily cron only), no laptop worker, no Render/Fly/Railway CLI, Grok automations cannot honor 5 minutes.

Chosen class: **C — hosted external scheduler invoking `/api/ops/tick`**, with an hourly supervised loop as restart.

```
GitHub Actions (*/5 + hourly loop)
        ↓ Authorization: Bearer CRON_SECRET
Vercel /api/ops/tick
        ↓ 90s Mongo lease
fixture sync → jobs → results → settlement → ratings → health
```

The application stays on Vercel + Mongo. Only the timer moved off the laptop.

---

# 7. Scheduler Deployment

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repo | https://github.com/bobaoxu2001/football-oracle-ops-scheduler (public) |
| Workflow | `.github/workflows/ops-tick.yml` |
| Cadence | 5 minutes |
| Auth | `CRON_SECRET` (repo secret; never logged) |
| Recurrence | GitHub `schedule` + in-loop sleep + hourly restart |
| Observation | Actions run history (`at=… status=… failure_state=…`) |
| Vercel keep-alive | still `0 4 * * *` (not the operational timer) |

Public visibility is required so the 5-minute cadence does not exhaust private Actions minutes.

---

# 8. Autonomous Tick Evidence

Observation window started after the last **manual** lease-test tick (`2026-08-16T13:54:08.224Z`). `/api/ops/tick` was **not** curled during observation. Health was polled read-only.

| n | `lastTickAt` | Δ | `/health` |
| --- | --- | --- | --- |
| 1 | 2026-08-16T14:11:53.831Z | — | HEALTHY · fresh · T24H=0 |
| 2 | 2026-08-16T14:16:56.192Z | 5m 02s | HEALTHY · fresh · T24H=0 |
| 3 | 2026-08-16T14:21:59.025Z | 5m 03s | HEALTHY · fresh · T24H=0 |
| 4 | 2026-08-16T14:27:00.879Z | 5m 02s | HEALTHY · fresh · T24H=0 |

Hosted run: https://github.com/bobaoxu2001/football-oracle-ops-scheduler/actions/runs/31951995706

A separate GitHub `schedule` run (`31952056118`) queued at 14:12:57Z — provider-managed recurrence is live.

Between 14:09Z and 14:11Z, `/health` correctly flipped to **DEGRADED** (`ops tick stale`) after the manual tick aged out, then returned to **HEALTHY** only after the hosted worker fired. Health was not forced.

---

# 9. Laptop Independence

| Check | Result |
| --- | --- |
| Local `ops-scheduler-worker` / `ops:worker` / launchd / crontab | none |
| Ticks continued after deploy machine was only polling `/api/health` | yes |
| Host | GitHub-hosted `ubuntu-latest` runner |

Closing every developer laptop does not stop the GitHub schedule or the in-flight hourly loop.

---

# 10. Authentication / Lease

Production `/api/ops/tick` (values not logged):

| Request | Result |
| --- | --- |
| no credential | 401 `missing secret` |
| wrong credential | 401 `invalid secret` |
| two overlapping valid Bearers | **200** (tick 10) + **409** skipped |

90-second Mongo lease (`pl_ops_locks`) is unchanged.

---

# 11. Production Health

Measured after tick 4 on `dpl_8me2vnYixw8CiFkVawvD1uFnC17r`:

| Field | Value |
| --- | --- |
| Overall | **HEALTHY** |
| Reasons | data ready, live source configured, durable store and scheduler not blocked |
| DATA_READY | yes |
| Last tick | 2026-08-16T14:27:00.879Z · fresh |
| Scheduler host | `github-actions` |
| Mongo | durable · hydrated |
| football-data.org | configured |
| API-Football | not configured |
| Conflicts | 0 |
| Active jobs | 120 (PENDING) |
| Cancelled | 1400 (historical; not active) |

---

# 12. Next Genuine Prediction Job

Recomputed from current production fixture state:

```
fixture:  pl-2026-27-arsenal-coventry
          Arsenal vs Coventry City
stage:    T24H
kickoff:  2026-08-21T19:00:00.000Z   (CONFIRMED)
eligibleFrom:  2026-08-20T17:00:00.000Z
target:        2026-08-20T19:00:00.000Z
eligibleUntil: 2026-08-20T21:00:00.000Z
status:   PENDING
```

No T24H was pre-frozen. Production stage counts remain PRESEASON 365 / EARLY 15 / timed 0.

**Next live observation checkpoint:** when that T24H window opens, the scheduler should freeze exactly one operational snapshot. Do not backfill if missed.

---

# 13. Trusted Tape

| | Required | Start | End |
| --- | --- | --- | --- |
| Lines | 380 | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match | match |

**Byte-identical: YES.**

Model parameters untouched: `pl-live-v0.2.0`, HA = 72, ρ = −0.061 (`dcRho`), shrink = 0.75, Championship gap = −120.

---

# 14. World Cup Regression

| Suite | Result |
| --- | --- |
| `tsc --noEmit` | pass |
| routing | 73/73 |
| track | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| ratings | pass |
| honesty | pass |
| `dc:selftest` | pass |
| bracket | all checks pass; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 (unchanged) |
| Phase 2A / 2A.1 / 2A.2 / 2A.3 / 2A.4 | 56 / 45 / 104 / 15 / 62 |

---

# 15. Remaining Limitations

1. GitHub Actions scheduled events can be delayed under load. A new-repo `*/5` cron lagged ~18 minutes until the first workflow existed; the hourly loop is the supervised restart. Jitter of a few minutes is possible.
2. The first genuine T24H (Arsenal–Coventry, eligible 2026-08-20T17:00Z) has not happened yet. That remains the strongest live proof.
3. `API_FOOTBALL_KEY` is still unset. football-data.org is the declared trusted source and is working.
4. 1400 CANCELLED jobs from the 2A.3 date-only misfire are preserved as historical ops noise. `activeJobs` excludes them.
5. Atlas free-tier has no PITR. `npm run ops:export-bundle` plus `docs/OPS_BACKUP_AND_RESTORE.md` is the lightweight path.
6. This application repo still has no git remote; production is a Vercel CLI deploy. The scheduler lives in a dedicated GitHub repo.
7. Phase 2B0 (odds / CLV / Kalshi) was not started.

---

# 16. Phase 2B0 Readiness

```text
READY FOR FINAL TARGETED VERIFICATION
```

Do **not** implement Phase 2B0 until this remediation is independently verified. The acceptance question for 2A.4:

> If every developer closes their laptop now, will Football Oracle continue ticking autonomously, and after the first real match finishes, will it settle BOTH the original frozen PRESEASON/EARLY forecast and all later timed forecasts without touching historical prediction bytes?

**Ticking:** yes — the hosted scheduler is running and `/health` is HEALTHY from those ticks.  
**Settlement:** yes, at the code/isolation-test level — the composite reader settles tape + operational rows exactly once. The first real VERIFIED_FINAL will be the production confirmation.
