# Football Oracle

Auditable Premier League production forecasts.

[Production site](https://football-oracle-agent.vercel.app)

Football Oracle treats every match forecast as an immutable probability artifact. The forecasting engine produces the numbers; the match-scoped language model may retrieve those numbers and explain them, but it cannot invent or alter probabilities.

## Product boundary

The production product covers Premier League pre-match forecasts:

- 1X2 probabilities
- model expected goals
- over/under totals
- both teams to score
- double chance and draw-no-bet
- team totals
- exact-score distribution
- immutable forecast timeline
- match-scoped explanations and audit metadata

Other material is deliberately separated:

- The shadow model is an experimental challenger and is never served as production.
- World Cup pages are a historical research archive, not Premier League production evidence.
- Big Five league pages outside the Premier League are completed-match history only.
- Bookmaker observations are stored as an external observational data track and never enter the production forecasting model.

## Probability source of truth

```text
cutoff-safe football inputs
→ walk-forward Elo state
→ frozen home/away goal expectations + Dixon-Coles rho
→ normalized score matrix
→ 1X2 / totals / BTTS / DNB / team totals / exact scores
→ immutable production snapshot
→ Match Room and deterministic Match Agent tools
```

Every displayed numerical market is derived from the same score distribution. React components do not recompute forecasting math.

## Immutable production stages

```text
PRESEASON
→ EARLY (legacy initial freeze)
→ T7D (deterministic rolling-early refresh)
→ T24H
→ T2H
→ T60M
→ FINAL_PREKICK
```

The forward scheduler follows these rules:

- a snapshot is first-write-wins and never overwritten;
- every freeze records its cutoff, generation time, model version, stage, and provenance;
- T7D may use a published default, provisional, or confirmed kickoff;
- T24H and later require a confirmed kickoff;
- stage windows begin at their canonical cutoff and have a bounded post-cutoff execution grace period;
- only inputs available at or before the cutoff may enter a snapshot;
- a stage first discovered after its cutoff is recorded as missed rather than backfilled;
- retries are idempotent;
- production, shadow, and reconstruction identities remain isolated.

## Canonical ledger metrics

All public count surfaces use one implementation in `lib/competitions/premier-league/ledger-metrics.ts`.

The contract explicitly separates:

- `totalForecastSnapshots`: immutable forecast artifacts;
- `settledForecastSnapshots`: snapshot-level settlement records;
- `uniqueFixturesSettled`: match outcomes deduplicated across stages;
- `committedForecastSnapshots`: rows in the bundled immutable production tape;
- `operationalForecastSnapshots`: durable forward snapshots outside that tape;
- production, shadow, and all-track scopes.

A settlement record is not a settlement operation. The application does not infer an operation-event count from snapshot-level settlement rows.

## Main routes

| Route | Purpose |
| --- | --- |
| `/` | Upcoming Premier League forecasts |
| `/match/[matchId]` | Match Room, forecast timeline, audit, and scoped Agent |
| `/accuracy` | Track Record with production, shadow, and reconstruction evidence separated |
| `/live` | Premier League production ledger |
| `/live/fixture/[id]` | Per-fixture stage and scheduler record |
| `/health` | Production operations and canonical ledger health |
| `/shadow` | Experimental paired shadow evaluation |
| `/matches` | Completed-match historical ledgers |
| `/market` | Observational market-data status; never a production model input |
| `/research/world-cup` | Isolated World Cup research archive |

Relevant JSON APIs:

- `GET /api/live`
- `GET /api/live/fixture/:id`
- `GET /api/accuracy`
- `GET /api/health`
- `GET /api/shadow`
- `GET /api/matches/upcoming`
- `GET /api/matches/:matchId/intelligence`
- `POST /api/matches/:matchId/agent`

## Local development

Requirements:

- Node.js 20+
- npm

```bash
npm install
npm run dev
```

Open `http://localhost:3000` locally.

The deterministic forecast and research paths run without paid model keys. Durable serverless operations require the configured production store; see `.env.example` and `docs/OPS_BACKUP_AND_RESTORE.md`.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The regression suites cover:

- score-distribution invariants;
- temporal cutoffs and rating-event availability;
- first-write-wins snapshot immutability;
- scheduler window determinism, missed stages, restart recovery, and idempotency;
- production/shadow/reconstruction isolation;
- settlement replay behavior;
- canonical snapshot-versus-fixture ledger metrics;
- Match Room selection of the latest valid production snapshot;
- privacy, request bounds, and production hardening.

The committed Premier League LIVE_OOS tape is append-protected and hash-gated by the test suite.

## Deployment and operations

The app is deployed on Vercel. The scheduled operations endpoint is authenticated and persists its state through the configured durable backend in production.

`vercel.json` contains the hosted cron entry points. The external operations worker may also call `/api/ops/tick` at the configured cadence. Health is exposed at `/health` and `/api/health`.

Never place secrets in committed files. Use `.env.local` for local development and Vercel environment variables for deployments.

## Privacy

Anonymous prompts, answers, follow-up context, and identifiers are not publicly enumerable. Storage is operational infrastructure, not a consumer-facing memory feed. The compatibility route `/memory` presents storage and privacy status only.

## Research history

The original World Cup agent and hackathon material remains available as an archived research track. It does not define the current production product or its evidence claims. Historical context is retained in `DEVPOST.md` and the World Cup-specific modules.

## License

MIT — see `LICENSE`.
