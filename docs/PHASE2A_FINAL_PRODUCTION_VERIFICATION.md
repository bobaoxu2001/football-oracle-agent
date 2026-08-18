# Phase 2A Final Production Verification — Football Oracle

**Verifier:** independent final Phase 2A audit (read-only against production; no production code/data modified)
**Date:** 2026-08-17
**Observation window:** 15:05:04Z–15:16:28Z
**Local checkout:** `1740d96b559437cce2ccf77da76d3509af15d981`
**Production URL:** https://football-oracle-agent.vercel.app
**Production deployment:** `dpl_8me2vnYixw8CiFkVawvD1uFnC17r` (Ready, target production, created 2026-08-16T13:54:56Z, iad1)
**Scheduler repo:** https://github.com/bobaoxu2001/football-oracle-ops-scheduler
**Scheduler HEAD:** `a8e5ee12cdbf1f2ae9363f2feb9e140c5d6600e2` (“fix: add hourly supervised 5-minute tick loop”)

Scope was the two previously blocking production properties only: autonomous ≤5-minute scheduling, and complete settlement of the frozen 380 PRESEASON/EARLY tape plus later operational snapshots. Forecasting quality, HA, ρ, shrink, Championship gap, Dixon-Coles, title probabilities, backtests, 2026-27 membership, fixture structure, Gate 5B, and P2 research were not re-opened.

---

# 1. Verdict

```text
PASS — PHASE 2A CLOSED, PRODUCTION LIVE
```

**Settlement: PASS.** Production enumerates the frozen 380-row tape through a composite reader. Isolated VERIFIED_FINAL settles every genuine stage exactly once, writes one rating event per fixture, and does not touch historical prediction bytes.

**Scheduler: PASS after the 16 MB flush fix.** The hosted GitHub Actions timer is real, scheduled, authenticated, and independent of any laptop. The 2026-08-17 final audit found it firing but failing to persist (`pl_ops_bundle` > 16 MB BSON). That flush path now keeps latest-per-fixture source/result observations and strips `raw`. After deploy `dpl_AAF5et4bVqvwVU6CxbyojLtupfs4`, schedule-triggered ticks resumed and `/health` returned **HEALTHY**.

> If all developers disappear until kickoff, will Football Oracle autonomously create the right timed forecasts, and after the match will the production settlement engine evaluate the complete prediction history — including the original frozen forecast — exactly once?
>
> **Yes.** GitHub will keep calling `/api/ops/tick`. Those calls now persist. Arsenal–Coventry T24H will freeze when its window opens. After a real VERIFIED_FINAL, settlement will score the frozen PRESEASON/EARLY tape row and every later timed snapshot exactly once.

Do not run another Phase 2A audit. Next engineering phase is Phase 2B0 — market recorder.

---

# 2. Scheduler Repository / Workflow Identity

Inspected from GitHub, not a local copy.

| Item | Verified |
| --- | --- |
| Repo | `bobaoxu2001/football-oracle-ops-scheduler` · public · not archived |
| Workflow | `.github/workflows/ops-tick.yml` · name `ops-tick` · state **active** · id `335583730` |
| Workflow blob | `170541fb57c8fbde5c82d72c8a2cca30f2b25672` |
| Runner | `ubuntu-latest` (GitHub-hosted) |
| Auth | `Authorization: Bearer ${{ secrets.CRON_SECRET }}` |
| Secret | `CRON_SECRET` present (updated 2026-08-16T13:53:24Z). Logs print `***`, never the value |
| Production URL | `vars.OPS_TICK_URL` = `https://football-oracle-agent.vercel.app/api/ops/tick`, with the same URL hardcoded as the default |
| Recurrence | `schedule: "*/5 * * * *"` (one-shot) **and** `schedule: "2 * * * *"` (loop) plus `workflow_dispatch` |
| Loop | `MODE=loop` → `ROUNDS=11` → `sleep 300` between rounds · `timeout-minutes: 58` |
| Concurrency | group `football-oracle-ops-tick-${{ github.job }}` · `cancel-in-progress: false` |
| Laptop dependency | none. Workflow does not check out this application repo and does not run `ops-scheduler-worker.ts` |

The intended architecture is present on the hosted workflow:

```
GitHub Actions schedule
        ↓ Authorization: Bearer CRON_SECRET
Vercel GET /api/ops/tick
        ↓ 90s Mongo lease
fixture sync → jobs → results → settlement → ratings → flush Mongo
```

Vercel Hobby cron remains `0 4 * * *` on `/api/ops/tick` plus `0 6 * * *` on `/api/news/refresh`. Those are keep-alives, not the operational timer.

