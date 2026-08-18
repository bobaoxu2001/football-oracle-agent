# Phase 2B0.1 — first genuine LIVE_RECORDED market evidence

**Date:** 2026-08-17 / 2026-08-18 local
**Purpose:** configure The Odds API and freeze the first prospective market print.

Phase 2A remains CLOSED. Forecasting model untouched.

---

# 1. Verdict

```text
PASS WITH NON-BLOCKING LIMITATIONS — PHASE 2B0 LIVE
```

`ODDS_API_KEY` is configured on Vercel Production (value not recorded). A hosted ops tick at `2026-08-17T16:33:59Z` ran one genuine `LIVE_RECORDED` poll at `2026-08-17T16:34:00.487Z`. 209 bookmaker observations and 10 consensus snapshots were written to separate Mongo collections. Forecast health stayed **HEALTHY**. The 380-line tape is byte-identical.

# 2. Official contract

Independently re-read https://the-odds-api.com/liveapi/guides/v4/ before any live call.

Live probe (sports list is quota-free; then **one** uk/h2h request):

| Check | Result |
| --- | --- |
| `soccer_epl` in `/v4/sports` | yes · title EPL · active · no outrights |
| Odds HTTP | 200 |
| Sport on events | `soccer_epl` |
| Region / market / format | uk / h2h / decimal |
| Draw present | 209/209 bookmaker-markets |
| `last_update` present | 209/209 |
| Quota headers | remaining 499 → 498 after production poll; last=1; used=2 |

Contract matches the adapter. No production code change was required.

# 3. Secret handling

`ODDS_API_KEY configured: YES`

Stored only as:

- gitignored `.env.local` (not tracked)
- Vercel Production encrypted env

Not printed, not committed, not stored in Mongo, not exposed on `/health`.

Redeploy after add: `dpl_8uow1jKx9U7Q3bK5C8gjxNaezUpZ`.

# 4. First LIVE_RECORDED poll

Triggered by the existing GitHub Actions ops tick. This machine did **not** call `/api/ops/tick`.

| Field | Value |
| --- | --- |
| retrievedAt / firstMarketObservationAt | `2026-08-17T16:34:00.487Z` |
| Origin | `LIVE_RECORDED` only |
| Schema | `market-recorder-v0.1.0` |
| Source | `the-odds-api` |
| Events | 10 |
| Matched | 10 |
| Unmatched / ambiguous / conflict | 0 / 0 / 0 |
| Bookmakers | 21 |
| Observations written | 209 |
| Consensus | 10 |
| Quota cost | 1 |
| Quota remaining | 498 |
| pollJobId | `market-poll::2026-08-17T16:34:00.487Z::1781c64c` |

No backdated `retrievedAt`. No `HISTORICAL_PROVIDER` rows.

# 5. Arsenal vs Coventry City

| Field | Value |
| --- | --- |
| Canonical | `pl-2026-27-arsenal-coventry` |
| Provider event | `eb2553d10d63dc912b99f8fd0d675721` |
| Teams | Arsenal / Coventry City |
| commence_time | `2026-08-21T19:00:00Z` (matches CONFIRMED kickoff) |
| Mapping | MATCHED |
| Bookmakers | 21 |
| Observations | 21 |
| Consensus | yes · median-fair-v1 · n=21 |

Sample book (Betfair Sportsbook), names mapped not array order:

| Outcome | Decimal |
| --- | ---: |
| Arsenal (home) | 1.15 |
| Draw | 7.50 |
| Coventry City (away) | 15.00 |

`bookmakerLastUpdate` `2026-08-17T16:33:30Z` ≠ `retrievedAt` `16:34:00.487Z`.

Independent recompute of all 21 Arsenal–Coventry rows: **0 math mismatches**. Consensus medians match persisted fair H/D/A to 0 delta.

This is a captured market snapshot, not a recommendation.

# 6. Mongo

| Collection | Docs | Notes |
| --- | ---: | --- |
| market_observations | 209 | unique observationId; fixture/time indexes |
| market_consensus | 10 | unique consensusId |
| market_event_maps | 10 | all MATCHED |
| market_poll_jobs | 3 | 2 pre-key SKIPPED + 1 SUCCEEDED |
| market_state | 1 | first-write firstMarketObservationAt |
| pl_ops_bundle | 1 | **no market keys** |

