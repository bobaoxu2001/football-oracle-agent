# Phase 2A.2 live operations report — Football Oracle

**Date:** 2026-08-16  
**Verdict:** **PASS WITH LIMITATIONS**

Phase 2A remains CLOSED. The committed 380-line LIVE_OOS tape was not rewritten. This phase adds a live-season operations loop around that evidence.

---

# 1. Verdict

**PASS WITH LIMITATIONS**

| Gate | Result |
| --- | --- |
| Fixture sync updates metadata, keeps identity, writes revisions | PASS |
| Sync idempotent (sync × 3, no duplicate revision) | PASS |
| Kickoff certainty unchanged (CONFIRMED required for timed stages) | PASS |
| SOURCE_CONFLICT blocks timed kickoff guesses | PASS |
| Scheduler: DEFAULT never gets T24H/T2H/T60M/FINAL_PREKICK | PASS |
| Scheduler: CONFIRMED T24H exactly-once | PASS |
| Missed window marked MISSED, never backfilled | PASS |
| Reschedule uses new CONFIRMED kickoff; old job cancelled | PASS |
| Postpone after EARLY preserves history; future jobs cancelled | PASS |
| LIVE / unverified results do not settle | PASS |
| VERIFIED_FINAL settles; conflict does not | PASS |
| Settlement is a new record; snapshot bytes unchanged | PASS |
| Brier / RPS / LogLoss match audited definitions | PASS |
| Rating update exactly-once | PASS |
| Future forecast uses new ratings; historical snapshot unchanged | PASS |
| HA / ρ / shrink / gap not retuned | PASS |
| `/health` exposes operational state | PASS |
| `/live` stage table; N=0 → — | PASS |
| Browser `/live` + `/health` | PASS |
| Canonical 380 tape byte-identical | PASS |
| World Cup regression | PASS |
| Phase 2B0 / odds / injuries / other leagues | PASS — not implemented |

Limitations are listed in §13. None hide a failed required gate.

---

# 2. Repository State

| Item | Value |
| --- | --- |
| Start SHA | `13715b37ee9f016c2af9919d0ed7670636a37e45` |
| End SHA | working tree on start SHA (Phase 2A.2 not committed) |
| Frozen tape | `data/processed/premier-league/live-oos-2026-27.jsonl` untouched |
| HA / ρ | 72 / −0.061 untouched |
| Season init | shrink 0.75, gap 120 untouched |
| Model version | `pl-live-v0.2.0` (unchanged; ratings are state, not a new version) |

Principal new files: `lib/competitions/premier-league/ops/*`, `scripts/run-live-ops.ts`, `scripts/test-phase2a-2.ts`, `app/health/page.tsx`, `app/api/health/route.ts`, `app/api/ops/tick/route.ts`, `app/live/fixture/[id]/page.tsx`.

Additive edits: fixture-store path overrides, ABANDONED status, settlement `topPickCorrect`, live-ledger union + stage table, league-engine `liveRatingsAsOf` + scheduled origin fields, `/live` UI, navbar, `package.json`, `vercel.json`.

---

# 3. Trusted Tape Integrity

`data/processed/premier-league/live-oos-2026-27.jsonl` measured at start and end:

| Metric | Required | Start | End |
| --- | --- | --- | --- |
| Lines | 380 | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | same | same |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | same | same |

**Byte-identical: YES.**

New scheduled observations append to `data/processed/premier-league/ops/live-oos-operational.jsonl` (gitignored). The library refuses to use the canonical tape as that archive.

---

# 4. Fixture Sync

| | |
| --- | --- |
| Baseline | Official PL 19 June 2026 release (committed CSV / fixture store) |
| Live primary | football-data.org `PL` season 2026 when `FOOTBALL_DATA_API_KEY` is set |
| Corroboration | API-Football league 39 season 2026 when `API_FOOTBALL_KEY` is set |
| Cadence | every 5 minutes as part of `runLiveOpsTick` |
| Identity | `pl-2026-27-{home}-{away}` never rewritten |
| Revisions | `ops/fixture-schedule-revisions.jsonl` — old/new kickoff, certainty, status, source, reason |
| Idempotency | no source change → no logical change, no duplicate revision (tested ×3) |
| Conflict | two live sources disagree on kickoff (>1s) → `SOURCE_CONFLICT`; kickoff not guessed; timed jobs blocked |