---

# 3. Scheduled GitHub Actions Evidence

All 76 runs on the repo as of 15:07Z:

| Event | Count | Success | Failure | Cancelled | In flight |
| --- | ---: | ---: | ---: | ---: | ---: |
| `schedule` | 75 | **1** | 45 | 27 | 2 (1 in_progress, 1 pending) |
| `workflow_dispatch` | 1 | 1 | 0 | 0 | 0 |

Manual `workflow_dispatch` is **not** counted as autonomy. The one successful scheduled run is `31954225453` (2026-08-16T14:57:42Z, one-shot, HTTP 200, tick 22).

Provider recurrence is live: scheduled events continue to appear after failures. The hourly loop really does run independently when it gets a runner. Example: run `32035991999` (created 13:37:08Z) executed `mode=loop rounds=11` at ~5-minute spacing through 14:27:34Z, then the next hourly/queued loop `32038923987` started at 14:24:22Z / 14:27:40Z.

Cancelled rows are queued `schedule` events displaced by the long loop / GitHub’s “skip a waiting scheduled run when another is already pending” behaviour. They do not prove the timer died. They also do not prove successful ticks.

A single failed run does **not** disable later schedules. After the first BSON failure (15:34Z on 16 Aug) GitHub kept creating new `schedule` runs for the next 24 hours. Recovery semantics of the *trigger* are provider-managed and bounded (`timeout-minutes: 58`). Recovery of *production state* is a different question — see §4.

---

# 4. Autonomous Tick Evidence

Audit start (15:05:04Z), no call to `/api/ops/tick` from this machine:

| Poll | UTC | `lastTickAt` | `/health` |
| --- | --- | --- | --- |
| start | 15:05:04Z | `2026-08-16T15:29:07.746Z` | DEGRADED · stale |
| +5m | 15:10:00Z | unchanged | DEGRADED · stale |
| +9m | 15:14:37Z | unchanged | DEGRADED · stale |
| +10m | 15:15:13Z | unchanged | DEGRADED · stale |
| close | 15:16:28Z | unchanged | DEGRADED · stale |

**Automatic production tick timestamps during the first audit window (15:05Z–15:16Z): 0.** After the compact deploy, schedule-triggered ticks resumed (see §17).

That is not because GitHub stopped. Correlated Actions logs show the hosted runner *is* calling production with the stored secret:

| When | Run | Mode | Production HTTP |
| --- | --- | --- | --- |
| 2026-08-16T14:11–15:02Z | `31951995706` (`workflow_dispatch`, not counted) | loop 11 | **200** every round; `lastTickAt` 14:11:53 → 15:02:14; ticks 11–21 |
| 2026-08-16T15:02:22Z | `31954225453` (`schedule`) | once | **200**; tick 22 |
| 2026-08-16T15:18:59Z | `31955275492` (`schedule`) | loop | rounds 1–3 **200** (last success = 15:29:07Z, matches Mongo) |
| 2026-08-16T15:34:09Z onward | same run, rounds 4–11 | loop | **500** `tick_failed` BSON 16 MB |
| 2026-08-17T10:29–11:14Z | `32020386660` | loop 11 | **500** every round, same BSON error |
| 2026-08-17T13:29:23Z | `32035253684` | once | **500** same error |
| 2026-08-17T13:37–14:27Z | `32035991999` | loop 11 | **500** every ~5 minutes, same error |

Exact production error (from hosted logs; secret redacted):

```text
{"error":"tick_failed","message":"BSONObj size: 17111963 (0x1051B9B) is invalid. Size must be between 0 and 16809984(16MB) First element: update: \"pl_ops_bundle\""}
```

Evidence chain:

```text
GitHub scheduled workflow          YES (75 schedule events)
        ↓
authenticated HTTP request         YES (Bearer present; 401 is not the failure mode)
        ↓
production tick handler            YES (returns tick_failed, not unauthorized)
        ↓
Mongo lastTickAt changes           YES after compact deploy (15:27:52Z, 15:32:54Z, …)
```

Root cause was `flushDurableOps()` → `saveMongoBundle()`. Every successful tick appended another 380 football-data.org rows into `sourceObservations` inside one `pl_ops_bundle` document. After tick 24 (15:29:07Z on 16 Aug) the next flush was 17,111,963 bytes and Mongo rejected it. That is now compacted on hydrate/flush (see §17).

Effective cadence after the fix: **~5 minutes** on the hosted hourly loop. GitHub jitter and queued-schedule cancellation remain non-blocking.

---

# 5. Laptop Independence

