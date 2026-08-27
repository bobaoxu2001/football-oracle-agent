# Phase 4A point-in-time replay readiness

## Verdict

`HISTORICAL BACKTEST NOT YET ADMISSIBLE`

The repository contains a useful chronological, date-strict Premier League research benchmark, but it does not contain the historical observation tape needed to prove what was knowable at each forecast cutoff. The strict historical cohort is therefore **0 fixtures**. No historical model-performance headline may be derived from the PIT replay path.

This does not invalidate the separately recorded `LIVE_OOS` production tape. Historical replay and live forward testing are different evidence classes and must never share a ledger.

## Historical data inventory

| Input | Historical coverage | PIT timestamp | Immutable? | Classification | Backtest usable? |
| --- | ---: | --- | --- | --- | --- |
| Premier League final scores as evaluation labels / date-strict research rows | 3,040 completed E0 fixtures, 2018-19 through 2025-26 | No row-level first-known timestamp; only a later document-level import time | Current raw files are Git-addressable, but no observation-version history exists | `RECONSTRUCTABLE_FROM_IMMUTABLE_RAW` | Outcome labels and date-strict research only; not strict forecast inputs |
| Championship final scores as date-strict research rows | 3,964 completed E1 fixtures, 2018-19 through 2025-26 | No row-level first-known timestamp | Current raw files are Git-addressable, but no observation-version history exists | `RECONSTRUCTABLE_FROM_IMMUTABLE_RAW` | Date-strict research only; not strict forecast inputs |
| Historical result publication, first-observed and correction tape required for rating updates | None for the historical seasons | Missing | No | `UNAVAILABLE_HISTORICALLY` | No |
| Final historical kickoff time | Raw CSV coverage from 2019-20 onward; all 380 nominal held-out rows contain `Time` | Event time exists, but historical retrieval time, source timezone semantics and revision history do not | Final raw snapshot only | `RECONSTRUCTABLE_FROM_IMMUTABLE_RAW` | Not sufficient for stage replay |
| Kickoff-as-known and reschedule observation tape | Prospective 2026-27 architecture only | Missing for 2018-19 through 2025-26 | No historical versions | `UNAVAILABLE_HISTORICALLY` | No |
| Season membership as known before a season | Derivable from the final full-season file | No publication/retrieval timestamp | Derived from final state | `NOT_PIT_SAFE` | No |
| Frozen home advantage, Dixon-Coles rho, K and goal mapping | Training ends 2025-05-31 | Training boundary is recorded | Git-versioned model artifact | `VERIFIED_PIT` | Yes, as a frozen transform |
| Season-initialization coefficients | Fit through the 2024-25 transition; held-out 2025-26 excluded | Training boundary is recorded | Git-versioned model artifact | `VERIFIED_PIT` | Yes, as a frozen transform |
| 2026-27 official fixture observations | Prospective current season | `retrievedAt` and source identity are stored | Append-only revisions are supported | `VERIFIED_PIT` | Future cohorts only |
| 2026-27 result observations and verification state | Prospective current season | Result observations carry `retrievedAt`; verification carries `updatedAt/verifiedAt` | No: observations are compacted to latest fixture/source state and verifications are upserted | `NOT_PIT_SAFE` for later replay | Current settlement only; preserve a new immutable observation tape for future replay |
| 2026-27 rating-event tape | Prospective current season | Kickoff and immutable `appliedAt` are stored; upstream result-observation time/source ID is not copied into the event | Append-only/deduplicated event identities | `VERIFIED_PIT` for internal rating-state timing | Forward rating-state reconstruction; add upstream source lineage before future replay claims |
| Historical standings, form and goal aggregates | Not required by the current champion; historical observation versions absent | Missing | No historical tape | `NOT_PIT_SAFE` | Exclude if enabled |
| Injuries, lineups, transfers and manager state | Not used by the Premier League champion | Missing | No historical tape | `UNAVAILABLE_HISTORICALLY` | Exclude |
| Shot-based xG and detailed performance data | Not used and not provided by the current source tier | Missing | No | `UNAVAILABLE_HISTORICALLY` | Exclude |
| Market odds | Some source CSVs contain odds columns, but the importer and model deliberately discard them | No admissible availability tape | Not applicable | `NOT_PIT_SAFE` | Forbidden in Phase 4A |

