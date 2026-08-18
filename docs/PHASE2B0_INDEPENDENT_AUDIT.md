# Phase 2B0 Independent Market Recorder Audit

**Auditor:** independent verification (no production evidence modified; no commit; no 2B1)
**Window:** 2026-08-17T23:27:35Z → 2026-08-18T01:07:03Z
**Production:** https://football-oracle-agent.vercel.app · `dpl_8uow1jKx9U7Q3bK5C8gjxNaezUpZ`
**Local HEAD:** `1740d96b559437cce2ccf77da76d3509af15d981` plus uncommitted 2B0 working tree

Builder reports were treated as claims until reproduced.

---

# 1. Verdict

```text
PASS WITH MINOR NON-BLOCKING ISSUES — READY TO COMMIT
```

Football Oracle is collecting a genuinely prospective, immutable, timestamp-safe bookmaker 1X2 record. The forecasting model is not on that path. Six months from now these rows can be joined to later model stages without wondering whether timestamps, odds, mappings, retries, or model contamination invalidated the experiment — provided PRESEASON/EARLY snapshots are left unpaired (they predate the first print).

Do not run another Phase 2B0 audit. Commit the exact audited 2B0 tree identified below. Then Phase 2B0 schema/recorder v0.1 is closed. Phase 2B1 may start after that commit.

---

# 2. Audit-start vs audit-end production snapshot

| Field | 23:27:35Z start | 01:07:03Z end |
| --- | --- | --- |
| Forecast | HEALTHY · lastTick `23:24:58Z` | HEALTHY · lastTick `01:05:02Z` |
| Market | HEALTHY | HEALTHY |
| firstMarketObservationAt | `2026-08-17T16:34:00.487Z` | **same** |
| lastSuccessAt | `22:46:42.067Z` | `01:05:05.898Z` |
| observations | 1461 | **1877** |
| consensus | 70 | **90** |
| quota remaining / used / last | 492 / 8 / 1 | 490 / 10 / 1 |
| next poll | `23:46:42.067Z` | `02:05:05.898Z` |
| cadence | 3600000 ms | 3600000 ms |
| LIVE_OOS | 380 / 365 / 15 / timed 0 | unchanged |

This window is the autonomy proof: this machine did not call a market poll route. Hosted schedule run `32086916845` (`event=schedule`, started `01:04:56Z`) lines up with forecast tick `01:05:02Z` and market success `01:05:05Z`.

---

# GATE 1 — Production market source

**PASS**

Code (`the-odds-api.ts`) and stored rows agree:

| Setting | Code | Stored rows |
| --- | --- | --- |
| Provider | `the-odds-api` / api.the-odds-api.com v4 | `source = the-odds-api` |
| Sport | `soccer_epl` | all events mapped from that sport key |
| Region | `uk` | `sourceRegion = uk` |
| Market | `h2h` | `marketType = h2h` |
| Odds | `oddsFormat=decimal` | all sampled decimals > 1 |

Vercel Production lists `ODDS_API_KEY` Encrypted (value not read). Stored quota `lastRequestCost=1` matches one-region one-market cost. Every sampled row has `bookmakerLastUpdate`. Draw is present on stored H/D/A triples.

---

# GATE 2 — First evidence immutability

**IMMUTABLE**

Earliest LIVE_RECORDED observation (also the first Betfair Sportsbook Arsenal–Coventry row):

| Field | Value |
| --- | --- |
| observationId | `the-odds-api::eb2553d10d63dc912b99f8fd0d675721::betfair_sb_uk::h2h::market-poll::2026-08-17T16:34:00.487Z::1781c64c` |
| fixture | `pl-2026-27-arsenal-coventry` |
| bookmaker | `betfair_sb_uk` / Betfair Sportsbook |
| odds | **1.15 / 7.50 / 15.00** |
| retrievedAt | `2026-08-17T16:34:00.487Z` |
| bookmakerLastUpdate | `2026-08-17T16:33:30Z` |
| schema | `market-recorder-v0.1.0` |
| origin | `LIVE_RECORDED` |
| pollJobId | `market-poll::2026-08-17T16:34:00.487Z::1781c64c` |

