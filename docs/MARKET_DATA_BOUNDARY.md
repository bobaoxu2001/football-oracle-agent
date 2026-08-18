# Market data boundary

Phase 2B0 observational policy. This is a leakage boundary, not a product pitch.

## Rules

1. Market data cannot enter `pl-live-v0.2.0` features. `PRODUCTION_TRACK.features.liveMarketOdds` remains `false`.
2. Market data cannot tune team ratings during the live season.
3. Market data cannot alter prediction probabilities, lambdas, HA, ρ, shrink, or the Championship promoted gap.
4. Market/model comparison uses timestamp-safe joins only: for a model snapshot with `asOf = T`, the comparable market state is the latest valid observation with `retrievedAt <= T`. Never a later print.
5. Match results cannot rewrite earlier market snapshots. Observations are append-only / first-write-wins.
6. `HISTORICAL_PROVIDER` data is a separate origin and must never be mixed with `LIVE_RECORDED` in production evidence.
7. No after-the-fact backfill is presented as live evidence. The recorder starts at first successful production poll time.

## Closing market definition (frozen prospectively)

```text
ClosingMarketSnapshot =
  latest valid LIVE_RECORDED pre-match consensus observation
  with retrievedAt strictly before kickoffUtc
```

In-play and post-kickoff prints are out of scope for Phase 2B0 and are never closing prices.

This definition is frozen before any 2026-27 result is known. Do not change it after seeing outcomes.

## Language

Use: market consensus, market-implied fair probability, de-vigged consensus.

Never: true probability, correct probability, edge, best bet, stake.

## Isolation

A market outage, quota squeeze, or mapping failure must not block forecast ticks, settlement, or rating updates.