Megadoc risk: none. Time-series rows are one document each.

Retry of the first Betfair Sportsbook observationId returned `duplicate` (first-write-wins). Next scheduled poll is `2026-08-17T17:34:00.487Z` (1 hour) and will create new pollJobIds (heartbeat), not overwrite.

# 7. Cadence / quota

Time to Arsenal–Coventry kickoff ≈ 4 days → specified 1-hour band. Production `currentCadenceMs = 3600000`. Quota floors remain in code. One region, one h2h market.

# 8. Alignment / closing

Frozen EARLY tape `asOf = 2026-08-16T05:33:34.616Z` is **before** the first market print.

`alignConsensusToModelAsOf(EARLY) = NONE`

That is correct. Do not attach 16:34 odds to the 16 Aug forecast.

Closing definition unchanged: latest LIVE_RECORDED consensus with `retrievedAt` strictly before kickoff. No in-play rows stored (all commence times are future).

# 9. Model independence

Regenerated EARLY Arsenal–Coventry after market data exists:

| | Tape / model |
| --- | --- |
| H/D/A | 0.711979… / 0.188794… / 0.099226… **identical to tape** |
| λ | 2.203… / 0.703… |
| Ratings | Arsenal 1770.72 · Coventry 1544.11 |
| modelVersion | pl-live-v0.2.0 |
| HA / ρ | 72 / −0.061 |

# 10. Health / pages

| Surface | Result |
| --- | --- |
| Forecast /health | HEALTHY · fresh · tick `2026-08-17T16:33:59.120Z` |
| Market /health | HEALTHY · configured · 209 obs · 10 consensus |
| /market | 200 · 10 fixtures · disclaimer only |
| Betting CTA | none (`edge`/`stake` appear only as “not an edge, a stake”) |

# 11. Trusted tape / LIVE_OOS / World Cup

Tape 380 / required hashes / byte-identical **YES**.

LIVE_OOS still PRESEASON 365 / EARLY 15 / timed 0 / settled 0.

World Cup: routing 73, track 24, calibration 12, tournament 52, ratings, honesty, DC selftest, bracket top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4.

# 12. Heartbeat time-series (verified 2026-08-17T22:52Z)

Seven SUCCEEDED hosted polls, ~hourly, without overwriting the first print:

| executedAt | obs | consensus | quota remaining |
| --- | ---: | ---: | ---: |
| 16:34:00.487Z | 209 | 10 | 498 |
| 17:35:04.941Z | 209 | 10 | 497 |
| 18:35:18.996Z | 209 | 10 | 496 |
| 19:35:48.369Z | 209 | 10 | 495 |
| 20:38:57.657Z | 209 | 10 | 494 |
| 21:43:13.080Z | 208 | 10 | 493 |
| 22:46:42.067Z | 208 | 10 | 492 |

First poll rows still present: **209 observations + 10 consensus**. Later rows: **1252 + 60**. Totals 1461 / 70.

Arsenal–Coventry Betfair Sportsbook first row still `retrievedAt=16:34:00.487Z`, odds `1.15 / 7.50 / 15.00`. The same bookmaker now has **seven** distinct `retrievedAt` values. `firstMarketObservationAt` remains `2026-08-17T16:34:00.487Z`. Origin is exclusively `LIVE_RECORDED`. `pl_ops_bundle` still has no market keys.

# 13. Limitations (non-blocking)

1. Provider currently returns the next 10 EPL events, not the full 380-fixture season. Later matchweeks will appear as the API lists them.
2. Isolated source-outage / ambiguity suites remain the 2B0 test file (not re-broken in production).
3. Application repo still has no git remote.
4. One later poll wrote 208 instead of 209 bookmaker rows (one book omitted a complete 1X2). First evidence is intact.

# 14. Phase 2B1

```text
WAIT
```

Do not start disagreement / CLV / edge work. Phase 2B0 is live and appending hourly heartbeats.
