# Phase 2B0.1 — first LIVE_RECORDED market evidence log

Observational only. Forecast tape and `pl-live-v0.2.0` must stay untouched.

## Baseline (before key / poll)

| Item | Value |
| --- | --- |
| Recorded at | 2026-08-17T16:27:00Z |
| HEAD | `1740d96b559437cce2ccf77da76d3509af15d981` |
| Production deploy | `dpl_8sQmGqC4jXQubZwFwGBu4DUrHgfN` |
| Forecast /health | HEALTHY · lastTickAt `2026-08-17T16:23:54.709Z` · fresh |
| LIVE_OOS | 380 · PRESEASON 365 · EARLY 15 · timed 0 · settled 0 |
| Market /health | UNCONFIGURED · observations 0 · consensus 0 |
| firstMarketObservationAt | null |
| Model | pl-live-v0.2.0 · HA 72 · ρ −0.061 · shrink 0.75 · promotionGap 120 (−120 prior) |

Tape:

| | Required | Measured |
| --- | --- | --- |
| Lines | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

`ODDS_API_KEY configured:` not yet.

## Official contract (docs, before live call)

Source: https://the-odds-api.com/liveapi/guides/v4/

- Host: `https://api.the-odds-api.com`
- Sports list: `GET /v4/sports` — **does not consume quota**; returns `key` including soccer keys
- Odds: `GET /v4/sports/{sport}/odds?regions=&markets=&oddsFormat=`
- `regions=uk` is a documented region
- `markets=h2h` is the default head-to-head / 1X2 market
- `oddsFormat=decimal` is documented; default is decimal
- Bookmaker objects include `last_update`
- Quota headers: `x-requests-remaining`, `x-requests-used`, `x-requests-last`
- Cost: 1 per market per region (one uk + h2h = 1 credit)

Implementation already matches this contract. No production adapter change required before the probe.

## Live probe (no Mongo writes)

Sports list HTTP 200 · 76 sports · `soccer_epl` active. Quota last=0.

One uk/h2h request HTTP 200 · 10 events · 21 UK books · draw+last_update+decimal on 209 book-markets. Quota remaining 499, last=1, used=1.

Arsenal vs Coventry City present: provider `eb2553d10d63dc912b99f8fd0d675721`, commence `2026-08-21T19:00:00Z`. Offline mapping: 10/10 MATCHED.

`ODDS_API_KEY configured: YES` (Vercel Production encrypted). Redeploy `dpl_8uow1jKx9U7Q3bK5C8gjxNaezUpZ`.

## First hosted LIVE_RECORDED poll

| Field | Value |
| --- | --- |
| At | 2026-08-17T16:34:00.487Z |
| Trigger | GitHub Actions ops tick `lastTickAt` 16:33:59.120Z |
| Origin | LIVE_RECORDED |
| Observations | 209 |
| Consensus | 10 |
| Matched | 10 |
| Quota remaining | 498 |
| firstMarketObservationAt | 2026-08-17T16:34:00.487Z (first-write) |

Forecast HEALTHY throughout. Tape hashes unchanged.

## Heartbeats after first print (22:52Z check)

7 SUCCEEDED polls. First job still has 209 observations + 10 consensus. Later polls added 1252 + 60. `firstMarketObservationAt` unchanged. Betfair Sportsbook Arsenal–Coventry first odds still 1.15 / 7.50 / 15.00 at 16:34:00.487Z, plus six later retrievedAt heartbeats. Quota 492. Next due 23:46:42Z. Tape hashes unchanged. Forecast HEALTHY.
