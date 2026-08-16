# Phase 2A implementation log

**Start:** 2026-08-16  
**Starting SHA:** `7bc3f94e50dd172ba935bb2f99af80c366193bce`  
**Ending SHA:** `301c8b89440cb7dc60512450efe55545324a78cf`  
**Branch:** `main`  
**World Cup source:** untouched (`archive/worldcup-2026-v1` = `9e540b3…`)  
**Frozen Phase 1 benchmark:** `data/processed/premier-league/backtest-heldout.phase1-frozen.json`  
**Do not retune:** HA=72, ρ=−0.061, `pl-baseline-v0.1.0`

## Starting state (before implementation)

```text
HEAD     7bc3f94e50dd172ba935bb2f99af80c366193bce
status   clean working tree except untracked Phase 1.1 re-audit docs
node     v22.22.0 x64 (Rosetta) on arm64 host
```

### Current model versions

| Track | Version | Role |
| --- | --- | --- |
| Benchmark (frozen) | `pl-baseline-v0.1.0` | Phase 1 / 1.1 held-out 2025-26 evaluation |
| World Cup | `wc-live-v1.0.0` | Tournament plugin |
| Production 2026-27 | *does not exist yet* | Phase 2A will introduce `pl-live-v0.2.0` |

### Current Premier League parameters (`data/processed/premier-league/model-params.json`)

| Parameter | Value | Status |
| --- | --- | --- |
| HA | 72 | Training-window estimate 2018-19…2024-25 |
| ρ | −0.061 | Same window; DC gain not significant |
| drawBias | 1 (off) | — |
| goalScale / baseGoals | 350 / 1.35 | Hardcoded mapping |
| awayHomeShare | 0 | True home/away |
| kFactor | 20 | — |
| season shrink | 0.75 | Placeholder |
| promotion gap | 80 | Placeholder |
| Championship feeder | ON in live ratings; OFF in frozen benchmark | Re-audit item 2.2 |

### Current data sources

- Historical results: football-data.co.uk E0/E1 CSVs 2018-19…2025-26 (`data/sources.json`)
- 2026-27 official membership/fixtures: **not ingested** (generated 2025-26 double RR)
- football-data.co.uk `2627/E0.csv` redirects to National League (`EC`) — **no PL 2026-27 results tape yet**
- football-data.org `/v4/competitions/PL/matches?season=2026` requires a paid/configured key (403 without)
- API-Football not configured in this checkout

### Current snapshot schema

Unique key: `(competition, season, fixtureId, modelVersion, asOf)`  
`predictionStage` stored but **not** part of identity.  
No `evaluationClass`. Persistence: JSONL + optional Mongo replica.

### Re-audit carry-ins (fix first)

1. Snapshot key lacks `predictionStage`
2. Live vs benchmark feeder mismatch — make tracks explicit, do not silently unify
3. Model version semantics — new production version when behaviour changes
4. Honesty text hardcodes `2026-27`
5. Environment PATH nit for x64 npm

## Operating rules

- Do not rewrite Phase 1 / 1.1 reports.
- Do not weaken anti-leakage, snapshot, provenance, honesty, or World Cup gates.
- Do not invent 2026-27 clubs from 2025-26.
- Do not backfill LIVE_OOS after kickoff.
- Do not implement Phase 2B (odds) or 2C (injuries/lineups/xG).
- Do not add other leagues.

## Major decisions

Recorded as they are made.

### D1 — Snapshot identity includes prediction stage

Canonical key:

```text
competition :: season :: fixtureId :: modelVersion :: predictionStage :: asOf
```

Stable enum: `HISTORICAL | PRESEASON | EARLY | T24H | T2H | T60M | FINAL_PREKICK | RETROSPECTIVE`.

Legacy Phase 1 stages (`historical-as-of`, `preseason-baseline`, `as-of-kickoff`) map onto the enum. Lookups without a stage default to `HISTORICAL` so existing tests and on-disk Phase 1 snapshots still resolve.

### D2 — Explicit model tracks

| Track | Version | Feeder | Season init | HA/ρ | Purpose |
| --- | --- | --- | --- | --- | --- |
| `BenchmarkModel` | `pl-baseline-v0.1.0` | OFF | placeholder 0.75 / 80 | frozen 72 / −0.061 | Reproducible 2025-26 held-out |
| `ProductionModel` | `pl-live-v0.2.0` | ON | fitted historical transitions (2025-26 unused for search) | same HA/ρ, not recalibrated | Live 2026-27 forecasts |

They are intentionally not identical. A rating-state update after a verified result does **not** bump the model version.

### D3 — 2026-27 membership source

Canonical: Premier League official membership confirmation (Coventry, Ipswich, Hull in; West Ham, Burnley, Wolves out) plus the official 380-fixture release of 19 June 2026.

Cross-check: Wikipedia 2026–27 Premier League team list (same 20 clubs). Historical 2025-26 tape in this repo confirms the three relegated sides.

football-data.co.uk does not yet publish a 2026-27 E0 results file (URL serves National League). football-data.org is unconfigured. No silent guess when a structured feed is absent.

### D4 — Fixture identity

Internal id = `pl-2026-27-{homeSlug}-{awaySlug}` (unique in a single double round-robin).  
Source id = official pairing id. Kickoff changes update metadata; they do not mint a new fixture.

### D5 — First LIVE_OOS window

Today is 2026-08-16. Season starts 2026-08-21 20:00 Europe/London. **No 2026-27 match has kicked off.** All frozen 2026-27 forecasts created in this phase are genuine pre-match `LIVE_OOS` at stage `PRESEASON`. No T-24h / T-60m / final-prekick reconstructions are invented.

## Commands executed

- `git rev-parse HEAD` → `7bc3f94e50dd172ba935bb2f99af80c366193bce`
- `git status` / `git log --oneline -15`
- `node -p process.arch` → `x64`
- Read Phase 1 / 1.1 reports, re-audit, data-boundary, environment, model-params
- Fetched official PL fixture article + Wikipedia membership
- Probed football-data.co.uk `2627/E0.csv` (redirects to EC / National League)
- Probed football-data.org PL 2026 (403, no key)

### D6 — Season-init fit

Grid on 2019-20…2024-25 walk-forward log-loss (n=2,280). Winner: shrink 0.75, gap 120, feeder OFF (LL 0.97658). 2025-26 unused for search. Production still uses Championship feeder ON as a declared track feature so promoted 2026-27 clubs take the translation path.

### D7 — LIVE_OOS freeze

As-of 2026-08-16T05:33:34Z, before any 2026-27 kickoff. 380 snapshots written to `data/processed/premier-league/live-oos-2026-27.jsonl`. Stages: EARLY for the opening fortnight, PRESEASON otherwise. No T-24h / T-60m reconstructions.

## Later commands

```text
npm run ingest:pl-2026-27     → 20 clubs, 380 fixtures, DATA_READY
npm run typecheck             → pass
npm run fit:season-init       → shrink 0.75 / gap 120
npm test                      → 55 + 33 + 56
npm run freeze:live           → 380 LIVE_OOS
npm run ingest:pl-2026-27     → second run, 0 new identities
npm run test:routing          → 73
npm run test:track            → 24
npm run test:calibration      → 12
npm run test:tournament       → 52
npm run validate:bracket      → 495 + 37.3/30.9/15.3/7.0/2.4
plus ratings/honesty/dc/draw/stakes/path/qualification/intel/matchtype/bounce/form/completed/freshness/provenance/availability/tactical
npx tsx scripts/smoke-phase1.ts
```