Official June 19 DEFAULT 15:00 vs a later live CONFIRMED 16:30 is an **update**, not a conflict.

This checkout has **no live API keys**. First local tick used the official baseline only: 0 revisions, 30 CONFIRMED / 350 DEFAULT unchanged.

---

# 5. Prediction Scheduler

Windows (UTC instants, not UK strings):

| Stage | Target | Eligible | Meaning |
| --- | --- | --- | --- |
| T24H | kickoff − 24h | [−26h, −22h] | 24-hour freeze |
| T2H | kickoff − 2h | [−150m, −90m] | 2-hour freeze |
| T60M | kickoff − 60m | [−75m, −45m] | 60-minute freeze |
| FINAL_PREKICK | kickoff − 10m | [−20m, −5m] | Latest valid model snapshot using currently available inputs. **Not** lineup-confirmed. |

Windows do not overlap. `asOf` for a scheduled observation is the stage target. `asOf < kickoff` is asserted. DEFAULT/PROVISIONAL/TBD never create timed jobs.

| Rule | Behaviour |
| --- | --- |
| Exactly-once | job id `fixtureId::stage::kickoffUtc`; snapshot key includes planned asOf; first-write-wins; retry finds existing snapshot |
| Missed | `now > eligibleUntil` and not SUCCEEDED → `MISSED`. No backfill. |
| Reschedule | old PENDING/ELIGIBLE/BLOCKED/FAILED jobs CANCELLED; new jobs for new CONFIRMED kickoff |
| Postpone | historical snapshots kept; future jobs cancelled; no settlement |
| EARLY / PRESEASON | not created by the scheduler (already on the tape) |

Cadence **5 minutes** because FINAL_PREKICK’s window is 15 minutes wide.

Local tick 2026-08-16T08:49:53Z planned **120 PENDING** jobs. Next: `pl-2026-27-arsenal-coventry` T24H from `2026-08-20T17:00:00.000Z`.

---

# 6. Result Feed

| | |
| --- | --- |
| Sources | same live structured adapters; official CSV has no scores |
| Verification | `UNVERIFIED` / `PROVISIONAL` / `VERIFIED_FINAL` / `CONFLICT` |
| Settlement requires | `VERIFIED_FINAL` + `FINISHED` + numeric score |
| LIVE / HT | never settle |
| One trusted FINISHED | `VERIFIED_FINAL` |
| Two live sources, same score | `VERIFIED_FINAL` |
| Two live sources, different score | `CONFLICT`; no settlement; `/health` surfaces it |
| POSTPONED / SUSPENDED / ABANDONED / CANCELLED | no normal settlement |

Completed 2026-27 matches at implementation time: **0**. No fabricated results were written into the real fixture store.

---

# 7. Settlement

| | |
| --- | --- |
| Storage | `settlements.jsonl` (separate from snapshots; gitignored) |
| Link | `snapshotUniqueKey` |
| Metrics | Brier, RPS, LogLoss (audited formulas), `topPickCorrect`, actual outcome/score |
| Scope | operational settle is `LIVE_OOS` only |
| Idempotency | first-write-wins on `snapshotUniqueKey` |
| Correction | append-only `settlement-corrections.jsonl`; original settlement and ratings not mutated |

Independent check: p=(0.5, 0.3, 0.2), home win → Brier 0.38, RPS 0.145, LogLoss −ln(0.5).

`/live` reports stage rows separately. Headline Brier/RPS/LogLoss stay `null` until N_settled ≥ 20. N=0 shows `—`. Calibration is not claimed on a tiny sample.

---

# 8. Rating Update

| | |
| --- | --- |
| Trigger | `VERIFIED_FINAL` only |
| Identity | one `RatingAppliedEvent` per `fixtureId` |
| Repeat ingest | returns the existing event; Elo not applied again |
| Order | chronological `kickoffUtc`, then `fixtureId`. Same-kickoff matches share the prior state; no club plays two matches at once, so sequential apply is equivalent to a same-instant batch |
| Production ratings | `liveRatingsAsOf` = historical date-strict walk-forward + 2026-27 season init + events with `kickoffUtc < asOf` |
| Model version | stays `pl-live-v0.2.0` |
| Structural params | never written |

