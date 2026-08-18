# Phase 2B0 implementation log

Observational market recorder only. Forecasting model untouched.

## Baseline freeze (before 2B0 code)

| Item | Value |
| --- | --- |
| Recorded at | 2026-08-17T16:07:16Z |
| HEAD | `1740d96b559437cce2ccf77da76d3509af15d981` |
| HEAD subject | docs: pin Phase 2A.4 report end commit |
| Production deploy | `dpl_AAF5et4bVqvwVU6CxbyojLtupfs4` |
| Production /health | HEALTHY · lastTickAt `2026-08-17T16:03:04.495Z` · fresh |
| LIVE_OOS | 380 total · PRESEASON 365 · EARLY 15 · timed 0 · settled 0 |
| Market snapshots | 0 (module did not exist) |

Uncommitted at freeze (Phase 2A 16 MB compact, already on the production deploy above):

- `lib/competitions/premier-league/ops/durable-store.ts`
- `lib/competitions/premier-league/ops/fixture-sync.ts`
- `lib/competitions/premier-league/ops/result-feed.ts`
- `scripts/test-phase2a-3.ts`
- `docs/PHASE2A_FINAL_PRODUCTION_VERIFICATION.md`

### Frozen model parameters

| Param | Required | Observed |
| --- | --- | --- |
| modelVersion | pl-live-v0.2.0 | `production-params.json` + `PRODUCTION_MODEL_VERSION` |
| HA | 72 | `homeAdvantage: 72` |
| rho | −0.061 | `dcRho: -0.061` |
| shrink | 0.75 | `seasonShrink: 0.75` |
| Championship gap | −120 | `promotionGap: 120` (applied as a −120 promoted-club prior) |

### Trusted tape

| | Required | Measured |
| --- | --- | --- |
| Lines | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

Phase 2A is CLOSED and will not be reopened.

## Design notes written during implementation

- Market data lives in separate Mongo collections, never in `pl_ops_bundle`.
- Env var: `ODDS_API_KEY`.
- One region (`uk`), one market (`h2h`), decimal odds, league-level request.
- Adaptive cadence as specified, with documented quota floors so a free-tier key is not burned.
- Dedup: first-write-wins per `(source, sourceEventId, bookmaker, market, pollJobId)`. A later poll with unchanged prices is a new heartbeat observation.
- Closing market definition frozen prospectively in `docs/MARKET_DATA_BOUNDARY.md`.

## After implementation / deploy

| Item | Value |
| --- | --- |
| Production deploy | `dpl_8sQmGqC4jXQubZwFwGBu4DUrHgfN` |
| Forecast /health | HEALTHY (lastTickAt still advancing) |
| Market /health | UNCONFIGURED — `ODDS_API_KEY` missing |
| LIVE_OOS | 380 / 365 / 15 / timed 0 / settled 0 |
| Tape | byte-identical |
| Tests | 2B0 44/44; WC suites green |

Next operator step: add `ODDS_API_KEY` to Vercel Production. The following due ops tick will take the first LIVE_RECORDED poll. Do not backfill.
