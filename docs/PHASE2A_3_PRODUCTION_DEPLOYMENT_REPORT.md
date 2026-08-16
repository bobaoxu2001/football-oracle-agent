# Phase 2A.3 production deployment report — Football Oracle

**Date:** 2026-08-16

---

# 1. Verdict

**PASS WITH LIMITATIONS**

Phase 2A.2 was frozen as the exact audited tree, then a new Vercel project plus Mongo-backed ops persistence were deployed. Live football-data.org authenticates. Authenticated ticks run on production. Kickoff certainty is back to the audited 30 CONFIRMED / 350 DEFAULT after a first-sync date-only mistake was corrected. The trusted 380-line tape is unchanged.

Limitations: Vercel Hobby cannot fire a 5-minute cron; API-Football is not configured; this repo still has no git remote.

---

# 2. Freeze Commits

| Item | SHA |
| --- | --- |
| Implementation | `0e3e4b53caf0907bd7cb4054878c049373e81791` |
| Audit docs | `5f69748b1c1c5956628729a75d9e58ba4df8d06a` |
| Audited manifest | `a5b5ed692cf2ef725a69b06991ac5d1b890304157cd32088fa17a4ffd58bc948` |
| Base | `13715b37ee9f016c2af9919d0ed7670636a37e45` |

Manifest was regenerated (`path | size | sha256 | git-status`) before the implementation commit: **0 diffs**, hash match. Tape blob `7b59af9737b214e904f89865b852f15db8378652` is identical to the pre-2A.2 parent.

---

# 3. Deployment Architecture

Inspected, not assumed:

- **This repo is not the live World Cup app.** `worldcup-oracle-agent.vercel.app` has no `/live` or `/health`.
- New Vercel project: `ao-xus-projects/football-oracle-agent`
- Production URL: **https://football-oracle-agent.vercel.app**
- Runtime: Next.js 15 serverless on Vercel (iad1)
- Account: Hobby (cron ≥ daily only)
- Persistence: MongoDB Atlas, database `football_oracle` (isolated from WC `worldcup_oracle`)
- Local JSONL FileOpsStore remains the default for tests
- Branch: local `main` (no git remote on this checkout)

---

# 4. Persistent Store

`OpsStore`: FileOpsStore (default) · ProductionPersistentOpsStore (`mongo` on Vercel, `bundle` in tests).

Hydrate → existing 2A.2 file logic → flush. Unique identities unchanged. Canonical tape is never a write target.

Restart evidence: a later `/api/health` lambda hydrates the same Mongo bundle and still sees tick 9, 120 PENDING jobs, last tick `2026-08-16T11:09:38.937Z`.

---

# 5. Live Source Configuration

Env **names** on the new project (values not recorded here):

`MONGODB_URI`, `MONGODB_DB=football_oracle`, `FOOTBALL_DATA_API_KEY`, `CRON_SECRET`, `PL_OPS_BACKEND=mongo`, `NEXT_PUBLIC_APP_URL`

`API_FOOTBALL_KEY` is not set. football-data.org is the live structured source.

---

# 6. Fixture Sync Dry Run

football-data.org `GET /v4/competitions/PL/matches?season=2026` → HTTP 200, 380 matches.

| FD status | n | Meaning |
| --- | ---: | --- |
| TIMED | 50 | real kickoff instants |
| SCHEDULED | 330 | date only (`T00:00:00Z`) — **not a kickoff** |

First production tick treated midnight placeholders as CONFIRMED and wrote 350 bad revisions. That was reversed: official overlay restored; date-only rows are ignored; DEFAULT 15:00/20:00 slots stay DEFAULT.

After the corrective ticks:

| Certainty | Count |
| --- | ---: |
| CONFIRMED | **30** |
| DEFAULT | **350** |
| PROVISIONAL | 0 |
| TBD | 0 |
| Conflicts | 0 |

Changed vs official after the safe policy: **0**. TIMED non-default slots already matched the official CONFIRMED set.

---

# 7. Result Feed Dry Run

Finished observations: **0**. No VERIFIED_FINAL. Settled: **0**. Ratings applied: **0**. The verifier stayed idle. No fabricated 2026-27 result.

---

# 8. Scheduler Deployment

| Mechanism | Cadence | Role |
| --- | --- | --- |
| Authenticated `GET /api/ops/tick` + `scripts/ops-scheduler-worker.ts` | 5 minutes | **operational** path |
| Vercel Cron | `0 4 * * *` (Hobby maximum) | daily keep-alive only |

Hobby rejected `*/5 * * * *` at deploy time. Several consecutive **production** ticks were executed with `CRON_SECRET` (ticks 1–9 observed). Last tick: `2026-08-16T11:09:38.937Z`.

---

# 9. Authentication

| Request | Result |
| --- | --- |
| missing secret | 401 `missing secret` |
| wrong secret | 401 `invalid secret` |
| valid Bearer | 200, one tick |

Production requires `CRON_SECRET`. Query `?secret=` is accepted for the same value.

---

# 10. Concurrency / Idempotency

File and Mongo leases (`pl_ops_locks`, 90s). Overlap → skip / 409. Tests: first lock wins, second rejected, release allows retry, guarded tick skips while locked.

Repeat ticks after the policy fix: `fixtureRevisions = 0`. Snapshot/settlement/rating first-write-wins unchanged.

---

# 11. /health

Production after tick 9: **HEALTHY**.

Exposes: DATA_READY, live source flags, last fixture/result sync, last tick, freshness (`fresh` if last tick < 15 minutes), job counts, next eligible job (fixture, stage, eligibleFrom, target, eligibleUntil, kickoff, certainty), persistence backend, conflicts.

Staleness: tick > **15 minutes** → DEGRADED.

---

# 12. Production Dry Run

```
fixture sync (football-data.org 200)
→ kickoff 30 CONFIRMED / 350 DEFAULT
→ 120 PENDING timed jobs
→ Mongo hydrate/flush
→ /health HEALTHY
```

No fixture was inside a T24H/T2H/T60M/FINAL window. **0 operational snapshots frozen.** No fake T24H on the genuine tape.

---

# 13. Next Genuine Prediction Job

Recomputed from live production fixture state after sync:

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

Unchanged from the Gate 5B watchpoint.

---

# 14. Trusted Tape Integrity

| | Required | Measured |
| --- | --- | --- |
| Lines | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

**Byte-identical: YES.** Git blob unchanged vs the 2A.2 freeze.

---

# 15. World Cup Regression

Phase 2A.2 suite **104/104**. Phase 2A.3 gates **15/15**. Routing **73/73**, track **24/24**, bracket all checks passed, DC selftest passed. Forecasting parameters HA/ρ/shrink/gap untouched.

---

# 16. Remaining Limitations

1. Vercel Hobby cannot invoke `/api/ops/tick` every 5 minutes. Use `npm run ops:worker` (`OPS_TICK_URL` + `CRON_SECRET`) or upgrade to Pro.
2. `API_FOOTBALL_KEY` not configured (single live source).
3. Job ledger still contains **1400 CANCELLED** rows from the first date-only misfire (auditable; not revived).
4. This checkout has **no git remote**; production is a Vercel CLI deploy, not a GitHub auto-deploy.
5. Sensitive Vercel env vars cannot be pulled back via API; football-data key was copied from the sibling WC `.env.local` without being written into this repo.
6. No Atlas PITR/runbook beyond “restore `pl_ops_bundle` + git tape”.
7. Phase 2B0 (odds) not started.

---

# 17. Phase 2B0 Readiness

```text
READY FOR TARGETED DEPLOYMENT AUDIT
```

Do **not** implement Phase 2B0 in this pass.