That document still exists after ≥9 successful polls. Re-insert of the same `observationId` returns `duplicate`. `firstMarketObservationAt` is unchanged at audit end.

---

# GATE 3 — Heartbeat semantics

**PASS**

Same Betfair 1.15 / 7.50 / 15.00 appears on **seven** documents with distinct `retrievedAt` and distinct `pollJobId` (16:34 through 22:46). That is a later observation of an unchanged price, not a retry duplicate.

Retry of the **same** observationId is first-write-wins (`duplicate`).

Identity is `source::sourceEventId::bookmaker::h2h::pollJobId`.

---

# GATE 4 — Poll counts

Independently counted in Mongo at ~23:32Z (before the audit-end poll):

| Object | Count |
| --- | ---: |
| SUCCEEDED polls | 7 |
| SKIPPED jobs (pre-key) | 2 |
| market_poll_jobs | 9 |
| market_observations | 1461 |
| market_consensus | 70 |
| market_event_maps | 10 |

First job: **209 observations + 10 consensus**. Reconciliation: `209×5 + 208×2 = 1461`; `10×7 = 70`.

Audit-end health (after two more hosted polls): observations **1877**, consensus **90** (`+416` ≈ `208×2`, `+20` consensus). First timestamp still 16:34:00.487Z.

---

# GATE 5 — Collection architecture

**PASS**

Dedicated collections: `market_observations`, `market_consensus`, `market_event_maps`, `market_poll_jobs`, `market_state`.

`pl_ops_bundle` keys: jobs, sourceObservations, scheduleRevisions, resultObservations, resultVerifications, ratingEvents, ratingState, tickState, settlementCorrections, operationalLiveOos, settlements, workingSnapshots, fixturesOverlay. **No market keys.**

Indexes include unique `observationId` / `consensusId` and `fixtureId+retrievedAt`. Growth is one document per observation — horizontal, not a mega-document.

---

# GATE 6 — Raw bookmaker evidence

**PASS**

Random sample of 12 production rows (11 books, 7 fixtures): all required fields present (`source`, `sourceEventId`, `canonicalFixtureId`, `bookmakerKey`, `bookmakerName`, `marketType`, `retrievedAt`, `bookmakerLastUpdate`, `commenceTime`, decimal H/D/A, `origin`, `marketSchemaVersion`, `pollJobId`). Consensus is a separate collection.

---

# GATE 7 — H/D/A mapping

**PASS · 0 inversions**

Code maps by outcome name (`extractH2hOdds`), never index. Isolated test: Away/Draw/Home order still normalizes. Production Betfair sample: Home=Arsenal 1.15, Draw=7.50, Away=Coventry 15.00. Isolated `mapMarketEvent` + stored mapping agree on canonical fixture, not provider event id.

---

# GATE 8 — Real odds math

**PASS**

12 sampled production rows: independent `1/odds` → overround → proportional-v1 matches stored `rawImplied*`, `overround`, `bookmakerMargin`, `fair*` within 1e-12. `devigMethod = proportional-v1`. Fair triples sum to 1. First-poll consensus set (10 fixtures) also 0 math failures on their bookmaker rows.

---

# GATE 9 — Consensus reproduction

**PASS**

All 10 first-poll consensus documents independently recomputed as median of that poll’s bookmaker fair H/D/A, then renormalized: **0 delta**, `bookmakerCount` matches row count, method `median-fair-v1`. Derived only.

---

# GATE 10 — Fixture mapping

**PASS**

Production maps: **MATCHED 10 / AMBIGUOUS 0 / UNMATCHED 0 / CONFLICT 0**.

Arsenal–Coventry: provider `eb2553d10d63dc912b99f8fd0d675721` → `pl-2026-27-arsenal-coventry` via Arsenal / Coventry City and commence `2026-08-21T19:00:00Z`. Canonical id is not the provider id.

---

# GATE 11 — Reschedule mapping

**PASS** (isolated)

