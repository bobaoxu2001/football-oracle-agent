# Phase 2A release report — Football Oracle

**Date:** 2026-08-16  
**Verdict:** **PASS WITH LIMITATIONS**

Phase 2A replaced the synthetic 2025-26 field with a source-backed 2026-27 Premier League season and began the genuine `LIVE_OOS` ledger. The frozen Phase 1 benchmark was not retuned. World Cup suites remain green. Phase 2B (odds) was not implemented.

---

# 1. Verdict

**PASS WITH LIMITATIONS**

| Gate | Result |
| --- | --- |
| Real 2026-27 CompetitionSeason | PASS — 20 clubs, VERIFIED |
| Promotions / relegations | PASS — Coventry, Ipswich, Hull in; West Ham, Burnley, Wolves out |
| Official fixture ingest | PASS — 380 fixtures, complete schedule, idempotent |
| Timezone-safe kickoffs | PASS — Europe/London → UTC, DST tests |
| Prediction stage in snapshot identity | PASS |
| Explicit Benchmark vs Production tracks | PASS |
| New production model version | PASS — `pl-live-v0.2.0` |
| Season-aware honesty text | PASS |
| Genuine LIVE_OOS forecasts | PASS — 380 frozen before kickoff; 0 reconstructions |
| Title simulation on real remaining fixtures | PASS — 0 completed fixed, 380 remaining |
| Featured matchups are real upcoming fixtures | PASS |
| World Cup regression | PASS |
| Phase 2B / 2C / other leagues | PASS — not implemented |

Limitations are listed in §14. None hide a failed required gate.

---

# 2. Source State

| Item | Value |
| --- | --- |
| Start SHA | `7bc3f94e50dd172ba935bb2f99af80c366193bce` |
| End SHA | `301c8b89440cb7dc60512450efe55545324a78cf` |
| Frozen benchmark | `data/processed/premier-league/backtest-heldout.phase1-frozen.json` untouched |
| HA / ρ | **not recalibrated** (72 / −0.061) |
| World Cup | plugin preserved; Annex C 495/495; title 37.3 / 30.9 / 15.3 / 7.0 / 2.4 |

Principal files: `lib/competitions/premier-league/*` (ingest, fixture-store, data-gate, honesty, model-tracks, timezone, stages, settlement, live-ledger, live-loop), `lib/snapshots/*`, `lib/prediction-engine/league-engine.ts`, `lib/prediction-engine/season-init.ts`, `lib/agent/index.ts`, `components/premier-league/weekend-slate.tsx`, `app/live/page.tsx`, `data/processed/premier-league/season-2026-27.json`, `fixtures-2026-27.json`, `live-oos-2026-27.jsonl`.

---

# 3. 2026-27 Season Verification

| Field | Value |
| --- | --- |
| competition | premier-league |
| season | 2026-27 |
| start / end | 2026-08-21 → 2027-05-30 |
| club count | **20** |
| fixture count | **380** (complete) |
| verified source | Premier League official fixture release + official membership confirmation |
| cross-check | Wikipedia 2026–27 Premier League team list (same 20 clubs) |
| retrieved | 2026-08-16 |
| data status | **DATA_READY** / VERIFIED |

**Active clubs:** Arsenal, Aston Villa, AFC Bournemouth, Brentford, Brighton & Hove Albion, Chelsea, Coventry City, Crystal Palace, Everton, Fulham, Hull City, Ipswich Town, Leeds United, Liverpool, Manchester City, Manchester United, Newcastle United, Nottingham Forest, Sunderland, Tottenham Hotspur.

---

# 4. Promotion / Relegation Transition

From the ingested 2025-26 tape and the official 2026-27 membership:

| | Clubs |
| --- | --- |
| Continuing (17) | Arsenal, Aston Villa, Bournemouth, Brentford, Brighton, Chelsea, Crystal Palace, Everton, Fulham, Leeds, Liverpool, Manchester City, Manchester United, Newcastle, Nottingham Forest, Sunderland, Tottenham |
| Promoted (3) | **Coventry City**, **Ipswich Town**, **Hull City** |
| Relegated (3) | **West Ham United**, **Burnley**, **Wolverhampton Wanderers** |

