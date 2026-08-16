# Phase 2A Independent Production Audit — Football Oracle

**Auditor:** independent adversarial reviewer (audit-only pass; no production code/data modified)
**Date:** 2026-08-16
**Repo:** /Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent
**Audited HEAD:** 6d293d0243ac68492a53b28139060620e5107ccb (Phase 2A commit 301c8b8 + docs commit; verified via git rev-parse HEAD)
**Method:** every Priority 1–30 claim re-verified by executing code and reading real data; external season truth verified against current authoritative web sources (the exact premierleague.com URL stored in the repo, BBC, Sky Sports, club official sites, Guardian, ESPN, NYT-Athletic, TNT Sports, Goal.com, ESPN/Transfermarkt match pages, RTE, LBC, China Press, Zhibo8). No repository-stored data was used as its own external evidence. All destructive tests ran in an isolated sandbox copy (/tmp/foa-audit-sandbox, tape hash-verified, deleted afterwards). Production files verified byte-identical after the audit (git diff empty; live-tape md5 34f7ca54025a3a48df9f1a169df66315 unchanged).

---

# 1. Independent Verdict

```text
GO AFTER REQUIRED FIXES
```

The headline question — **is Football Oracle now genuinely holding a trustworthy, prospective 2026-27 Premier League LIVE_OOS forecasting record, built on the real season rather than a convincing-looking simulation?** — answers **YES**. Independently verified:

- The 2026-27 membership is the **real** one (20 clubs; Coventry/Ipswich/Hull promoted; West Ham/Burnley/Wolves relegated), confirmed against BBC, club-official, Guardian, ESPN, NYT-Athletic, RTE and Premier League official material — not against the repo's own data.
- All **380 fixtures** pass every structural invariant (20 clubs × 38, 19H/19A, each pair exactly twice, 38 matchdays × 10) and a 12+-fixture external cross-check matches exactly (dates, times, pairings — e.g. Man Utd–Nottm Forest 26 Dec 15:00 via ESPN/Goal.com; Liverpool–Arsenal 31 Oct 15:00 via the LFC official ticket page).
- All **380 LIVE_OOS snapshots** are genuine pre-kickoff forecasts: asOf 2026-08-16T05:33:34.616Z is 5 days before the externally confirmed season opener (21 Aug 2026, Arsenal–Coventry); every entry is LIVE_OOS, season 2026-27, model pl-live-v0.2.0, asOf < kickoff, probabilities normalized, teams matching the fixture store; **0 RETROSPECTIVE, 0 BACKTEST** in the committed tape.
- The five headline forecasts and the title simulation **reproduce exactly** from the stored ratings (DC closed-form max |Δ| = 0; title MC top-5 identical at seed 20260816 / 4000 sims).
- The frozen Phase 1 benchmark reproduces exactly and is provably isolated from production settings; the World Cup suites are all green.
- No 2025-26 contamination and no evidence of data snooping in the coefficient fits.

**But three P1 defects stand between this and operationalization** (§21–22): (1) the live-ledger query layer **double-counts every snapshot** (legacy-key aliasing), so /live and the API display **764** LIVE_OOS instead of 380 — verified in a real Chrome render; (2) **kickoff certainty is not represented anywhere** — official default 15:00/20:00 slots are stored indistinguishably from confirmed kickoffs, which future T24H/T2H/T60M/FINAL_PREKICK automation would blindly trust; (3) the **DATA_READY gate is largely decorative** for fixture-level corruption (379 fixtures, an outsider-club fixture, a missing kickoff, and a duplicated pairing all still report DATA_READY). None of these defects invalidates the committed 380-line tape; each is a fixable guardrail around it.

# 2. External Season Verification

**Method.** Current authoritative sources only (web searches on 2026-08-16); the repo's stored data was excluded from this section.