The classifications describe source capability, not model quality. A final outcome can be reconstructed as a scoring label without proving when that result first became available as a model input. `RECONSTRUCTABLE_FROM_IMMUTABLE_RAW` enters the replay scaffold only when the exact record can also be tied to a valid pre-cutoff `availableAt`; the current historical result rows cannot satisfy that input condition.

## Maximum legitimate cohort

| Cohort | Fixtures |
| --- | ---: |
| Historical Premier League pool | 3,040 |
| Frozen-model training period through 2024-25 | 2,660 |
| Nominal 2025-26 held-out candidates | 380 |
| Fully PIT-valid historical fixtures | **0** |
| Partially reconstructable fixtures | 380 |
| Rejected from strict PIT evidence | 380 |

Rejection reasons overlap because each candidate must pass every gate:

| Rejection reason | Fixtures |
| --- | ---: |
| Missing result first-observed / `availableAt` history | 380 |
| Missing kickoff-as-known and reschedule history | 380 |
| Missing PIT season-membership snapshot | 380 |
| Missing per-fixture lineage with source IDs, availability, feature version and code version | 380 |
| Sealed production-equivalent replay predictor unavailable | 380 |

## Replay boundary implemented for future admissible tapes

`lib/evaluation/pit-replay.ts` is a pure, store-free **admission scaffold** for a future replay engine. It accepts fixture identity, forecast stage, historical cutoff, kickoff-as-known, model version, feature version, code version and the real replay execution time. Because the admissible historical cohort is currently N=0, it is not wired to the production model as a headline backtest engine.

For every candidate input it requires:

```text
input.availableAt <= cutoffAt
immutable source identity + verified canonical payload SHA-256
classification in {VERIFIED_PIT, RECONSTRUCTABLE_FROM_IMMUTABLE_RAW}
```

It fails closed when a required input kind is missing, mutable, unversioned, unsafe or ambiguous. Post-cutoff rows are excluded before prediction. Conflicting duplicate identities fail closed. Timed-stage cutoffs are checked against the same deterministic production windows. The latest admissible fixture observation is bound to `kickoffAtAsKnown`; older revisions are superseded and later revisions are ignored. The frozen model bundle must match the requested model/feature versions and have a training cutoff strictly before the forecast cutoff.

The callback receives only a deep-frozen admitted slice, and the returned artifact is deep-frozen after hashing. A callback can still close over external state in JavaScript, so any future executable predictor must be separately sealed/audited to prove that it has no current/latest-state lookup. The scaffold alone is not presented as a completed replay engine.

The production-time invariant remains:

```text
max(input.availableAt) <= cutoffAt <= generatedAt < kickoffAt
```

A retrospective replay may execute after the match. It therefore retains `replayExecutedAt` separately from the historical `cutoffAt` and `kickoffAtAsKnown`; it never represents execution time as a historical issuance time.

Every returned artifact is fixed to:

```text
track = HISTORICAL_REPLAY
```

The module has no production-ledger dependency or persistence path. Its replay key is derived deterministically from the fixture, stage, cutoff, kickoff-as-known, frozen version identities and sorted immutable input lineage, including canonical payload hashes. `replayExecutedAt` is deliberately excluded from the forecast identity. A regression compares the production ledger before and after repeated scaffold execution.

## Leakage audit