Relegated clubs are not in the active `CompetitionSeason`. Each of the 20 has a `ClubSeason` with stable `clubId` = slug.

---

# 5. Season Initialization

| Path | Rule |
| --- | --- |
| Continuing | `elo' = 1600 + 0.75 × (elo − 1600)` |
| Promoted | Championship Elo − 120, then the same shrink; flat `1600 − 120` if no feeder |
| Production feeder | **ON** (declared track choice) |
| Benchmark feeder | **OFF** (frozen) |

`scripts/fit-season-init.ts` scored historical transitions 2019-20…2024-25 (n=2,280). Training optimum: shrink **0.75**, gap **120**, feeder OFF (LL 0.97658 vs placeholder 0.75/80 feeder-off 0.97843). **2025-26 was not used to pick the coefficients** (check LL 1.0296).

Production still turns the Championship feeder **ON** so Coventry / Ipswich / Hull use the explicit translation path. Feeder ON was slightly worse on the historical grid. That is declared, not hidden.

Coefficients are labeled fitted, with training window, fit method, and fit date persisted.

---

# 6. Fixture Ingestion

| | |
| --- | --- |
| Fixture count | 380 |
| Completed | 0 |
| Upcoming | 380 |
| Postponed | 0 |
| Source | Premier League official list (19 June 2026) |
| Freshness | Retrieved 2026-08-16; season has not started |
| Identity | `pl-2026-27-{home}-{away}` — survives kickoff changes |
| Idempotency | Second ingest → 380 fixtures, 0 new identities, 0 revisions |

football-data.co.uk `2627/E0.csv` is not a Premier League file (serves National League). football-data.org PL 2026 requires a key this checkout does not have. Those feeds are recorded as STALE / unused, not silently trusted.

---

# 7. Prediction Model

| | Production | Benchmark (frozen) |
| --- | --- | --- |
| Version | `pl-live-v0.2.0` | `pl-baseline-v0.1.0` |
| HA | 72 | 72 |
| ρ | −0.061 | −0.061 |
| Goal mapping | base 1.35 / scale 350 | same |
| Season init | v0.2.0 (shrink 0.75, gap 120, feeder ON) | placeholder 0.75 / 80, feeder OFF |
| Model state | ratings as-of known results | walk-forward tape only |

A verified match result updates **model state**. It does not mint a new model version.

Dixon-Coles remains a principled low-score correction. Phase 2A does **not** claim it beats Elo+HA.

---

# 8. Genuine Live Forecast Ledger

As of freeze `2026-08-16T05:33:34.616Z`:

| Class | Count | Notes |
| --- | --- | --- |
| **LIVE_OOS** | **380** | Frozen before kickoff. Stage EARLY (15 opening-weekend) / PRESEASON (365 later) |
| RETROSPECTIVE | 0 | None invented |
| BACKTEST | 0 | Historical 2025-26 benchmark stays in its own frozen file |

Settled LIVE_OOS: **0**. The live report says so and does not compute a leaderboard from an empty sample.

---

# 9. First Real Upcoming Forecasts

All five are genuine pre-match `LIVE_OOS` at as-of 2026-08-16T05:33:34Z, model `pl-live-v0.2.0`, stage `EARLY`.

| Fixture | Kickoff UTC | H / D / A | λ | Stage |
| --- | --- | ---: | --- | --- |
| Arsenal vs Coventry City | 2026-08-21 19:00 | 71.2 / 18.9 / 9.9 | 2.20 – 0.70 | EARLY |
| Hull City vs Manchester United | 2026-08-22 11:30 | 11.8 / 20.1 / 68.1 | 0.78 – 2.13 | EARLY |
| Everton vs Crystal Palace | 2026-08-22 14:00 | 42.7 / 25.9 / 31.4 | 1.58 – 1.33 | EARLY |
| Ipswich Town vs Sunderland | 2026-08-22 14:00 | 36.2 / 26.2 / 37.6 | 1.44 – 1.47 | EARLY |
| Nottingham Forest vs Leeds United | 2026-08-22 14:00 | 42.0 / 26.0 / 32.0 | 1.56 – 1.34 | EARLY |