| Item | External evidence | Repo claim | Verdict |
| --- | --- | --- | --- |
| Fixture release | PL official article premierleague.com/en/news/4675097/all-380-fixtures-for-202627-premier-league-season (the exact URL stored in the repo CSV header) | published 2026-06-19 | MATCH |
| Season opens | China Press “新赛季8月21开锣 揭幕战枪手喜迎升班马”; Zhibo8 “揭幕战8月22日枪手vs考文垂” (UTC+8); FPT “kicking off Aug 22” (UTC+7) | 2026-08-21, Arsenal vs Coventry | MATCH |
| Opener | BBC “Newly promoted Coventry travel to champions Arsenal on opening day”; arsenal.com “welcoming Coventry City to Emirates Stadium” | Arsenal vs Coventry City | MATCH |
| Promoted | Liverpool FC “An in-depth look at Coventry City, Hull City and Ipswich Town”; EADT “Ipswich Town officially become Premier League club again”; Hull play-off winners vs Middlesbrough (RTE, AA, LBC, SuperSport, tribuna) | Coventry, Ipswich, Hull | MATCH |
| Relegated | Guardian live blog “West Ham relegated … Arsenal lift trophy”; NYT-Athletic “Scott Parker departs Burnley after Premier League relegation”; Yahoo TW “狼隊…5大聯賽首支降級隊…重返英冠” | West Ham, Burnley, Wolves | MATCH |
| 2025-26 champions | Guardian “Arsenal lift trophy”; Fotmob/beIN “Arsenal to retain title”; Pep Guardiola farewell articles | Arsenal (tape basis) | MATCH |
| Opening-round fixtures | Sky “Arsenal face Coventry and Liverpool at Newcastle in opening round”; Fanatik “Hull City faces a tough opponent in the first week”; Chinese “桑德兰首轮客战伊普斯维奇” (Sunderland away at Ipswich in round 1); Chelsea “derby first up” (Fulham–Chelsea) | MW1 of the repo CSV | MATCH (6/10 MW1 fixtures individually confirmed) |
| Mid-season spot checks | LFC official ticket page “liverpool-fc-v-arsenal-31-oct-2026-0300pm”; ESPN/Goal.com “Manchester United vs Nottm Forest 26 December 2026 15:00”; TNT Sports “Coventry City - Hull City 29/08/2026”; Goal.com/Transfermarkt “Tottenham v Manchester United 23 May 2027” | matching rows in the repo fixture store | MATCH (exact dates and times) |
| Final day | Official season-dates announcements (premierleague.com “What are the dates for 2026/27”, Sky “season start date, final day”, LFC “start and end dates”) | 2027-05-30 | CONSISTENT (final-day pairing set verified structurally; individual final-day pairings not string-confirmed externally) |

**Coverage statement.** 12+ individual fixtures confirmed externally with exact dates (three with exact times); the complete 380 were verified structurally (§3). The externally confirmed set spans MW1, MW2, MW10-ish, MW17 (Boxing Day), MW37, plus season start/end dates. This is a large systematic sample plus full structural verification — substantially stronger than a five-fixture spot check — but it is not “all 380 rows individually confirmed against an external machine-readable source”, and this report does not claim that.

# 3. 380-Fixture Audit

