# Phase 2B0 market recorder report

**Date:** 2026-08-18

---

# 1. Verdict

```text
PASS WITH LIMITATIONS
```

The observational recorder is implemented, isolated from `pl-live-v0.2.0`, tested, and deployed. Production forecast health remains **HEALTHY**. Market health is **UNCONFIGURED** because `ODDS_API_KEY` is not set on Vercel. No LIVE_RECORDED print exists yet — none was invented.

# 2. Repository State

| Item | Value |
| --- | --- |
| Start SHA | `1740d96b559437cce2ccf77da76d3509af15d981` |
| End SHA | same commit plus uncommitted 2B0 working tree (this repo still has no git remote) |
| Production deploy | `dpl_8sQmGqC4jXQubZwFwGBu4DUrHgfN` |
| Production URL | https://football-oracle-agent.vercel.app |
| Deployed | 2026-08-17T16:18:09Z |

# 3. Market Source

| Field | Value |
| --- | --- |
| Provider | The Odds API v4 (`https://api.the-odds-api.com`) |
| Official docs | https://the-odds-api.com/liveapi/guides/v4/ |
| Sport key | `soccer_epl` (from docs; live list not probed — no key) |
| Region | `uk` only (one region, quota) |
| Market | `h2h` decimal 1X2 |
| Env | `ODDS_API_KEY` |
| Configured in production | **no** |
| Live API result | not called (key absent). Adapter is ready: one league-level GET, headers `x-requests-remaining` / `x-requests-used` / `x-requests-last` |

# 4. Market Data Model

Schema version: `market-recorder-v0.1.0` (forecast model remains `pl-live-v0.2.0`).

Origins: `LIVE_RECORDED` | `HISTORICAL_PROVIDER` | `TEST`. Production path writes `LIVE_RECORDED` only.

Bookmaker-level `MarketObservation` stores decimal odds, raw implied, overround, margin, proportional fair probs, `retrievedAt`, `bookmakerLastUpdate`, `pollJobId`. No raw API blobs.

# 5. Fixture Mapping

`resolvePlClub` + unique season home/away identity (`officialFixtureId`). Kickoff drift is treated as a reschedule. Prior MATCHED `sourceEventId` is retained. AMBIGUOUS / UNMATCHED / CONFLICT rows are stored as mappings but **not** as production observations.

# 6. Raw Odds Preservation

`homeOddsDecimal` / `drawOddsDecimal` / `awayOddsDecimal` are stored on every observation so later de-vig methods can be recomputed.

# 7. De-vig Method

`proportional-v1`: `p_i = q_i / Σq`. Fair triple must sum to 1. No Shin / power models.

# 8. Consensus Construction

Derived only. `median-fair-v1` of bookmaker fair H/D/A, then renormalized. Also stores bookmakerCount, margin min/max, min/max/stdev/IQR per outcome. Never called a true probability.

# 9. Polling Cadence

Specified ladder (>7d / 6h, 7d–48h / 1h, 48h–6h / 15m, 6h–kickoff / 5m, after kickoff stop).

Documented quota floors (free-tier 500 credits/month; first match is already inside 7 days):

- remaining < 200 → min 6h
- remaining < 80 → min 12h
- remaining < 20 → min 24h + DEGRADED

Never silent-stop. No in-play recording.

# 10. Quota Management

Quota telemetry persisted on market state. Health exposes remaining / used / last cost. Cadence floors when remaining is low.

# 11. Mongo Persistence

Separate collections, not `pl_ops_bundle`:

- `market_observations`
- `market_consensus`
- `market_event_maps`
- `market_poll_jobs`
- `market_state` (singleton)

Indexes: observationId unique; fixture+retrievedAt; source+sourceEventId; fixture+bookmaker+retrievedAt; marketType; origin.

File backend for tests only (`MARKET_STORE_BACKEND=file`).

# 12. Idempotency

`observationId = source::sourceEventId::bookmaker::h2h::pollJobId`

Same poll retried → first-write-wins (E11000 / map hit).

A later scheduled poll with unchanged prices is a **new heartbeat** (new pollJobId, new retrievedAt). That is intentional v0 coverage.

# 13. No-Lookahead Alignment

`alignMarketToModelAsOf`: latest observation with `retrievedAt <= asOf`. Tested: 10:00/11:00/12:00 vs asOf 11:30 → 11:00.

# 14. Closing Market Definition

Frozen in `docs/MARKET_DATA_BOUNDARY.md`:

```text
ClosingMarketSnapshot =
  latest valid LIVE_RECORDED pre-match consensus
  with retrievedAt strictly before kickoffUtc
```

Tested: 14:40/14:50/14:58/15:01 vs kickoff 15:00 → 14:58.

# 15. Model Independence Test

Same EARLY snapshot before market data, after two books, and after extreme 1.01/50/80 odds:

Home/Draw/Away, lambdas, ratings, modelVersion **byte-identical**.

`PRODUCTION_TRACK.features.liveMarketOdds` remains `false`. Market module is not imported by `league-engine`.

# 16. Health / Failure Isolation

Forecast `/api/health.overall` is unchanged by market status. Market is a sibling object / `/api/market/health`.

Simulated outage → market job FAILED; forecast health still a known state; tape untouched.

Guarded forecast ticks release the 90s lease **before** market work. `skipNetwork` ticks never call the odds API. Timeout 8s.

# 17. First Production Poll

**Not taken.** `ODDS_API_KEY` is not present locally or on Vercel. No historical print was fabricated.

After the key is added as a Production env var, the next due hosted tick will record `LIVE_RECORDED` automatically (`lastSuccessAt` is null → first poll is due).

# 18. Trusted Forecast Tape

| | Required | End |
| --- | --- | --- |
| Lines | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

Byte-identical.

LIVE_OOS after deploy: PRESEASON 365 / EARLY 15 / timed 0 / settled 0.

# 19. World Cup Regression

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
| bracket | all checks; top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4 |
| Phase 2A.3 / 2A.4 / 2B0 | 27 / 62 / 44 |

# 20. Remaining Limitations

1. **No `ODDS_API_KEY`** — blocks the first LIVE_RECORDED poll and live docs probe of `soccer_epl` bookmaker coverage.
2. Live The Odds API sport-key / draw / quota headers were verified from official v4 documentation, not from a live authenticated response.
3. Quota floors deviate from the raw 15-minute/5-minute ladder when remaining credits are low (documented).
4. Application repo still has no git remote; production is a Vercel CLI deploy.
5. Phase 2B1 (edge / CLV / disagreement UI) was not implemented.

# 21. Phase 2B0 Audit Readiness

```text
NOT READY
```

Ready for independent audit only after:

1. `ODDS_API_KEY` is set on the Vercel project (Production).
2. One genuine hosted poll writes `LIVE_RECORDED` observations.
3. Arsenal–Coventry (or whatever events the API returns) mapping is inspected live.

Do not start Phase 2B1 until that poll exists.