`test-phase2b0`: same `sourceEventId` with commence moved to the next day keeps `pl-2026-27-arsenal-coventry`. Unknown teams stay UNMATCHED and write no observation.

---

# GATE 12 — No historical backfill

**PASS**

All observation origins: `LIVE_RECORDED` only. `retrievedAt` min = `2026-08-17T16:34:00.487Z` (not before the recorder existed). No Aug-16 timestamps.

---

# GATE 13 — No-lookahead

**PASS** (hard gate)

Isolated: markets 10:00/11:00/12:00, model 11:30 → **11:00**.

Frozen EARLY Arsenal–Coventry `asOf = 2026-08-16T05:33:34.616Z` → **`marketAtModelAsOf = NONE`**. Correct. Do not repair.

---

# GATE 14 — Closing rule

**PASS**

Code and `docs/MARKET_DATA_BOUNDARY.md`: latest LIVE_RECORDED consensus with `retrievedAt` **strictly before** kickoff. Isolated: 14:40/14:50/14:58/15:01 vs 15:00 → **14:58**. No CLV computed.

---

# GATE 15 — Pre-match only

**PASS**

Recorder skips a mapped fixture when `kickoffUtc <= now`. Sampled production rows: **0** with `retrievedAt >= commenceTime`. Closing helpers also require `retrievedAt < kickoff`.

---

# GATE 16 — Polling policy

**PASS**

Implemented ladder matches the spec, plus documented quota floors. Time to `2026-08-21T19:00:00Z` at audit time is ~3–4 days → 1 hour. Production `currentCadenceMs = 3600000`. Observed gaps ~61–79 minutes (GitHub jitter). Acceptable.

---

# GATE 17 — Quota

**PASS**

Audit-end: remaining **490**, used **10**, last cost **1**. Floors at 200 / 80 / 20 remaining reduce cadence and can mark market DEGRADED; they do not stop forecast ticks.

---

# GATE 18 — Failure isolation

**PASS**

- `runGuardedLiveOpsTick` releases the 90s forecast lease **before** market work.
- Market errors are caught and logged; the tick result is already flushed.
- Isolated outage: market job FAILED; forecast health still a known state; tape untouched.
- Unmatched events write 0 observations.
- `skipNetwork` ticks never call the odds API.

Mongo market write failure is not a dedicated suite, but it sits in the same post-lease try/catch. Not a blocker.

---

# GATE 19 — Model independence

**PASS** (hard gate)

`league-engine.ts` does not import `market/*`. Market is only imported from market UI/API, health (sidecar), tick (after lease), and tests.

Regenerated EARLY Arsenal–Coventry after real market data: H/D/A **identical to the frozen tape**, λ present, ratings Arsenal 1770.72, HA 72, ρ −0.061, `pl-live-v0.2.0`. Isolated extreme odds (1.01/50/80) also left probabilities/ratings unchanged (`test-phase2b0` 44/44).

---

# GATE 20 — Forecast tape

**PASS**

Before and after this audit:

| | Required | Measured |
| --- | --- | --- |
| Lines | 380 | 380 |
| MD5 | `34f7ca54025a3a48df9f1a169df66315` | match |
| SHA256 | `a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da` | match |

Byte-identical.

---

# GATE 21 — First observation survives later polls

**PASS**

`firstMarketObservationAt` still `2026-08-17T16:34:00.487Z` after the 01:05Z poll. First job still has 209 observations + 10 consensus. First Betfair prices unchanged. Later polls **added** rows.

---

# GATE 22 — Autonomous polling

**PASS**

See §2. No local market poll was invoked. Counts and `lastSuccessAt` advanced in lockstep with GitHub `schedule` runs.

---

# GATE 23 — Market health

**PASS**

`/api/market/health` and `/api/health.market` expose configured source, last/next poll, quota, observation/consensus counts, first print, bookmakers, matched fixture count. Forecast `overall` is independent (HEALTHY while market was previously UNCONFIGURED, and HEALTHY now).

Minor: `unmatched` and `ambiguous` on the health payload are hardcoded `0` rather than counted from `market_event_maps`. Currently all maps are MATCHED, so the numbers happen to be true. Non-blocking.