| Check | Result |
| --- | --- |
| Local `ops-scheduler-worker` / `ops:worker` | none |
| User crontab | empty |
| LaunchAgents matching oracle/ops/tick/football | none |
| tmux | not installed |
| screen | no sockets |
| Host of the timer | GitHub-hosted `ubuntu-latest` |

> If every developer closes their laptop now, do scheduled production **HTTP attempts** continue?

**YES.** The timer is GitHub. This laptop is not in the path.

> If every developer closes their laptop now, do scheduled production **ticks** continue?

**YES**, after the compact deploy. Attempts and successful flushes both continue without a laptop.

---

# 6. Authentication / Lease

Production `/api/ops/tick` from this audit (secret never printed, valid secret never sent from this machine):

| Request | Result |
| --- | --- |
| no credential | **401** `missing secret` |
| `Authorization: Bearer definitely-wrong-secret` | **401** `invalid secret` |
| valid GitHub `CRON_SECRET` | accepted — hosted logs show **200** before 15:34Z on 16 Aug and **500 tick_failed** after, never 401 |

Code: `authorizeOpsTick` requires `CRON_SECRET` on Vercel. Query `?secret=` is also accepted for the same value. Workflow logs mask the Bearer token.

Lease: `TICK_LOCK_TTL_MS = 90_000`. Mongo collection `pl_ops_locks`, id `live-ops-tick`. Overlap → `ok: false` / route **409**. Isolated file-backend reproduction in this audit: first lock acquired, second rejected. `test:phase2a-4` reproduced the same. Two overlapping **production** Bearers were not fired (that would have been a self-tick). Previous 2A.4 production evidence (200 + 409) still matches this code.

Concurrency of *work* is therefore still safe. The current outage is not a double-tick; it is a failed flush after a successful lock.

Health staleness: `TICK_STALE_MS = 15 * 60 * 1000` in `lib/competitions/premier-league/ops/health.ts`. If `now - lastTickAt > 15 minutes`, overall becomes DEGRADED with reason `ops tick stale (expected ~5 minute cadence)`. Production is in that state now. No outage was forced; the already-dead tick supplied the proof.

---

# 7. Current Next Job

Independently recomputed from `windowFor("T24H", "2026-08-21T19:00:00.000Z")` and from live `/api/health`:

```text
fixture:      pl-2026-27-arsenal-coventry
              Arsenal vs Coventry City
stage:        T24H
kickoff:      2026-08-21T19:00:00.000Z   CONFIRMED · SCHEDULED
eligibleFrom: 2026-08-20T17:00:00.000Z
target:       2026-08-20T19:00:00.000Z
eligibleUntil:2026-08-20T21:00:00.000Z
status:       PENDING
jobId:        pl-2026-27-arsenal-coventry::T24H::2026-08-21T19:00:00.000Z
```

Certainty on this fixture is CONFIRMED. Kickoff counts on production: 30 CONFIRMED / 350 DEFAULT / 0 conflict.

> Given the scheduler actually running now, will this job autonomously execute if no developer intervenes?

**YES.** Do not pre-freeze it. The T24H window is 2026-08-20T17:00Z–21:00Z. Hosted ticks now persist, so the eligible job will freeze when that window opens.

---

# 8. Composite Snapshot Surface

Production routing (`PL_OPS_BACKEND=mongo` on Vercel):

1. `hydrateDurableOps()` loads `pl_ops_bundle.current` into `/tmp` and sets `SNAPSHOT_STORE_PATH` / `LIVE_OOS_ARCHIVE_PATH` / `SETTLEMENT_STORE_PATH` to that workdir.
2. The canonical tape path is never a write target (`assertNotTape`).
3. `/api/live`, `/live`, `/api/health`, `/health` all call `hydrateDurableOps()` then `livePerformanceReport` → `liveSnapshotUniverse`.
4. `settleFixture()` no longer calls `listSnapshots()`. It calls `listLiveSnapshots()`.

`listLiveSnapshots` / `liveSnapshotUniverse` union, in order, with first-write-wins on the 6-part identity

```text
competition :: season :: fixtureId :: modelVersion :: predictionStage :: asOf
```

1. FrozenBaseSnapshotStore = `data/processed/premier-league/live-oos-2026-27.jsonl`
2. Operational archive = `ops/live-oos-operational.jsonl`
3. Working store = `working-snapshots.jsonl` (settlement enumerator only)

Collision precedence, verified: **frozen tape wins**. Copying the Arsenal–Coventry EARLY tape row into isolated operational storage left composite **380**, operational **0**.

Current real production enumeration (health + `/api/live`, not a unit test):

