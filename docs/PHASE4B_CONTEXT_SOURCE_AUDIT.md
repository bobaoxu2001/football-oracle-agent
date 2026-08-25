# Phase 4B context-source audit

Audit date: 2026-08-25

## Production capability now

| Source | Production configuration | Time field | Usable for Phase 4B forecast context? |
| --- | --- | --- | --- |
| football-data.org v4 | Configured. The public capability contract reports `TIER_ONE`. | Provider `lastUpdated` plus Oracle retrieval time. | Fixtures/results only. The configured tier does not supply injuries or starting lineups. |
| API-Football / API-SPORTS | Client code exists for the archived World Cup path. `API_FOOTBALL_KEY` is not configured in Vercel. The client assumes World Cup league/team identities. | Retrieval time; source payload fixture date. | No. It cannot be silently reused for Premier League context. |
| Team-news providers | Optional NewsAPI, GNews, SerpAPI and Google CSE adapters exist for the archived national-team news path. No provider key is configured in Vercel. | Article publication time plus ingestion time. | Informational only even when configured. Keyword/LLM classification is not a verified player-status feed. |
| Odds recorder | Configured observational market benchmark. | Observation retrieval/computation time. | Never. Market data is explicitly excluded from context features and production probabilities. |

The current Premier League Match Intelligence response contains zero approved
news items and explicitly reports that timestamped availability is unsupported.
No repository source can currently defend a player-level numerical adjustment.

## Provider constraints

- football-data.org documents lineup expansion through `X-Unfold-Lineups`, but
  its pricing page places lineups/substitutions on Deep Data or higher plans.
  The configured production capability reports neither lineups nor injuries.
- API-Football documents fixture-scoped injuries/suspensions and confirmed
  lineups. Coverage must be checked per league-season; a coverage flag does not
  guarantee every fixture will have pre-kickoff data. Confirmed lineups are
  commonly published close to kickoff and may sometimes arrive only later.
- API-Football access is quota/rate limited. The source terms allow application
  use but require subscription/rate-limit compliance. Raw provider keys must
  remain server-side.

Official references:

- https://www.football-data.org/pricing
- https://docs.football-data.org/general/v4/policies.html
- https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide
- https://www.api-football.com/pricing
- https://www.api-football.com/terms

## Decision

Phase 4B ships the time-safe context contract, immutable content-addressed
snapshots, forecast references, known-at-cutoff semantics, exact context diffs,
and a fail-closed scenario boundary without changing `pl-live-v0.2.0` math.

No current article, injury, lineup or market row becomes a model input.
`usedInForecast` therefore remains `false` for every Phase 4B context item until
a separately validated challenger exists.

The smallest defensible future provider addition is a Premier League-specific
API-Football adapter using league `39` that:

1. verifies league-season coverage before polling;
2. maps provider fixture/team/player IDs to canonical Oracle IDs;
3. archives raw fixture-scoped injury and lineup observations append-only with
   both provider time and Oracle retrieval time;
4. treats the first Oracle-observed timestamp as `availableAt` when the provider
   does not supply a trustworthy publication timestamp;
5. freezes only observations with `availableAt <= cutoffAt`;
6. starts as informational context and later as a separately versioned shadow
   challenger only after a defensible player-contribution transformation exists.

This provider is identified, not activated. Production has no API-Football key,
and adding a key or paid plan is an external provisioning decision.
