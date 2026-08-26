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
→ immutable cutoff-safe match-context reference (audit-only in the current champion)
→ frozen home/away goal expectations + Dixon-Coles rho
→ normalized score matrix
→ 1X2 / totals / BTTS / DNB / team totals / exact scores
→ immutable production snapshot
→ Match Room and deterministic Match Agent tools
```

Every displayed numerical market is derived from the same score distribution. React components do not recompute forecasting math.

## Time-safe match context (Phase 4B)

Every newly scheduled production stage also freezes a content-addressed match-context snapshot for the same fixture, kickoff, cutoff, and forecast identity. Evidence is admissible only when `availableAt <= cutoffAt`; each item separately records whether it was numerically used.

The current champion, `pl-live-v0.2.0`, has no validated player-impact or lineup transformation. It therefore forces all context evidence to `usedInForecast: false`, leaves probabilities unchanged, and fails closed if a context claims otherwise. Historical forecasts are never reconstructed from current news: older rows show `NOT_RECORDED`, while a broken reference shows `MISSING`.

The Match Room distinguishes the selected frozen context from the latest prospectively recorded context, compares only the exact legal snapshot pair, and avoids causal attribution. Player or tactical what-if requests return `UNSUPPORTED_SCENARIO` without a probability and never enter the LIVE_OOS ledger.

Public context responses expose hashed source-record references but omit raw provider URLs, whose paths may contain credentials or internal identifiers. Match Room answers are rendered from deterministic audited tools only; the champion has no generative narration path.

No structured Premier League injury or lineup provider is currently configured. Provider constraints and the proposed prospective-only adapter boundary are documented in `docs/PHASE4B_CONTEXT_SOURCE_AUDIT.md`.

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
Settlement integrity is explicitly scoped to `all-tracks`. A linked row must
agree with the immutable snapshot identity, stage, probabilities, realised
score/outcome, and recomputed Brier/RPS/LogLoss values; resolving the key alone
is not enough. Inconsistent linked rows and true orphans are reported separately.

### Snapshot evidence is not fixture evidence

A forecast snapshot is one immutable point-in-time prediction. A fixture is the
single realised sporting event and is the independent evaluation unit. Several
stages can settle against the same match result, so settled snapshot rows are
retained for trajectory diagnostics but never masquerade as independent matches.

Production headline scores select one deterministic latest valid pre-kickoff
snapshot per fixture. Stage headlines select one latest valid snapshot per
fixture within that stage. Additional rolling-stage rows stay in the immutable
timeline. Shadow headlines likewise select one latest valid same-cutoff pair per
fixture; paired snapshot rows remain separate diagnostics.

Evaluation maturity is centralized and based on unique fixtures:

- fewer than 20: `EARLY_EVIDENCE`;
- 20–49: `PROVISIONAL`, with deterministic fixture-bootstrap uncertainty;
- 50 or more: `EVALUATION_READY`.

`EVALUATION_READY` means only that a first formal evaluation is permitted. It
does not prove accuracy, does not promote a model, and does not imply market
edge. Below 20 fixtures, confidence intervals are withheld instead of being
estimated from correlated stage rows.

## Scoped production freshness

Freshness is stage-based, not a generic snapshot-age boolean. The canonical
policy reports separate scopes for scheduler liveness, fixture metadata sync,
fixture forecast-stage coverage, and the observational market recorder. A
healthy five-minute scheduler can therefore coexist truthfully with a fixture
whose historical T7D window was missed; the missed stage remains visible and is
never backfilled. An old baseline is still current before T7D is due, and a T7D
snapshot remains current until T24H opens regardless of arbitrary wall-clock
age.

Every freshness-bearing production route is `no-store`, so a newly written
stage cannot be hidden behind a stale Vercel edge response. `DATA_READY` remains
explicitly a structural season-data gate, not a temporal freshness claim.
`latestIncludedInputAt` is reported only from prospectively recorded source
availability timestamps (for example, a rating-event application or fixture
retrieval). It is never inferred from a rating cutoff or match kickoff.

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
- `POST /api/matches/:matchId/scenario` (deterministic fail-closed boundary)

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
- fixture-level maturity and equal-fixture cluster bootstrap gates;
- canonical scoped scheduler, sync, forecast-stage, and market-observer freshness;
- scheduler self-handoff, bounded failure recovery, and one-shot isolation;
- independent core/observer leases and multi-process observer contention;
- Match Room selection of the latest valid production snapshot;
- content-addressed context snapshots, future-evidence exclusion, and retry idempotency;
- exact forecast/context pairing and model-used versus informational-only evidence;
- fail-closed, non-persisted scenario responses;
- privacy, request bounds, and production hardening.

The committed Premier League LIVE_OOS tape is append-protected and hash-gated by the test suite.

## Deployment and operations

The app is deployed on Vercel. The scheduled operations endpoints are authenticated and persist state through the configured durable backend in production.

The external hosted worker calls `/api/ops/tick?core=1` for the forecast-critical
five-minute path. A scheduled event bootstraps a finite loop of at most 60
rounds. After a normal successful loop completes, a separate least-privilege
handoff job dispatches exactly one 60-round successor and records the parent run
ID in its title. The successor shares the loop concurrency group, so the
current run is never cancelled and at most one effective pending loop remains.
GitHub `schedule` is therefore a bootstrap/recovery safety net rather than the
only recurrence mechanism. The five-minute one-shot backup remains in its own
concurrency group and can never self-handoff.

Core and observer requests track independent consecutive failures. A successful
or lease-safe response resets its counter. Three consecutive forecast-core
failures terminate the loop and suppress handoff. Observer failures remain
visible as a separately scoped degradation but cannot stop forecast recurrence
or suppress a successor, because observational market/ledger polling is not a
production-model dependency. Attempts remain bounded to the loop's 60 rounds.
A shadow-freeze failure is likewise recorded only on the challenger lifecycle;
it cannot turn a successful production forecast tick into a production failure.
A recovered isolated provider failure remains visible but does not poison five
hours of later successful work. The handoff job
has `actions: write` but no `CRON_SECRET`; the tick job has the secret but cannot
dispatch Actions. Dispatch is preflighted by the exact parent marker, attempted
once without an ambiguous automatic retry, and disabled unless the repository
variable `OPS_HANDOFF_ENABLED=true` is present.

To stop the chain gracefully, set `OPS_HANDOFF_ENABLED=false`; the active loop
finishes without a successor. To stop all scheduling, then disable the workflow
and cancel any active/pending loop. GitHub may still disable scheduled workflows
in inactive public repositories, and a platform-wide Actions outage remains an
external limitation.

Production truth pages coalesce durable hydration and verify the bundle version
before reloading it. Ledger, health, freshness, Match Room, Track Record, and
Shadow truth surfaces are explicitly `no-store`. A cold reader fails visibly
when durable state cannot be verified; a production writer always fails closed
rather than flushing stale serverless state. Health is exposed at `/health` and
`/api/health`.

Never place secrets in committed files. Use `.env.local` for local development and Vercel environment variables for deployments.

## Privacy

Anonymous prompts, answers, follow-up context, and identifiers are not publicly enumerable. Storage is operational infrastructure, not a consumer-facing memory feed. The compatibility route `/memory` presents storage and privacy status only.

## Research history

The original World Cup agent and hackathon material remains available as an archived research track. It does not define the current production product or its evidence claims. Historical context is retained in `DEVPOST.md` and the World Cup-specific modules.

## License

MIT — see `LICENSE`.