Independent Python audit of data/processed/premier-league/fixtures-2026-27.json (not the repo's own validation code):

| Check | Result |
| --- | --- |
| Fixture count | **380** ✓ |
| Unique ids | 380/380 ✓ |
| Distinct clubs | 20 home, 20 away; all in the active membership; no outsiders ✓ |
| Per-club counts | every club exactly **19 home + 19 away** ✓ |
| Pair meetings | every unordered pair meets exactly **twice**; every directed pair exactly once (home-and-away reciprocity) ✓ |
| home ≠ away | 0 violations ✓ |
| Matchdays | 38 × exactly 10 fixtures ✓ |
| Date range | 2026-08-21 → 2027-05-30 ✓ (no fixture before opening day) |
| Status / goals | all SCHEDULED, goals null; 0 postponed, 0 completed ✓ |
| DST handling | kickoff-UTC buckets consistent with Europe/London BST→GMT transitions (e.g. 20:00 London Friday opener → 19:00Z; winter 15:00 → 15:00Z; summer 15:00 → 14:00Z) ✓ |
| Dedup | no duplicate logical fixtures ✓ |

First round (all 10, externally cross-checked in part) and final round (all 10) inspected individually; randomly selected fixtures across the season match the CSV transcription exactly.

# 4. ClubSeason / Promotion-Relegation Audit

- data/processed/premier-league/club-seasons-2026-27.json: exactly **20 entries**, one per active club; arsenal has entry: stayed, previousSeason: 2025-26; coventry/ipswich/hull have entry: promoted, previousCompetition: championship, promotionStatus: promoted.
- Relegated clubs (**west-ham, burnley, wolves**) have **no active 2026-27 ClubSeason entry** and are absent from the season manifest and every fixture; they are referenced only in relegatedClubIds.
- Arsenal 2025-26 vs 2026-27 are distinguishable: season is a first-class field on ClubSeason, Fixture, and PredictionSnapshot; snapshots carry season, and the snapshot key includes it.
- Alias resolution (lib/competitions/premier-league/clubs.ts): the whole normalized-name index was inspected; no alias maps two distinct clubs to one slug (checked all 49 club entries and the full BY_ALIAS construction; “Nott'm Forest”→nottingham-forest, “Sheffield Weds”→sheffield-wednesday, etc.). No collisions found.
- API names/slugs resolve correctly through getClub / resolveClubSlug (exercised by the ingest of all 380 CSV rows without failure).

# 5. Fixture Provenance

Chain reconstructed end-to-end for several fixtures (e.g. Arsenal vs Coventry):

```text
premierleague.com/en/news/4675097 (official 380-fixture release, 19 Jun 2026)
  ↓ hand-transcribed
data/raw/premier-league/official-2026-27-fixtures.csv   (source URL + published + retrieved in header)
  ↓ parseOfficialFixtureCsv → rawRowsToFixtures (slug resolution, London→UTC, officialFixtureId)
fixtures-2026-27.json   (per-fixture: source, sourceId, sourceFixtureId, retrievedAt 05:32:02Z, sourceUpdatedAt 2026-06-19T09:00+01:00)
  + source-snapshots/official-2026-08-16T05-32-02-136Z.json (captured source snapshot, 380 rows)
  ↓ liveFixtures()
CompetitionSeason (season-2026-27.json, dataVersion pl-2026-27-official-2026-08-16)
  ↓ remainingPremierLeagueFixtures / upcomingLiveFixtures
prediction engine → LIVE_OOS snapshots (each snapshot stores eloHome/eloAway, fixturesUsed, kickoff, modelParameters)
```

**Yes, the system can answer “where did this exact Arsenal vs Coventry fixture come from?”** — the source snapshot, the per-fixture provenance fields, and the raw CSV header all reference the official article URL, and the snapshot records the exact rating inputs used. **Honest weaknesses (P2):** sourceFixtureId is the internal id duplicated (the release report's “Source id = official pairing id” overstates this — the official release carries no machine pairing id here); the raw CSV is a hand transcription (no HTML capture preserved); the CSV header's retrieved: 2026-08-16T12:00:00Z is wrong — the actual capture was 05:32:02Z (the header timestamp postdates the freeze and even the audit start; P3).

# 6. Kickoff-Certainty Audit

**FAIL — no certainty representation exists.** Findings:

- The Fixture type has kickoffUtc/kickoffLocal/timezone but **no** CONFIRMED/PROVISIONAL/DATE_ONLY/DEFAULT_TIME/TBD field. Confirmed by full 380-row scan (0 of 380 fixtures carry any certainty field) and by reading the ingest/normalization code.
- The raw CSV bakes official defaults in: **300 rows at 15:00 and 58 at 20:00** — the PL's own weekend/midweek default slots pending TV selection — stored byte-identical to genuinely confirmed kickoffs (12:30/14:00/16:30/17:30/20:00 TV slots).
- stageFromTiming(asOf, kickoffUtc) and the future T24H/T2H/T60M/FINAL_PREKICK machinery would key off these placeholder times. **Nothing today prevents a default 15:00 from later triggering a fake T60M snapshot** for a match that TV moves to 17:30. The release report's limitation note (§14.1) is accurate, but the schema provides no guardrail.
- The fixture-update path (mergeFixtureUpdate / applyFixturePatch) *can* update a kickoff correctly (§18) — the missing piece is only the certainty flag, not the update mechanics.

**Severity: P1** (must fix before T-stage automation).

# 7. Offseason Shrink Audit (shrink = 0.75)

- Fitting code: scripts/fit-season-init.ts — walk-forward log-loss over historical PL season transitions, scored seasons 2019-20…2024-25 (n=2,280), 2018-19 burn-in; TRAIN_TO = 2025-05-31; **2025-26 appears only in the post-hoc held-out check** (computed solely for the grid winner, so selection is training-only — no test-set selection loop).
- Original grid: shrink {0.55, 0.65, 0.75, 0.85, 1.0} × gap {0, 40, 80, 120} × feeder {off, on}; winner shrink **0.75**, gap 120, feeder OFF, train LL **0.97658**; placeholder (0.75/80/off) 0.97843.
- Independent re-run (same harness, reproduced the shipped numbers exactly, incl. held-out LL 1.029607 vs shipped 1.0296066). Extended surface (training LL, feeder OFF):

| shrink \ gap | 80 | 100 | 120 | 125 | 150 | 175 | 200 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.60 | 0.98032 | 0.97904 | 0.97796 | 0.97771 | 0.97667 | 0.97592 | 0.97550 |
| 0.65 | 0.97950 | 0.97831 | 0.97728 | 0.97704 | 0.97603 | 0.97528 | 0.97480 |
| 0.70 | 0.97886 | 0.97776 | 0.97680 | 0.97658 | 0.97562 | 0.97487 | 0.97435 |
| **0.75** | 0.97843 | 0.97745 | **0.97658** | 0.97638 | 0.97548 | 0.97475 | **0.97420** |
| 0.80 | 0.97824 | 0.97740 | 0.97664 | 0.97647 | 0.97565 | 0.97497 | 0.97441 |
| 0.85 | 0.97836 | 0.97768 | 0.97705 | 0.97691 | 0.97622 | 0.97561 | 0.97508 |
| 0.90 | 0.97883 | 0.97834 | 0.97788 | 0.97777 | 0.97724 | 0.97675 | 0.97631 |
| 1.00 | 0.98110 | 0.98110 | 0.98110 | 0.98110 | 0.98110 | 0.98110 | 0.98110 |

- **Shrink 0.75 is a genuine interior optimum** of the extended surface (0.7–0.8 plateau; 1.0 clearly worse). It coincides with the old placeholder value, but the search independently prefers it. Classification: **WELL SUPPORTED**.
- Diagnostic detail: at shrink = 1.0 the gap is *identically* inert (all gaps → 0.98110) — the system is translation-invariant in Elo differences, so the gap is only identifiable relative to the fixed 1600 mean anchor. This is a modeling property worth knowing; it does not affect the shipped configuration.
- No 2025-26 data enters the search input; the held-out number was not used to choose the winner. **Not contaminated.**

# 8. Promoted-Team Gap Audit (gap = 120)

- Same fit as §7. Original gap grid was {0, 40, 80, 120} — **the winner 120 sits at the top edge of the grid**. The extended surface shows training LL **keeps improving monotonically through gap 200** (0.97420 at 0.75/200 vs 0.97658 at the shipped 0.75/120; Δ ≈ 0.0024), so the shipped value is **not** the unconstrained training optimum; it is a grid-edge artifact (the same pattern flagged for HA = 75 in the Phase 1 audit).
- Additional wrinkle: the gap was fitted in the **feeder-OFF** regime (flat promoted prior = 1600 − gap), but production uses it under **feeder ON** (Championship Elo − gap, then shrink). Under feeder ON the same 0.75/120 point scores 0.97919 on training — worse than the winner. This is disclosed in the release report (“Feeder ON was slightly worse … declared, not hidden”) and in the params file; it is a declared design choice, not hidden tuning.
- Production held-out check (2025-26): 0.75/120 feeder OFF LL 1.0296; feeder ON LL 1.0393. **2025-26 was not used to pick the value.**
- Classification: **PLAUSIBLE BUT WEAK** (value is in the reasonable promoted-prior range, but the fit's evidence for 120 specifically is a grid edge, and the fit/use regime mismatch means the production configuration is not the configuration the search evaluated).

# 9. Data-Snooping Audit

- Phase 2A landed as a **single commit** (301c8b8), so git cannot show parameter-search iteration history; the audit therefore rests on the committed artifacts.
- **Fit script structure:** the held-out window is evaluated **only for the grid winner** — the search itself never touches 2025-26. The stored leaderboard is training-log-loss only.
- **No hidden iteration evidence:** the params file's leaderboard matches the committed grid exactly; the production choice (feeder ON) is *worse* on the training grid than the winner — if the agent had been tuning to look good, it would not have shipped the worse-on-paper configuration. The gap=120/grid-edge issue is a search-space weakness, not held-out tuning.
- **No indirect leakage found:** the ratings/snapshots store fixturesUsed = 3040 (all 8 historical seasons, none current); the tape and sim carry no 2025-26-derived parameter adjustments; model-params.json (HA/ρ) is byte-identical to the Phase 1 freeze; the frozen benchmark file is untouched.
- Residual risk (honest): the single-commit history means uncommitted scratch iterations are unprovable either way. No positive evidence of snooping exists.

# 10. Production vs Benchmark Isolation

| Check | Result |
| --- | --- |
| Benchmark params source | model-params.json (pl-baseline-v0.1.0), via loadPremierLeagueParams; production reads production-params.json (pl-live-v0.2.0) | PASS — separate files |
| Benchmark feeder | useChampionshipFeeder undefined → {} → **OFF** by construction in lib/evaluation/backtest.ts | PASS |
| Production feeder | ratingsAsOf live path → applySeasonBoundary with useChampionshipFeeder: true | PASS |
| Benchmark reproduction | npm run backtest:pl reproduced exactly: Brier 0.6187 / RPS 0.2095 / LogLoss 1.0281 / pooled rel. MAE 2.1% / conf. ECE 4.1% / top-pick 48.2%, bootstrap Δ identical | PASS |
| Frozen artifact | backtest-heldout.phase1-frozen.json byte-identical (git diff empty); benchmark output file rewrite is content-identical | PASS |
| Production settings leaking into benchmark | none found — benchmark path never imports production-params.json or season-init-params.json | PASS |

Classification: **PASS**. (The tracks share HA/ρ by declared design; that is a frozen constant reuse, not cross-contamination.)

# 11. LIVE_OOS Tape Audit

Full programmatic audit of data/processed/premier-league/live-oos-2026-27.jsonl (all 380 lines):

| Check | Result |
| --- | --- |
| Lines / unique keys | 380 / 380 ✓ |
| evaluationClass | LIVE_OOS × 380 ✓ |
| stage | EARLY × 15 (opening fortnight), PRESEASON × 365 ✓ |
| modelVersion | pl-live-v0.2.0 × 380 ✓ |
| competition / season | premier-league / 2026-27 × 380 ✓ |
| asOf | 2026-08-16T05:33:34.616Z × 380; dataCutoff equal ✓ |
| asOf < kickoff | 380/380 ✓ (strict) |
| fixture exists in store | 380/380 ✓; snapshot home/away slugs match fixture store 380/380 ✓ |
| probabilities | 0 ≤ p ≤ 1 and H+D+A = 1.000000000000 × 380 ✓; λ ≥ 0 ✓ |
| modelParameters persisted | HA 72, ρ −0.061, kFactor 20, training window — single consistent object across all 380 ✓ |
| sourceState persisted | eloHome/eloAway consistent per club across all snapshots; fixturesUsed = 3040 ✓ |
| RETROSPECTIVE / BACKTEST in tape | **0 / 0** ✓ |
| Immutability | first-write-wins + deep-frozen clones (tested: rewrite returns original, mutation throws) ✓ |

Temporal legality: the freeze predates the externally confirmed opening weekend by 5 days; no 2026-27 result existed anywhere (0 settled, all fixtures SCHEDULED with null goals), so no snapshot could have used result knowledge. **The committed tape is a genuine prospective record.**

**P1 defect (ledger counting, not tape content):** the query layer that reads the tape double-counts (§12/§16). The committed 380 lines themselves are correct.

# 12. Prediction-Stage Semantics

- **Stage is now part of snapshot identity** (D1 claim verified): canonical key = competition::season::fixtureId::modelVersion::predictionStage::asOf. The Phase 1.1 re-audit's “predictionStage must be part of identity” is **fixed**.
- Safe tests executed (sandbox): (a) same fixture/model, **different stage, same asOf** → distinct keys, both coexist ✓; (b) same fixture/stage, **different asOf** → distinct keys, both coexist ✓ (production store already contains the real example: liverpool-arsenal PRESEASON at asOf 05:33:34Z and 05:34:41Z).
- evaluationClass (BACKTEST/RETROSPECTIVE/LIVE_OOS) and predictionStage are **independent dimensions**: evaluationClass is enforced by asOf-vs-kickoff (assertLiveOosLegal throws at/after kickoff), and stage is pure time-to-kickoff. Settlement records carry both.
- **Aliasing caveat (root of the §16 bug):** legacy 5-part keys are retained for Phase 1 lookups, and loadFromDisk registers each line under **both** the modern and the legacy key — so listSnapshots() returns two entries per snapshot. Identity is correct at the key level; enumeration is not.
- Stage-specific evaluation: the schema fully supports it (settlement carries stage; filtering by stage is trivial); the current report aggregates all LIVE_OOS stages (fine at n=0). EARLY/T24H/T2H/T60M/FINAL_PREKICK can coexist without overwriting EARLY.

# 13. Title Simulation Audit

season-simulations.jsonl (single persisted simulation) and independent re-execution:

| Check | Result |
| --- | --- |
| Clubs | exactly the **20 active 2026-27 clubs**; **no West Ham / Burnley / Wolves** anywhere in the simulated league ✓ |
| Fixtures | **0 completed fixed, 380 real remaining** from the verified store (dataSource REAL_2026_27_DATA) ✓ |
| Synthetic generator | generateRoundRobin remains only as the DATA_BLOCKED fallback; the live path uses real fixtures (code + run verified) ✓ |
| Ratings | production ratingsAsOf(2026-08-16) state ✓ |
| Model/params | pl-live-v0.2.0, HA 72, ρ −0.061, DC-corrected scoreline sampling ✓ |
| Reproduction | independent reimplementation at seed 20260816 / 4000 sims reproduces **exactly**: Arsenal 49.05%, Man City 34.70%, Man United 6.08%, Liverpool 3.20%, Villa 2.27% (and expected positions 2.048/2.487/5.255/6.626/7.474) — identical to the shipped snapshot ✓ |
| Normalization | Σ title probabilities = 1.000 ✓ |

# 14. Title Sensitivity Analysis

Multi-seed MC noise (4000 sims each): Arsenal title spans **47.7%–50.5%** across 5 seeds (σ ≈ 1.4pp). Differences like 49.1 vs 48.8 are simulation noise, not state differences.

Temporary diagnostics (production parameters untouched; independent harness):

| Variation | Arsenal | Man City | Man United |
| --- | ---: | ---: | ---: |
| shrink 0.65 | 43.8% | 32.8% | 7.2% |
| shrink 0.75 (shipped) | 49.0% | 34.7% | 6.1% |
| shrink 0.85 | 53.4% | 35.4% | 5.1% |
| gap 80 | 49.7% | 34.6% | 5.9% |
| gap 120 (shipped) | 49.0% | 34.7% | 6.1% |
| gap 160 | 48.6% | 34.9% | 6.3% |
| HA 60 | 48.7% | 34.9% | 5.9% |
| HA 72 (shipped) | 49.0% | 34.7% | 6.1% |
| HA 84 | 48.2% | 35.1% | 6.6% |

**Interpretation:** the title distribution is robust to the promotion gap and home advantage, but the Arsenal headline figure is **moderately sensitive to shrink** (~±5pp per 0.10 shrink). Since shrink = 0.75 is the best-supported of the three parameters (§7), the distribution is defensible — but the 49% headline leans on one uncertain preseason coefficient. This is a model-quality observation (P2), not an integrity failure; per the decision rule it does **not** block operationalization.

# 15. First Forecast Reproduction

Independent reproduction from the stored Elo inputs through the repo's own DC closed form (matchProb) — max |Δ| = 0.0 on all five:

| Fixture | H/D/A (stored = computed) | λ | Kickoff (UTC) | Stage |
| --- | --- | --- | --- | --- |
| Arsenal vs Coventry | 71.198 / 18.879 / 9.923 | 2.203 – 0.703 | 2026-08-21 19:00 | EARLY |
| Hull vs Man United | 11.831 / 20.110 / 68.060 | 0.775 – 2.130 | 2026-08-22 11:30 | EARLY |
| Everton vs Crystal Palace | 42.691 / 25.927 / 31.382 | 1.580 – 1.326 | 2026-08-22 14:00 | EARLY |
| Ipswich vs Sunderland | 36.225 / 26.154 / 37.620 | 1.437 – 1.468 | 2026-08-22 14:00 | EARLY |
| Nottm Forest vs Leeds | 41.982 / 25.979 / 32.038 | 1.565 – 1.341 | 2026-08-22 14:00 | EARLY |

All round to the reported 71.2/18.9/9.9 … λ 2.20–0.70 etc. Inputs: home advantage +72, ρ −0.061, goal mapping base 1.35 / scale 350, Elo from sourceState (e.g. Arsenal 1770.7164 vs Coventry 1544.1054). Probability normalization exact (Σ = 1.000000000000).

# 16. /live Browser Audit

Real browser: system Google Chrome, headless, --no-sandbox --no-proxy-server --dump-dom against next dev on 127.0.0.1:3000 (JS executed; React rendered). Result: **PARTIAL**.

| Check | Result |
| --- | --- |
| /live loads, no runtime/hydration exception | PASS |
| Honesty text (no odds/injuries/lineups/xG claims) | PASS — exact sentence renders |
| Model label pl-live-v0.2.0 / season label 2026-27 | PASS |
| Settled = 0; Brier/RPS/LogLoss “—”; ECE “n too small”; no fake score | PASS |
| RETROSPECTIVE 0 · BACKTEST 0 | PASS |
| Links present | PASS |
| **LIVE_OOS count displays correctly** | **FAIL — renders “LIVE_OOS snapshots 764” instead of 380** (P1; root cause §11/§12 alias double-counting, plus two legitimate post-freeze smoke snapshots in the local store) |
| Home page featured fixtures | PASS — real upcoming fixtures render with correct kickoffs (“Arsenal vs Coventry 2026-08-21 20:00 UK”, Hull vs Man United 12:30 UK, …) and per-card pl-live-v0.2.0 labels |

A browser-level agent query was deliberately not executed to avoid writing new rows into the local snapshot store during the audit (data-preservation rule); the agent answer path is covered by code review and the two existing smoke entries it produced earlier.

# 17. Data-Readiness Gate

DATA_READY / VERIFIED is **not a meaningful gate for fixture-level corruption**. Sandbox mutation tests on evaluateDataGate (production files untouched):

| Mutation | Gate result | Expected |
| --- | --- | --- |
| baseline | DATA_READY ✓ | ready |
| fixture count 379 | **DATA_READY** (scheduleCompleteness still “complete”) | must degrade/block |
| duplicate fixture id | DATA_DEGRADED ✓ | degrade/block |
| outsider fixture (west-ham in 2026-27 store) | **DATA_READY** | must degrade/block |
| unresolved identity | DATA_BLOCKED ✓ | block |
| missing kickoff | **DATA_READY** | must degrade/block |
| duplicate logical pair (arsenal-coventry twice home) | **DATA_READY** (not even detected) | must degrade/block |
| duplicate club ids in manifest | DATA_BLOCKED ✓ | block |
| club count ≠ 20 | DATA_BLOCKED ✓ | block |
| relegated club active / promoted missing | DATA_BLOCKED ✓ | block |

Two structural causes: (1) verificationStatus: VERIFIED is self-referential — wikipediaClubSet() returns the same hardcoded constant the manifest is built from, so detectClubConflicts can never report a conflict; (2) the final override in evaluateDataGate force-promotes any 380-fixture/20-club/VERIFIED state to DATA_READY, discarding accumulated reasons like “outside the active season” or “lack a kickoff timestamp”. **Severity: P1** — the gate is the designated guardrail for future result ingestion and T-stage automation.

# 18. Ingest / Update Idempotency

Executed in the sandbox copy:

- **Ingest twice** (same CSV, different retrievedAt): 380 → 380 fixtures, 0 new identities, 0 revisions, 20 clubs, manifest VERIFIED. PASS.
- **Kickoff update** (Sat 15:00 → Sun 16:30 via applyFixturePatch): same logical fixture id, kickoff/date metadata updated, 0 duplicate fixtures, 5 revision rows appended to fixture-revisions.jsonl (field-level from/to). PASS.
- Existing EARLY snapshots are untouched by fixture updates (snapshots are keyed/stored independently of fixture metadata; first-write-wins). PASS.
- Duplicate-snapshot protection: same uniqueKey re-write returns the original numbers (verified with a fresh key). PASS.

# 19. Live Tape Durability

- The tape is **git-tracked** (git ls-files confirms) and the committed archive is the guarantee; the local store data/processed/predictions/snapshots.jsonl is deliberately gitignored.
- Write path is **append-only by code**: archiveLiveOosSnapshots uses appendFileSync with uniqueKey dedup against the file; a same-asOf re-run of freeze:live appends nothing (sandbox: tape bytes unchanged for the same asOf).
- **Two defects found (P2):** (a) when the in-memory map contains legacy-aliased duplicates, archiveLiveOosSnapshots appends the same uniqueKey **twice** (sandbox: 380 → 384 after re-archiving two smoke entries) — the dedup is per-batch, not per-line; (b) nothing but discipline prevents an accidental overwrite (no read-only flag, no hash check, no CI guard). The re-freeze in the sandbox also demonstrated that two legitimate post-freeze smoke snapshots would migrate into the committed archive on the next run. Git history provides restore; the append-only property is currently code-level, not enforced.

# 20. World Cup Regression

All re-executed green: typecheck (exit 0); npm test = Phase 1 55 + Phase 1.1 33 + **Phase 2A 56**; routing **73/73**; track **24/24**; calibration **12/12**; tournament **52/52**; validate:bracket **495/495 Annex C** with top-5 **37.3 / 30.9 / 15.3 / 7.0 / 2.4** (unchanged); ratings / honesty / provenance / DC Python selftest all pass. No Phase 2A change touches World Cup behavior. PASS.

# 21. Findings by Severity

## P0 — none

No wrong season, no wrong membership, no post-kickoff LIVE_OOS, no synthetic title MC, no data contamination.

## P1 — must fix before operationalization

1. **Live-ledger double counting (user-visible).** Legacy-key aliasing in lib/snapshots/store.ts (loadFromDisk registers each line under modern + legacy keys; listSnapshots() enumerates both) makes liveOosCount return **764** instead of 380; the rendered /live page and /api/live show 764; archiveLiveOosSnapshots double-appends aliased entries. Future stage-wise evaluation would double-count every prediction. Fix: dedup listSnapshots by provenance.uniqueKey, and dedup archive batches by uniqueKey within the batch.
2. **Kickoff certainty unrepresented.** No CONFIRMED/PROVISIONAL/DEFAULT_TIME/TBD field anywhere in the fixture schema, ingest, API, or UI; 300×15:00 + 58×20:00 official default slots are indistinguishable from confirmed kickoffs, so future T24H/T2H/T60M/FINAL_PREKICK automation could key off placeholder times (§6).
3. **DATA_READY gate not meaningful for fixture-level corruption.** 379 fixtures, outsider-club fixtures, missing kickoffs, and duplicate logical pairings all pass as DATA_READY; VERIFIED is structurally self-referential (§17).

## P2 — important but non-blocking

1. **gap = 120 is grid-edge-truncated and regime-mismatched** (fitted feeder-OFF, used feeder-ON). PLAUSIBLE BUT WEAK (§8).
2. **Provenance detail gaps:** sourceFixtureId = internal id (no true official pairing id); Wikipedia cross-check is a no-op comparing a constant with itself; raw CSV header retrieved timestamp is wrong (12:00Z vs actual 05:32Z); no raw HTML capture of the official page (§5, §17).
3. **scorelineDistribution is an unmarked top-6 subset** (~50–60% of probability mass per snapshot) with no truncation marker; provenanceNotes text omits predictionStage from the documented key (§11).
4. **Title share moderately sensitive to shrink** (Arsenal 43.8%→53.4% across shrink 0.65→0.85) (§14).
5. **Championship feeder completeness:** all 46 Wrexham rows are dropped at import (no alias), so every club's feeder rating misses its two Wrexham games; Hull's feeder rating (1481.91, below the 1500 start) yields a 1421.4 production prior driven by a 7-season tape including the 2019-20 relegation season.
6. **Interactive agent path can mint LIVE_OOS for non-scheduled pairings** (kickoff null → evaluationClassFor returns LIVE_OOS with no temporal check). No such entries currently exist; the two post-freeze smoke entries are real fixtures.
7. **Tape durability is discipline-based** (append-only code, git-tracked, but no enforcement against accidental overwrite; re-archive double-append bug) (§19).
8. **Model-version bump is not enforced** — changing shrink/gap/HA/ρ in production-params.json/season-init-params.json would silently change forecasts under the same pl-live-v0.2.0 string (documented semantics only). Elo state updates correctly do NOT bump the version.

## P3 — minor

1. Raw CSV header retrieved: 2026-08-16T12:00:00Z inconsistent with the actual capture (05:32:02Z).
2. freezeUpcomingForecasts reports loop iterations, not newly created snapshots (a same-asOf re-run reports “380 frozen” though 0 are new).
3. Release-report wording “Source id = official pairing id” overstates the synthetic sourceFixtureId.

# 22. Required Fixes Before Operationalization

1. **Fix snapshot enumeration dedup** (P1-1): listSnapshots must return one entry per provenance.uniqueKey; make archiveLiveOosSnapshots dedup per-line within the batch. Re-verify /live shows 380 and API matches.
2. **Add explicit kickoff certainty** (P1-2): a fixture field (e.g. kickoffCertainty: CONFIRMED | DEFAULT_TIME | TBD) carried from source through ingest to API/UI; T24H/T2H/T60M/FINAL_PREKICK stage logic must refuse to schedule off non-CONFIRMED kickoffs.
3. **Harden the data gate** (P1-3): fixture count ≠ expected (380) must degrade/block; missing kickoff must degrade; outsider/relegated clubs in fixtures must block (remove the force-promote override); detect duplicate logical pairings; make the Wikipedia cross-check a real comparison or relabel VERIFIED as derived-only.
4. **Decide the fate of the two post-freeze smoke snapshots** in the local store (keep as genuine extra-asOf LIVE_OOS and document, or quarantine them) so the ledger count matches the committed 380-line freeze.
5. Then re-freeze the corrected ledger state and re-verify /live, the API, and the release-report numbers.

# 23. Safe-to-Defer Research Issues

- Re-fit the promotion gap on an extended, unbounded search (≥ 150–200) — and ideally fit it in the same regime it is used (feeder ON), or formally justify the feeder-OFF→ON extrapolation.
- Decide whether the Championship feeder should reset/decay older seasons (Hull's 2019-20 still weighs on its 2026 prior) and whether to ingest the missing Wrexham rows.
- Monitor the shrink sensitivity of the title board; consider reporting a shrink-sensitivity interval alongside the headline title share.
- Investigate a truncation marker or full-grid storage for scorelineDistribution.
- Add a model-version-bump check (hash of structural parameters vs the version string) in CI.
- After several settled LIVE_OOS matches: stage-specific EARLY/T24H/T2H/T60M/FINAL_PREKICK evaluation (the schema already supports it).

# 24. Operationalization Go / No-Go

```text
GO AFTER REQUIRED FIXES
```

The 2026-27 season foundation is **real and trustworthy**: correct membership, correct 380-fixture schedule, genuine pre-kickoff LIVE_OOS freeze, exact forecast/simulation reproducibility, clean benchmark isolation, green World Cup regression, and no evidence of data snooping. The three P1 items are guardrail defects around the record (ledger count misreport, missing kickoff certainty, decorative data gate) — none falsifies a single committed snapshot, but all three must be fixed before T-stage schedulers and result automation start operating on this ledger. The audit explicitly does **not** block on the statistical uncertainty of shrink/gap/HA/ρ, per the decision rule.

## Appendix A — all 20 preseason ratings (production, 2026-08-16)

```text
arsenal          1770.7164   manchester-city   1754.2516   manchester-united 1694.5674
liverpool        1672.9135   bournemouth       1663.1580   aston-villa       1661.7351
brighton         1634.5026   brentford         1630.5343   nottingham-forest 1625.3411
leeds            1622.2490   chelsea           1621.9599   newcastle         1620.1773
fulham           1612.8164   everton           1600.3929   crystal-palace    1591.9089
sunderland       1576.9676   tottenham         1556.0121   coventry          1544.1054
ipswich          1535.4944   hull              1421.4329
```

Promoted priors (feeder path, no fallback used): Coventry 1645.47 → 1544.11; Ipswich 1633.99 → 1535.49; Hull 1481.91 → 1421.43 (Championship Elo − 120, then 0.75 shrink). Continuing clubs: 1600 + 0.75 × (Elo − 1600), e.g. Arsenal 1827.6 → 1770.7.

## Appendix B — verification environment

- Node v22.22.0 x64 (Rosetta) per docs/DEVELOPMENT_ENVIRONMENT.md; npm test, typecheck, and all suites green.
- Destructive/idempotency/gate tests: isolated /tmp/foa-audit-sandbox (symlinked lib/node_modules, copied data; tape md5 verified identical before/after; deleted after use).
- Browser: system Google Chrome (headless, no-sandbox) against next dev on 127.0.0.1:3000; /live and / rendered with JS.
- No production file was modified: post-audit git diff empty; live tape md5 34f7ca54025a3a48df9f1a169df66315 unchanged; only this report added.
