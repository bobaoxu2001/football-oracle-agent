# Big Five match ledger — design

The canonical, auditable record of completed 2026-27 matches across the
Premier League, La Liga, Bundesliga, Serie A and Ligue 1.

Its purpose is a trustworthy sequence, not a better model:

```
predict → freeze → play → observe → settle → learn → predict next match
```

## Layering

Each layer may only read the one above it. Nothing skips a layer, and no API
response object ever reaches model code.

```
RAW PROVIDER OBSERVATION    MatchObservation — append-only, keeps the payload
        ↓                   lib/match-ledger/providers/football-data.ts
CANONICAL MATCH DATA        CanonicalMatch — deterministic fold of observations
        ↓                   lib/match-ledger/materialize.ts
TEMPORAL FEATURE STORE      asOf-filtered; the leakage rule lives here
        ↓                   lib/match-ledger/features.ts
RESEARCH FORECAST           big-five-research-v0.1.0 — labeled prior, not production
        ↓                   lib/competitions/big-five/research-forecast.ts
PRODUCTION MODEL            pl-live-v0.2.0 — Premier League only; does not read this ledger
```

## What was reused, not rebuilt

| Need | Existing abstraction reused |
| --- | --- |
| Competition differences | `CompetitionConfig` + `lib/competitions/registry.ts` |
| Provider | `FOOTBALL_DATA_API_KEY`, already used by PL live ops |
| Team identity (PL) | `lib/competitions/premier-league/clubs.ts` |
| Fixture identity (PL) | `officialFixtureId` format — the ledger id is byte-identical |
| Settlement | `settleFixture` / `persistSettlement` (Phase 2A) |
| Snapshot immutability | `lib/snapshots/store.ts` |
| Scheduling + concurrency | the existing ops tick and its Mongo 90s lease |
| Persistence shape | the Phase 2B0 market recorder's isolated-store pattern |
| Early-season shrinkage | `rating-core.earlySeasonKScale`'s 8-match policy |

No second scheduler, no second settlement pipeline, no second vendor.

## Identity

**Teams.** A slug is assigned once, on first sight of a provider team id, and
never changes. Providers rename clubs; deriving a slug from the current name on
every ingest would fork one club into two and silently break form, identity and
settlement. Premier League slugs defer to the curated club registry so the
ledger, the frozen tape, ratings and settlement all speak one identity.

**Matches.** `{code}-{season}-{homeSlug}-{awaySlug}`, e.g.
`pl-2026-27-arsenal-coventry`. Provider-independent, and for the Premier League
identical to the existing fixture id — which is what lets a ledger match settle
an existing frozen snapshot.

## Idempotency

An observation's id is a hash of its **content** (status, half-time and
full-time score, kickoff, matchday, provider match id) — not of the time we saw
it. Therefore:

- re-observing identical data yields the same id and is skipped;
- a genuine score change yields a new id, is appended, and is detected as a
  `MatchCorrection` against the earlier value;
- `providerUpdatedAt` is deliberately excluded, so a provider republishing
  unchanged data does not mint a new row.

`resultObservedAt` records when a final score was **first** known and does not
drift when a provider restates it. That instant is what the feature layer uses.

## The leakage rule

A completed match may inform a prediction only when both hold:

```
resultObservedAt <= asOf      we actually knew it
kickoffUtc       <  asOf      it had actually been played
```

The second is redundant in live operation and kept anyway, so a clock error, a
backfill, or a mis-stamped observation cannot make a future match look like
history. The match being predicted is additionally excluded by id, so the
invariant holds even when features are recomputed after full time — exactly when
a leak would otherwise be invisible.

Enforced in one place: `admissibleMatches()`. Every feature reads through it.

## Early-season shrinkage

```
w(n) = n / (n + k),   k = PRIOR_MATCH_EQUIVALENT = 8
blended = w(n)·currentSeason + (1 − w(n))·prior
```

`k = 8` is inherited from the model's existing early-season policy rather than
invented, so the feature layer and the rating layer agree on when a season is
"established".

| matches played | weight on current season |
| --- | --- |
| 0 | 0.0% |
| 1 | 11.1% |
| 5 | 38.5% |
| 8 | 50.0% |
| 19 | 70.4% |
| 38 | 82.6% |

One opening-weekend 3-0 moves the blend by about a ninth — not to a posterior
that expects the same team to win everything.

## Null discipline

`null` means "this source did not supply the value" and is never
interchangeable with `0`. A goalless match stores `0`; a match whose provider
publishes no shot data stores `null`. Aggregations skip nulls rather than
coercing them, so a sum of unavailable statistics stays `null`, not `0`.

## Source capability

`FOOTBALL_DATA_CAPABILITY` records exactly what the configured plan supplies and
what it does not. The UI and the API read it so an absent statistic is shown as
unavailable rather than rendered as zero. See the phase report for the audited
field list.

## Operations

The ledger runs inside the existing ops tick, after the forecast lease is
released, under the same isolation contract as the market recorder: it cannot
fail a forecast tick. Its own cadence gate (`MATCH_LEDGER_INTERVAL_MS`, default
30 minutes) keeps provider usage proportionate without a second scheduler.

Manual runs:

```bash
npm run ledger:dry-run   # report provider state, write nothing
npm run ledger:backfill  # ingest + settle
```

The 2026-27 file tape under `data/processed/big-five/` is tracked so research
forecasts work from a clone. Re-ingest is idempotent. Deployed production still
accumulates into Mongo when that backend is selected.