---

# GATE 24 — User-facing honesty

**PASS**

`/market` and `/api/market` contain no best-bet / Kelly / buy / sell / trade / recommended-bet / “true probability”. The words “edge” and “stake” appear only in “not an edge, a stake, or a recommendation.”

---

# GATE 25 — World Cup / forecast regression

**PASS**

routing 73 · track 24 · calibration 12 · tournament 52 · ratings · honesty · DC selftest · bracket top-5 37.3 / 30.9 / 15.3 / 7.0 / 2.4.

---

# GATE 26 — Working tree identity

Phase 2B0 is **not committed**. HEAD remains `1740d96`.

`git diff --stat` (all dirty tracked files, including leftover 2A remediations):

```text
.env.example                                       |   4 +
app/api/health/route.ts                            |   9 +-
app/health/page.tsx                                |  40 +
ops/durable-store.ts                               |  10 +
ops/fixture-sync.ts                                |  51 +
ops/result-feed.ts                                 |  22 +
ops/tick.ts                                        |  10 +
package.json                                       |   3 +-
scripts/test-phase2a-3.ts                          | 134 +
```

**Intended Phase 2B0 commit set including this audit document (27 files):**

```text
PHASE2B0_TREE_MANIFEST_SHA256
6aa7c6b4e2d3d3d91f595eae03d661015e156a85c8db41b79a1b2ed425e4e2ba
Files: 27
```

Pre-audit-doc 26-file hash (code + prior 2B0 docs only): `9814f23ea2b782fce40a63b03201c94905e869e1160a84e61658c5087679c77e`.

If this audit file is edited again, recompute the 27-file hash before commit.

Also dirty / untracked and **not** part of the 2B0 recorder tree (already-deployed 2A compact + 2A final report):

- `lib/.../ops/durable-store.ts`
- `lib/.../ops/fixture-sync.ts`
- `lib/.../ops/result-feed.ts`
- `scripts/test-phase2a-3.ts`
- `docs/PHASE2A_FINAL_PRODUCTION_VERIFICATION.md`

Commit 2B0 using the 2B0 manifest. Handle the 2A leftovers as a separate already-live remediation commit if desired. Do not mix them silently.

---

# GATE 27 — Evidence survives deploys

**PASS**

Market rows live in Atlas collections, not `/tmp` and not the git tree. Hydrate of `pl_ops_bundle` does not load or wipe market collections. `firstMarketObservationAt` is first-write on `market_state`. A later source deploy cannot reset history unless someone deletes those collections.

---

# 3. Blockers

None.

# 4. Non-blocking issues

1. Health `unmatched` / `ambiguous` are hardcoded zeros.
2. The Odds API currently lists the next 10 EPL events, not all 380.
3. Two polls wrote 208 instead of 209 bookmaker rows (one incomplete 1X2 omitted). First poll remains 209.
4. Poll spacing jitters with GitHub Actions (still ~hourly).
5. Uncommitted 2A compact files sit beside the 2B0 tree.

# 5. Next step

```text
COMMIT EXACT AUDITED TREE
```

Then: Phase 2B0 recorder v0.1 is closed. Phase 2B1 may begin.

---

## Appendix — 2B0 file manifest (pre-audit-doc)