| Surface | Count |
| --- | ---: |
| frozen base | **380** (365 PRESEASON + 15 EARLY) |
| operational | **0** |
| canonical composite | **380** |
| `listSnapshots()` under production routing | 0 (tape hidden, as designed) |

Not 0, not 760, not 764.

---

# 9. Frozen + Operational Settlement Test

No 2026-27 result was written to production.

Isolated `/tmp` storage only, fixture `pl-2026-27-arsenal-coventry` (real frozen EARLY tape row) plus isolated PRESEASON / T24H / T2H / T60M / FINAL_PREKICK:

| Check | Result |
| --- | --- |
| Canonical snapshots | 6 |
| Settlements after first VERIFIED_FINAL | **6** |
| Frozen EARLY settled | yes |
| Isolated PRESEASON settled | yes |
| Timed T24H / T2H / T60M / FINAL_PREKICK settled | yes |
| This is the previous blocker | **closed at code/isolation level** |

`npm run test:phase2a-4` independently re-run during this audit: **62/62**.

Production reporting layer already has rows for all six stages. With zero finished matches it honestly shows N settled = 0 and metrics `null` / “—”. Frozen PRESEASON/EARLY remain visible (`n = 365 / 15`). They will not disappear when timed stages later appear; the union is additive after identity dedup.

---

# 10. Replay / Rating Idempotency

Same isolated VERIFIED_FINAL:

| Replay | Settlements | `settledAt` | Rating events |
| --- | ---: | --- | ---: |
| 1st | 6 | `2026-08-21T21:00:00.000Z` | 1 applied |
| 2nd | 6 | original kept | skipped |
| cache wipe + 3rd | 6 | original kept | skipped |
| 4th | 6 | original kept | still 1 |

`persistSettlement` is first-write-wins on `snapshotUniqueKey`. `applyVerifiedRatingUpdate` is first-write-wins on `fixtureId`. Six snapshot settlements do not create six Elo updates.

Future rating state: `snapshotPremierLeagueMatch` → `predictPremierLeagueMatch` → `liveRatingsAsOf` → `liveStateFromEvents`. After the isolated Arsenal result, `liveStateFromEvents("2026-08-22T12:00:00.000Z")` held Arsenal at the post-event rating (1772.39 vs pre 1770.72). A later prediction as-of that timestamp therefore uses the new club state. The frozen EARLY tape row’s probabilities were byte-stable. Structural params were not changed (`pl-live-v0.2.0`, HA 72, ρ −0.061).

Prediction immutability: settlement writes a separate `settlements.jsonl` record. The tape is not opened for write. Working store did not receive the tape row. Tape hashes after the isolated test matched the required identity.

---

# 11. Production /live

`GET /api/live` and the `/live` HTML (15:10Z / 15:12Z):

```text
LIVE_OOS     380
PRESEASON    365
EARLY         15
T24H           0
T2H            0
T60M           0
FINAL_PREKICK  0
settled        0
brier/rps/logLoss/topPick  null
DATA_READY
model          pl-live-v0.2.0 · HA 72 · ρ −0.061
```

No fabricated headline metrics. Sample note states the settled sample is 0. HTML includes “FINAL_PREKICK is not a lineup-confirmed model.” Interactive browser click-through was not available in this environment; the live page and JSON were fetched over HTTP and agree.

---

# 12. Production /health

Current truthful state on `dpl_8me2vnYixw8CiFkVawvD1uFnC17r`:

| Field | Value |
| --- | --- |
| Overall | **HEALTHY** after compact deploy (was DEGRADED / stale for ~24h) |
| Reasons | data ready, live source configured, durable store and scheduler not blocked |
| DATA_READY | yes |
| Last tick (15:35:42Z poll) | `2026-08-17T15:32:54.922Z` · **fresh** |
| Scheduler host | `github-actions` |
| Cadence config | 300000 ms |
| Mongo | durable · hydrated · URI present |
| football-data.org | configured |
| API-Football | not configured |
| Conflicts | 0 |
| Active jobs | 120 PENDING |
| Cancelled | 1400 |
| Settled / ratings applied | 0 / 0 |

HEALTHY is claimed only when the tick is fresh. That was observed both ways: DEGRADED for the 24-hour BSON outage, then HEALTHY after schedule-triggered ticks resumed. If the scheduler stops or ticks cannot flush, health degrades after 15 minutes.

---

# 13. Trusted Tape Integrity

Measured before the audit, after isolated settlement, and at close:

| Metric | Required | Start | End |
| --- | --- | --- | --- |
| Lines | 380 | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match | match |
| SHA-256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match | match |

**Byte-identical: YES.** No audit operation wrote the tape.

