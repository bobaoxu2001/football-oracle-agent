# Phase 2A.2 implementation log — Live Season Operations

**Start:** 2026-08-16  
**Phase 2A status:** CLOSED (`PASS — PHASE 2A FROZEN, READY FOR LIVE OPERATIONS`). Not reopened.

## Starting state (before any Phase 2A.2 write)

| Item | Value |
| --- | --- |
| HEAD | `13715b37ee9f016c2af9919d0ed7670636a37e45` |
| git status | untracked: `docs/PHASE2A_1_TARGETED_VERIFICATION.md`, leftover Phase 1.1 tmpdir |
| Node | v22.22.0 x64 (Rosetta, documented) |
| Model version | `pl-live-v0.2.0` |
| HA / ρ | 72 / −0.061 (untouched) |
| Season init | `pl-season-init-v0.2.0` shrink 0.75, gap 120 |
| Season data version | `pl-2026-27-official-2026-08-16` |
| Season retrievedAt | `2026-08-16T05:34:56.390Z` |
| Fixture count | 380 |
| CONFIRMED / DEFAULT / PROVISIONAL / TBD | 30 / 350 / 0 / 0 |
| LIVE_OOS canonical | 380 (EARLY 15, PRESEASON 365) |
| Settled | 0 (no settlements file) |
| Tape lines | 380 |
| Tape MD5 | `34f7ca54025a3a48df9f1a169df66315` |
| Tape SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` |

The canonical tape is never a write target in this phase.

---

## Architecture decisions

### Isolation from Phase 2A evidence

- New operational state lives under `data/processed/premier-league/ops/` (gitignored JSONL).
- New LIVE_OOS observations append to `ops/live-oos-operational.jsonl`, never to `live-oos-2026-27.jsonl`.
- Fixture identity remains `pl-2026-27-{home}-{away}`.
- Kickoff certainty, DATA_READY, and timed-stage CONFIRMED guard are reused, not weakened.
- Structural parameters (HA, ρ, shrink, gap, goal mapping) are never written by the live loop.

### Five capabilities, one tick

`runLiveOpsTick(now)` is the only orchestrator:

```
fixture sync → plan jobs → mark missed → freeze eligible
→ ingest results → verify → settle LIVE_OOS → apply ratings → persist health
```

Cadence: **5 minutes**. FINAL_PREKICK’s eligible window is 15 minutes wide (T−20m … T−5m); 5-minute polling catches every timed stage without per-minute chatter.

Automation: `scripts/run-live-ops.ts` (local), `POST/GET /api/ops/tick` (HTTP), Vercel cron entry (platform may coarsen; local/cron worker is the operational path).

### Source / API policy

| Priority | Source | Role |
| --- | --- | --- |
| 1 | Official PL fixture release (committed CSV) | Baseline schedule; not a live competitor against later TV times |
| 2 | football-data.org `PL` season 2026 | Primary live structured feed when `FOOTBALL_DATA_API_KEY` is set |
| 3 | API-Football league 39 season 2026 | Corroboration when `API_FOOTBALL_KEY` is set |

No HTML scraping. Missing keys are a declared limitation, not a silent fallback to invented times.

Conflict rule: two *live* structured sources that disagree on kickoff (>60s) or full-time score → `SOURCE_CONFLICT`. Timed stages block. Settlement does not run. Official June 19 DEFAULT 15:00 vs a later API CONFIRMED 16:30 is an **update**, not a conflict.

### Stage windows (UTC instants, not UK strings)

| Stage | Target | Eligible window | Meaning |
| --- | --- | --- | --- |
| T24H | kickoff − 24h | [−26h, −22h] | 24-hour freeze |
| T2H | kickoff − 2h | [−150m, −90m] | 2-hour freeze |
| T60M | kickoff − 60m | [−75m, −45m] | 60-minute freeze |
| FINAL_PREKICK | kickoff − 10m | [−20m, −5m] | Latest valid model snapshot using currently available inputs. **Not** lineup-confirmed. |

Windows do not overlap. `asOf` for a scheduled observation is the **stage target** (deterministic). `asOf < kickoff` is asserted. DEFAULT/PROVISIONAL/TBD kickoffs never create timed jobs.

Missed window → `MISSED`. Never backfilled.

### Exactly-once

| Object | Identity |
| --- | --- |
| Scheduled snapshot | `(competition, season, fixtureId, modelVersion, stage, asOf=target)` first-write-wins |
| Prediction job | `fixtureId::stage::kickoffUtc` |
| Settlement | `snapshotUniqueKey` first-write-wins |
| Rating apply | `fixtureId` (one applied event per fixture) |

Retries consult the ledger and the snapshot store before writing.

### Ratings

- Model version stays `pl-live-v0.2.0` after a result.
- `liveRatingsAsOf` = historical date-strict walk-forward + 2026-27 season init + verified rating events with `kickoffUtc < asOf`.
- Same-kickoff fixtures apply in `fixtureId` order from the shared prior state. No club plays two matches at once, so this is equivalent to a same-instant batch.
- Corrections do not silently mutate an applied event or a settlement; they append an auditable revision and surface on `/health`.

### Health

Overall: `HEALTHY` | `DEGRADED` | `BLOCKED`. DEFAULT kickoffs in later weeks are expected and are **not** by themselves DEGRADED. A confirmed-matchday fixture still on DEFAULT within 48h is DEGRADED. Conflicts, store failures, and DATA_BLOCKED are BLOCKED.

---

## Migrations

None against the canonical tape, fixture identities, or model-params. New files only plus additive fields on new snapshots (`sourceState.origin`, `ratingStateAsOf`, `computedAt`).

Existing `fixture-revisions.jsonl` remains; schedule-level revisions also append to `ops/fixture-schedule-revisions.jsonl` with old/new kickoff, certainty, status, source, and reason.

---

## Failure handling

| Class | Behaviour |
| --- | --- |
| Temporary network | bounded retry (3), job/sync FAILED if exhausted, health DEGRADED |
| Source unconfigured | sync still records official baseline; result feed `unconfigured`; DEGRADED after a kickoff without a result source |
| Invalid payload | reject row, do not patch fixture |
| SOURCE_CONFLICT | no kickoff guess, no settlement |
| Process death | JSONL replay; succeeded snapshots/jobs/settlements/ratings are not repeated; missed windows stay missed |

---

## Test evidence

| Suite | Result |
| --- | --- |
| `typecheck` | pass |
| `test:phase1` | 55/55 |
| `test:phase1-1` | 33/33 |
| `test:phase2a` | 56/56 |
| `test:phase2a-1` | 45/45 |
| `test:phase2a-2` | **71/71** |
| routing | 73/73 |
| track | 24/24 |
| calibration | 12/12 |
| tournament | 52/52 |
| ratings | pass |
| honesty | pass |
| `dc:selftest` | pass |
| `validate:bracket` | 495/495; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 |

Local `npm run ops:tick` on 2026-08-16T08:49:53Z: 0 fixture revisions, 120 PENDING timed jobs (30 CONFIRMED × 4 stages), 0 snapshots, 0 settlements, 0 rating events. Next job: Arsenal–Coventry T24H eligible from 2026-08-20T17:00:00Z. `/health` went from DEGRADED (no tick yet) to HEALTHY.

Browser (headless Chrome, `127.0.0.1:3300`): `/live` 380 / settled 0 / stage table dashes / no 764 / no hydration error. `/health` loads DATA_READY + job counts; after tick HEALTHY, pending 120.

Canonical tape end-state: 380 / md5 `34f7ca54025a3a48df9f1a169df66315` / sha256 `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da`. Byte-identical.