---

# 10. Season Simulation

| | |
| --- | --- |
| As-of | 2026-08-16T05:33:34.616Z |
| Completed fixtures fixed | 0 |
| Remaining simulated | 380 |
| Model / data version | `pl-live-v0.2.0` / `pl-2026-27-official-2026-08-16` |
| Sims | 4,000 |

| Club | Title | Expected pos |
| --- | ---: | ---: |
| Arsenal | 49.1% | 2.05 |
| Manchester City | 34.7% | 2.49 |
| Manchester United | 6.1% | 5.25 |
| Liverpool | 3.2% | 6.63 |
| Aston Villa | 2.3% | 7.47 |

Top-4 / top-5 / relegation shares are computed from the same histogram and stored, not given a dedicated UI.

---

# 11. Data Integrity

- Provenance stored on the season, each fixture, and a raw source snapshot under `data/processed/premier-league/source-snapshots/`.
- Kickoffs converted from Europe/London; DST (August BST, December GMT, late-March BST) tested.
- Reschedule updates metadata and writes a revision; identity is unchanged.
- Ingest is idempotent.
- Postponed / cancelled / live scores are not settled as ordinary results.
- Snapshots are first-write-wins and include `predictionStage` in the key. Phase 1 snapshots still resolve via the legacy 5-part key.

---

# 12. Tests

| Suite | Result |
| --- | --- |
| `typecheck` | pass |
| `test:phase1` | 55/55 |
| `test:phase1-1` | 33/33 |
| `test:phase2a` | 56/56 |
| `test:routing` | 73/73 |
| `test:track` | 24/24 |
| `test:calibration` | 12/12 |
| `test:tournament` | 52/52 |
| `validate:bracket` | 495/495 Annex C; top-5 **37.3 / 30.9 / 15.3 / 7.0 / 2.4** |
| ratings / honesty / DC selftest | pass |
| draw, stakes, path, qualification, intel, matchtype, bounce, form, completed, freshness, provenance, availability, tactical | pass |
| `ingest:pl-2026-27` twice | 380 fixtures, 0 new identities |
| `smoke-phase1` | official 2026-27 caveat; Arsenal vs Liverpool is the real 6 Feb 2027 listing; WC still plugin |

---

# 13. World Cup Regression

Green. No Phase 2A change touches World Cup routing, ratings, bracket, or honesty gates. The documented DC-MC title board is unchanged.

---

# 14. Known Limitations

1. Later-week kickoffs currently use the official default (weekend 15:00 / midweek 20:00 UK). TV selections will move many of them; identity is stable, metadata will update.
2. No structured 2026-27 results feed is live yet (season starts 21 August). Result ingest is implemented; it has nothing to settle.
3. Championship feeder ON is a declared production choice, not the historical-grid winner.
4. HA / ρ remain 2018-19…2024-25 training-window estimates and are known to be non-stationary.
5. LIVE_OOS N_settled = 0. The live page refuses impressive conclusions.
6. Snapshot Mongo replica is still optional; the committed JSONL archive is the guarantee for this freeze.
7. Tests remain `tsx` scripts.
8. No odds, injuries, lineups, transfers, or shot-based xG — by design.

---

# 15. Phase 2B Recommendation

**Do not implement now.** Recommend an independent audit of this Phase 2A freeze, then:

1. Keep collecting genuine LIVE_OOS snapshots at T-24h / T-2h / T-60m / final-prekick as those times arrive. Never backfill.
2. Only after a few settled LIVE_OOS matches exist, add a bookmaker-odds snapshot layer (de-vig, CLV) as Phase 2B.
3. Do not add injuries, lineups, or a second league until the live ledger has a real sample.

The most valuable artifact is now `data/processed/premier-league/live-oos-2026-27.jsonl`. Do not rewrite it.