```text
.env.example | 4495 | 866f4193432959c8e5340ce410ff8f63654cc0fff68962809f329db633321101 | M
app/api/health/route.ts | 890 | fb1f92fe42447af3db2407fd3a40f4dc47e0d89e39bc558e952c67215f152b38 | M
app/api/market/health/route.ts | 555 | 904ec9ba9c80a15873991348343834da91febaaea69655ca2908c8a94d9ccd3f | ??
app/api/market/route.ts | 2847 | dff3e3993353d589147d02796cc8273c6596797c81e746d5df89411ffde5a104 | ??
app/health/page.tsx | 10563 | 4e101a8af2e79bdabfadbe3ebdf79eb20e9e88d5ae9c054087c6017f99036c28 | M
app/market/page.tsx | 5974 | 25e2fe75a68b2dfdff507b9fd10bbb3a4e1f526d23cbd6a6c17cae6dc01d7e59 | ??
docs/MARKET_DATA_BOUNDARY.md | 1644 | 8ba8f455be9dbe41311e72a6b7f66885ee58a8578197e3f2551be982f6a85fe6 | ??
docs/PHASE2B0_INDEPENDENT_AUDIT.md | (this file) | recompute after any edit | ??
docs/PHASE2B0_1_FIRST_LIVE_MARKET_LOG.md | 3001 | 2851cf2b142508fe7b8658cccc9cd9702273af5e01d690dd5a7618828fab7886 | ??
docs/PHASE2B0_1_FIRST_LIVE_MARKET_REPORT.md | 6784 | 7346fa0685d6f979923ac8c558bacdb426e9b066f84b917b10362814602c1d79 | ??
docs/PHASE2B0_IMPLEMENTATION_LOG.md | 2648 | 94d260362dcc6223b3a3f9a86537de15d51fefb7c518469d65f9767c093213e8 | ??
docs/PHASE2B0_MARKET_RECORDER_REPORT.md | 6600 | 9d87b7dac1859da75e0686ab1a84a281e83f958631cfdc992a9e166ebd9fd2be | ??
lib/competitions/premier-league/market/alignment.ts | 2090 | e5c6b569bf5d525aa8620dcffa58cef0df2e35846391a553013f09251b519323 | ??
lib/competitions/premier-league/market/cadence.ts | 2845 | f8f16930bdd8833c33a731f60a6039954e42f16852a0619a421fce5fd3c712b2 | ??
lib/competitions/premier-league/market/consensus.ts | 1767 | 5b8212558c3d90413dcb11dc6125dce0dce517c75bbc363676adb3abacdce580 | ??
lib/competitions/premier-league/market/health.ts | 3501 | a10cb2545ed32c139c2cdb5c939d5822818f77611d42dadf6cc9c696a7edbb62 | ??
lib/competitions/premier-league/market/index.ts | 777 | 4692a6142ef440fd32e439bdea39b952c76e3eab803dea042039905b35e4676c | ??
lib/competitions/premier-league/market/mapping.ts | 3569 | b5f462f338e85d0138d62db7ead97e1a7fbfa0e25d09902fce072852d4a68891 | ??
lib/competitions/premier-league/market/odds-math.ts | 3194 | 6f460d8d4b5bc395d3ff07bb4e358a5c57a9a55b0a2248b8151acb4b75b2e1e1 | ??
lib/competitions/premier-league/market/recorder.ts | 10446 | 97ead3563dfe7b7c108a53e8ffa24cef266cc5110f126e5be6611ec84e1664c0 | ??
lib/competitions/premier-league/market/source.ts | 389 | 5ca6b3ac9070903efd15800308dbb8237aab67be233db998116b01ad11661c73 | ??
lib/competitions/premier-league/market/store.ts | 10303 | 029bf266adfe05e16222bb6892eae42f08d2bfc86dbc689a9e410d12db91586a | ??
lib/competitions/premier-league/market/the-odds-api.ts | 4906 | 309921fc908159fa6a547168b24278f923884be90a4071f5592477c623be525b | ??
lib/competitions/premier-league/market/types.ts | 4411 | 9ff03df73ee5e3614df5d6995b7ce6c3a8e7922bb826077e01f07e0b2a29a546 | ??
lib/competitions/premier-league/ops/tick.ts | 6883 | 3a8794281027d3a173545bfb4941a5234c42d26d3ae2848fc88889f7cbeb1245 | M
package.json | 4018 | 6b00d5de4ccc6d5f81cf95725e1108efec19b466adca5ad2d19215a5791c8ab5 | M
scripts/test-phase2b0.ts | 17402 | 62d4166c2fd4152cb6a6a9a27366533f64ecf099bd9acdc0242739c8025a2982 | ??
```

Note: the MARKET_DATA_BOUNDARY sha256 in this appendix must match the file on disk at commit time; if the appendix transcription of that one line is ever regenerated, hash the files, do not hash this paragraph.