| Risk | Finding | Enforcement |
| --- | --- | --- |
| Future match result | Historical result availability cannot be proven | Strict cohort rejected; post-cutoff rows excluded by the replay boundary |
| End-of-season/current standings | Current champion does not consume standings; final season membership is still a current-state derivation | Standings excluded; membership tape required before any strict replay |
| Target match in team form | Current champion uses sequential ratings, not a separate form feature | Rating events must have both match completion and `appliedAt` no later than cutoff |
| Final season aggregates | Not consumed by the current champion | Any future aggregate must carry its own immutable `availableAt` and cumulative as-of lineage |
| Historical injuries | No proven tape and not consumed | Excluded |
| Final lineups for EARLY/T24H | No proven tape and not consumed | Excluded; adversarial test proves a post-cutoff lineup cannot enter prediction |
| Retroactively changed kickoff | Historical revision tape unavailable | Strict cohort rejected; replay freezes `kickoffAtAsKnown` from the admitted fixture observation |
| Current manager/team metadata | Not consumed by the current champion | Current-state joins forbidden by the replay interface |
| Full-dataset transforms | Frozen model parameters stop before the nominal test season | Model and feature version are required inputs; training bundle must predate the cutoff |
| Latest/current database queries | Admission scaffold is store-free, but an arbitrary callback could still close over external state | Caller supplies an immutable observation tape; a future executable predictor must be sealed and audited before any performance run |
| Stage pseudo-replication | Multiple snapshots from one fixture are correlated | Independent N is fixture count; aggregate inference must use one predetermined stage or fixture-clustered resampling |
| Production/replay mixing | Historical rows could otherwise resemble forecasts | Track is hard-coded to `HISTORICAL_REPLAY`; no production write API exists |

Negative controls cover future results, standings and lineups; post-cutoff and pre-cutoff reschedules; same-time fixture conflicts; stage/cutoff mismatch; missing or timezone-ambiguous availability; mutable and unsafe input; stale content hashes; future-trained or version-mismatched model bundles; duplicate conflicts; deterministic identity; input/artifact mutation; invalid probabilities; and production-ledger isolation.

## Existing historical research artifact

The committed 2025-26 result remains reproducible only under this label:

`DATE-STRICT RESEARCH BENCHMARK — NOT VERIFIED PIT REPLAY`

It evaluates 380 fixtures chronologically, predicts every calendar date before applying that date's results, and uses parameters trained before the held-out season. It does **not** prove historical first-known timestamps, schedule revisions, PIT membership, exact production-track parity or full per-fixture lineage. It evaluates `pl-baseline-v0.1.0`, not the exact `pl-live-v0.2.0` path.

The legacy numbers may be discussed as research context only:

| Research model | Fixtures | Log Loss | Brier | RPS | Accuracy |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uniform | 380 | 1.0986 | 0.6667 | 0.2322 | 27.4% |
| Elo + home advantage | 380 | 1.0309 | 0.6201 | 0.2098 | 48.2% |
| Baseline Dixon-Coles | 380 | 1.0281 | 0.6187 | 0.2095 | 48.2% |

`npm run backtest:pl` now runs the strict readiness audit and returns the inadmissible verdict without performance metrics. Reproduction of the frozen research artifact requires the deliberately explicit `npm run backtest:pl:legacy` command.

## Minimum prospective data-collection plan

1. Append every fixture schedule observation and revision with source record ID, `availableAt/retrievedAt`, kickoff, timezone semantics and raw content hash.
2. Replace latest-only result compaction for replay evidence with an append-only result/correction observation tape carrying first-known time, provider update time, raw content hash and verification status.
3. Freeze a pre-season membership snapshot before each evaluation season.
4. Freeze a model bundle before evaluation with parameters, training cutoff, feature version, source hashes and code commit.
5. Continue the immutable rating-event tape, enforcing match completion and `appliedAt <= cutoffAt`.
6. Persist replay artifacts only in an isolated historical-replay store, with deterministic identity and full lineage.
7. Score one predetermined snapshot per fixture for headline evidence, and cluster any multi-stage interval by fixture.
8. Keep injuries, lineups, current-state metadata and all market data excluded until an independently timestamped immutable tape exists and its use is separately authorized.

Until those records accumulate, the evidence boundary is:

```text
Live forward testing is valid.
Historical reconstruction is not.
```