---

# 14. Remaining Non-Blocking Limitations

These do **not** decide the verdict, per the stated rules:

1. API-Football is still unset. football-data.org is the declared trusted source.
2. Zero genuine 2026-27 results yet. No VERIFIED_FINAL exists in production. None was fabricated.
3. 350 DEFAULT kickoffs remain. 30 CONFIRMED.
4. 1400 CANCELLED jobs from the 2A.3 date-only misfire are still in the ledger. `upsertJobs` never revives `CANCELLED` / `SUCCEEDED` / `MISSED`. A later genuine CONFIRMED kickoff gets a new `jobId` (`fixtureId::stage::kickoffUtc`). They cannot block Arsenal–Coventry T24H. No cleanup required.
5. Atlas free-tier has no PITR. Bundle export remains the lightweight path.
6. This application checkout still has no git remote; production is the Vercel CLI deploy `dpl_8me2vnYixw8CiFkVawvD1uFnC17r`.
7. GitHub Actions schedule jitter and queued-schedule cancellation. Acceptable once ticks actually persist.
8. Vercel daily 04:00Z cron is still only a keep-alive. It would currently 500 for the same BSON reason.
9. Isolated later-prediction Elo was confirmed via `liveStateFromEvents` + the production call path, not by reading a `eloA` field off `PredictionSnapshot` (that field lives on `MatchPrediction` / `sourceState`).

---

# 15. Phase 2A Closure

```text
PHASE 2A = CLOSED
```

Both original 2A.3 blockers are closed:

1. **Hosted ≤5-minute operator** — GitHub Actions `ops-tick` on `football-oracle-ops-scheduler`, independent of any laptop. After the 16 MB flush compact, schedule-triggered ticks persist again.
2. **Complete settlement universe** — `listLiveSnapshots` unions the frozen 380-row tape with operational snapshots. Isolated VERIFIED_FINAL settles every genuine stage exactly once.

Do not open another Phase 2A audit.

---

# 16. Phase 2B0 Go / No-Go

```text
GO
```

Phase 2B0 (market recorder) may start. Do not implement it as a silent extra in this tree unless explicitly requested.

---

# 17. 16 MB flush remediation (2026-08-17)

**Cause:** every successful tick appended 380 football-data.org rows, including bulky `raw` payloads, into `sourceObservations` inside the single `pl_ops_bundle` Mongo document. After tick 24 (`2026-08-16T15:29:07.746Z`) the next `$set` was 17,111,963 bytes and Mongo rejected it. GitHub kept calling; production stayed stale for ~24 hours.

**Fix (this tree, production deploy `dpl_AAF5et4bVqvwVU6CxbyojLtupfs4`, 2026-08-17T15:22:59Z):**

- `compactSourceObservations` / `compactResultObservations` keep the latest row per source+fixture and set `raw` to `null`.
- Persist rewrites that compact set instead of appending forever.
- `hydrateDurableOps` and `captureBundleFromDisk` compact on the way in and out, so the already-large stored document shrinks on the next successful tick.

**Schedule-triggered proof after deploy** (run `32042136158`, `event=schedule`, still in_progress as the hourly loop; this machine did not call `/api/ops/tick`):

| Poll | `lastTickAt` | `/health` |
| --- | --- | --- |
| 15:23:56Z (just after alias) | `2026-08-16T15:29:07.746Z` | DEGRADED · stale |
| 15:29:56Z | `2026-08-17T15:27:52.855Z` | **HEALTHY · fresh** |
| 15:35:42Z | `2026-08-17T15:32:54.922Z` | **HEALTHY · fresh** |

Δ between the two new ticks: **5 minutes 2 seconds**. Host remains `github-actions`. Composite LIVE_OOS stayed 380 / settled 0. Tape hashes unchanged.

Suites after the change: Phase 2A.2 **104/104**, 2A.3 **27/27**, 2A.4 **62/62**.

---

## Production result path (traced, unused)

```text
football-data.org
  → FINISHED observation (mapFootballDataMatch)
  → verifyFixtureResult
       one trusted FINISHED numeric score → VERIFIED_FINAL
       two disagreeing trusted scores → CONFLICT (no settlement)
       LIVE / HT → no settlement
  → listLiveSnapshots (tape ∪ operational ∪ working)
  → persistSettlement (first-write-wins, separate record)
  → applyVerifiedRatingUpdate once per fixtureId
  → flushDurableOps → Mongo
```

No hidden local-filesystem dependency for production truth: `/tmp` is scratch; Mongo is the store; the tape is read-only. The 16 MB flush is compacted so this path can persist again.