Tested: prediction A frozen before Match 1 uses pre-match ratings; Match 1 applies once; prediction B afterward sees post-match Arsenal Elo; A’s stored probabilities are unchanged.

---

# 9. Operational Health

`GET /api/health` and `/health`.

Overall:

- **HEALTHY** — DATA_READY, recent successful tick, no conflicts
- **DEGRADED** — stale tick/sync, failed jobs, unconfigured live source near matchday, DEFAULT kickoff inside 48h
- **BLOCKED** — DATA_BLOCKED, SOURCE_CONFLICT, result CONFLICT

DEFAULT kickoffs in later weeks are expected and are **not** by themselves DEGRADED.

Exposed: season + DATA_READY, last fixture/result sync, certainty counts, next confirmed fixture, job counts, next job, LIVE_OOS totals, settlement/rating state, conflicts, last error.

Before the first tick this checkout was DEGRADED (`ops tick stale`, `fixture sync stale`). After `npm run ops:tick` it is HEALTHY, 120 PENDING jobs, 0 conflicts.

Staleness: tick > 15 minutes; fixture sync > 36h normally, > 6h when a CONFIRMED kickoff is within 48h; result feed DEGRADED 6h after kickoff without VERIFIED_FINAL.

---

# 10. Restart / Failure Recovery

Jobs, settlements, rating events, and operational snapshots are JSONL. Cache reset reloads from disk.

Tested: succeeded snapshots not duplicated; missed windows not backfilled; pending jobs restored; rating event not re-applied; settlements first-write-wins.

Bounded retries: 3 per job inside the window. Exhaustion stays FAILED and is visible on `/health`. Temporary network errors degrade; they do not invent data.

---

# 11. Browser Verification

Headless Chrome `--headless=new` against `next dev` on `127.0.0.1:3300`.

### `/live`

- LIVE_OOS snapshots **380**
- Settled **0**
- Brier / RPS / LogLoss **—**
- Calibration “n too small”; sample-size honesty text
- Stage table: PRESEASON 365 / EARLY 15 / T24H–FINAL 0, all settled **—**
- Model `pl-live-v0.2.0`; gate DATA_READY
- Upcoming fixtures with CONFIRMED/DEFAULT labels
- No 764, no hydration/runtime error

### `/health`

- Loads; title “Operational health”
- DATA_READY; kickoff 30 / 350 / 0 / 0
- After tick: overall HEALTHY; pending 120; next T24H Arsenal–Coventry
- No hydration/runtime error

### `/live/fixture/pl-2026-27-arsenal-coventry`

- 200; Arsenal vs Coventry City; EARLY row present

---

# 12. World Cup Regression

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
| validate:bracket | 495/495; top-5 **37.3 / 30.9 / 15.3 / 7.0 / 2.4** |

**PASS.**

---

# 13. Remaining Limitations

1. No live structured API key is configured on this checkout. Fixture/result adapters are implemented and tested with injected sources; they will stay idle until keys exist.
2. Vercel Hobby cron may not honor `*/5 * * * *`. Timed stages need a worker that can fire every 5 minutes (`npm run ops:tick` or an external scheduler calling `GET /api/ops/tick`).
3. 350 DEFAULT kickoffs remain. Timed stages will not run for those until a live source confirms them.
4. Zero real 2026-27 results yet. Settlement and rating paths are proven on controlled test fixtures only.
5. FINAL_PREKICK is not lineup-confirmed. Lineups are out of scope.
6. Mongo replica of snapshots remains optional.
7. Tests remain `tsx` scripts.
8. No odds, injuries, lineups, transfers, shot-based xG, or other leagues — by design.

---

# 14. Phase 2B0 Readiness

```text
READY FOR INDEPENDENT AUDIT
```

Audit Phase 2A.2 live operations first. Do **not** implement Phase 2B0 (market odds / de-vig / CLV) in this pass. Prefer waiting until at least a few genuine LIVE_OOS settlements exist before adding a market layer.

---

Phase 2A proved Football Oracle can make trustworthy prospective predictions.  
Phase 2A.2 proves it can operate continuously without corrupting that evidence.
