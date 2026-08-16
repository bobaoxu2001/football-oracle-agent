# Phase 2A.3 deployment plan

**Date:** 2026-08-16  
**Base implementation:** `0e3e4b53caf0907bd7cb4054878c049373e81791`  
**Audit docs:** `5f69748b1c1c5956628729a75d9e58ba4df8d06a`  
**Manifest:** `a5b5ed692cf2ef725a69b06991ac5d1b890304157cd32088fa17a4ffd58bc948`

Phase 2A.2 is CLOSED. This plan changes infrastructure and configuration only.

---

## 1. What is actually running today

Inspected, not assumed:

| Fact | Evidence |
| --- | --- |
| This repo has **no git remote** | `git remote -v` empty |
| This directory is **not linked** to a Vercel project | no `.vercel/`; `vercel env ls` refuses |
| Vercel account | `ax2183-5057` / team `ao-xus-projects` |
| Existing related project | `worldcup-oracle-agent` → https://worldcup-oracle-agent.vercel.app |
| That production app | Next.js 24.x, GitHub `bobaoxu2001/worldcup-oracle-agent`, **no `/live` or `/health`** (404). It is the World Cup product. |
| `football-oracle-agent.vercel.app` | `DEPLOYMENT_NOT_FOUND` |
| Local secrets | no `.env` / `.env.local`; no `FOOTBALL_DATA_API_KEY` / `MONGODB_URI` / `CRON_SECRET` in the process environment |
| WC production env **names** (values not copied into this document) | `CRON_SECRET`, `FOOTBALL_DATA_API_KEY`, `MONGODB_URI`, `MONGODB_DB`, plus LLM/news keys unused by 2A.3 |
| Runtime | Vercel serverless (intended). Local `next dev` / `tsx` for tests. |
| Current ops state | gitignored JSONL under `data/processed/premier-league/ops/` — ephemeral on Vercel |
| Current cron file | `vercel.json` `*/5 * * * *` → `/api/ops/tick` (not deployed for this repo; Hobby may coarsen) |
| Tick auth today | if `CRON_SECRET` unset, **anyone can fire the tick** |

**Do not deploy this tree onto `worldcup-oracle-agent`.** That would overwrite the World Cup production app.

---

## 2. Target architecture

```
Vercel project: football-oracle-agent  (NEW)
  runtime: Next.js serverless
  routes: /live /health /api/ops/tick /api/live …
  env: MONGODB_URI, MONGODB_DB=football_oracle,
       FOOTBALL_DATA_API_KEY, CRON_SECRET, NEXT_PUBLIC_APP_URL
  cron: GET /api/ops/tick every 5 minutes (platform-permitting)

MongoDB Atlas (same cluster as WC memory, isolated DB)
  pl_ops_* collections + lease lock
  first-write-wins unique keys

Local / tests
  FileOpsStore (JSONL) — unchanged 2A.2 behaviour
```

Live source policy (already audited):

1. Official committed fixture release = baseline  
2. `FOOTBALL_DATA_API_KEY` → football-data.org `PL` 2026  
3. `API_FOOTBALL_KEY` → API-Football league 39 (optional corroboration)

No HTML scrape. No odds.

---

## 3. Persistence adapter

```
OpsStore
├── FileOpsStore          local + tests (default)
└── ProductionPersistentOpsStore
    ├── MongoOpsStore     Vercel / PL_OPS_BACKEND=mongo
    └── BundleOpsStore    isolated tests of the durable contract
```

Durable documents:

| Record | Identity |
| --- | --- |
| PredictionJob | `jobId` |
| Operational snapshot | snapshot unique key (first-write-wins) |
| Fixture current state | singleton overlay (never the 380-line tape) |
| FixtureRevision | revisionId |
| ResultObservation | observationId |
| ResultVerification | fixtureId |
| PredictionSettlement | snapshotUniqueKey (first-write-wins) |
| RatingAppliedEvent | fixtureId (exactly-once) |
| Rating state / tick state | singletons |
| Tick lock | `live-ops-tick` lease |

The committed tape `live-oos-2026-27.jsonl` is read-only evidence. New T24H/… rows live in the operational archive + Mongo.

On each production request that needs ops state: hydrate → existing 2A.2 sync code → flush. Forecasting code is not rewritten.

---

## 4. Auth and concurrency

- Production (`VERCEL=1` or `NODE_ENV=production`): `CRON_SECRET` **required**. Missing or wrong → 401.  
- Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.  
- Tick acquires a Mongo (or file) lease (~90s). Overlap → 409 skip, no second mutation.

---

## 5. Scheduler

Preferred: Vercel Cron `*/5 * * * *` on `/api/ops/tick`.

If the account cannot honor 5-minute cron (Hobby daily limit):

- keep the vercel.json entry (correct when the plan allows it);
- run `scripts/ops-scheduler-worker.ts` as the operational pinger against the production URL with `CRON_SECRET`;
- record observed production ticks from authenticated invocations.

Do not pretend a daily Hobby cron catches FINAL_PREKICK.

---

## 6. Dry-run rules

- Fixture sync against real football-data.org is allowed (metadata revisions only).  
- Do **not** invent a 2026-27 final score.  
- Do **not** write a fake T24H into the genuine LIVE_OOS tape.  
- If no fixture is inside a real window, only plan jobs; do not freeze.

---

## 7. Backup

MongoDB Atlas is the production copy of operational evidence. The frozen 380-line tape remains in git. Rating state can be rebuilt from `RatingAppliedEvent`. Settlements are first-write-wins documents. If Atlas is lost: restore from Atlas backup / last flush; historical 380 is still in the repo.

---

## 8. Out of scope

HA, ρ, shrink, gap, goal mapping, DC, calibration, market odds, injuries, lineups, other leagues. No model-version bump.
