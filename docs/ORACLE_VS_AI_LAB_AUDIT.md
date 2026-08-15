# Oracle Agent vs AI Lab — Cross-Repository Audit

**Status:** audit complete and independently re-verified. No large rewrite started.  
**Date:** 2026-08-16  
**Primary base:** `worldcup-oracle-agent` @ `9e540b3` (`main`)  
**Donor:** `world-cup-ai-lab` @ `8fa00fe` (`integration/feature-audit-20260614`)  
**Preservation tag:** `archive/worldcup-2026-v1` on the Oracle repo  
**Proposed successor name:** `football-oracle-agent`

This document is based on the **actual code and the tests that were re-run in this session**, not README claims. Both repositories share a common ancestor: a TypeScript port of `Hicruben/world-cup-2026-prediction-model` (Elo → Dixon-Coles τ → seeded Monte Carlo). They then diverged. Oracle became a **production agent product**. AI Lab became a **research / commercial-MVP lab** with a larger historical evaluation stack.

A first draft of this file already existed in the working tree. This version is the result of a second, independent file-by-file pass plus a full re-run of both test suites. The backbone decision did not change. Several honesty and Phase-1 details did.

---

## 0. How this audit was run

### Oracle (`worldcup-oracle-agent`)

Ran locally from the repo root. **All of the following passed (exit 0):**

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run test:track` | 24/24 |
| `npm run test:provenance` | pass (74 verified / 102 recorded results) |
| `npm run test:freshness` | pass (latest verified result 2026-07-15) |
| `npm run test:honesty` | pass |
| `npm run test:completed` | pass |
| `npm run test:calibration` | 12/12 |
| `npm run test:tournament` | 52/52 |
| `npm run test:ratings` | pass (102 results applied) |
| `npm run test:availability` | pass (15 entries / 8 teams) |
| `npm run test:tactical` | pass |
| `npm run test:draw` | pass |
| `npm run test:stakes` | pass |
| `npm run test:path` | pass |
| `npm run test:qualification` | pass (group stage complete, 32 in R32) |
| `npm run test:intel` | pass (32 fixture-scoped entries) |
| `npm run test:matchtype` | pass |
| `npm run test:bounce` | pass |
| `npm run test:form` | pass |
| `npm run test:routing` | 73/73 |
| `npm run dc:selftest` | pass (Python ridge Dixon-Coles invariants) |
| `npm run validate:bracket` | all 495 Annex C combinations valid |
| `npm run backtest` | 102-match walk-forward of the **live** stack |

**Live walk-forward numbers (reproduced 2026-08-16):**

| Variant | Brier ↓ | RPS ↓ | LogLoss ↓ | Top-pick | Avg draw pred |
| --- | ---: | ---: | ---: | ---: | ---: |
| uniform 1/3 | 0.667 | 0.239 | 1.099 | 57% (58/102) | 33% |
| base Elo + host | 0.454 | 0.139 | 0.775 | 69% (70/102) | 23% |
| + results + confederation | 0.459 | 0.142 | 0.787 | 70% | 23% |
| + injuries + tactical + bounce | 0.453 | 0.140 | 0.779 | 69% | 23% |
| + flat group-draw boost | 0.448 | 0.140 | 0.770 | 67% | 26% |
| + kill-index / low-block draw | 0.439 | 0.138 | 0.757 | 68% | 27% |
| **`+cal` (live engine)** | **0.433** | **0.135** | **0.746** | **68% (69/102)** | **26%** |

- RPS skill vs uniform: **+0.434**
- ECE: **5.0%**
- Actual draw rate: 24/102 = 24%
- Latest graded match: Argentina 2–1 England, 2026-07-15

Not run in this audit (need keys / long / optional): `npm run test:gemini-agent` (offline, no key), `npm run evolve`, `npm run dc:backtest` (writes reports), `npm run build`, live `npm run dev` against Atlas.

### AI Lab (`world-cup-ai-lab`)

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run validate` | pass (48 teams, 72 group matches, 1X2 sums to 1) |
| `npm run validate:model` | pass with **1 warning**: bundled backtest uses EXAMPLE data |
| `npm run validate:news` | pass (4 production news items) |
| `npm run validate:results` | pass (72 completed group-stage results) |
| `npm run validate:access` | **FAIL — 4 checks** |

`validate:access` failures are a product/test mismatch, not an engine crash: the access/paywall tests still assume “results map empty by default / upcoming matches are sellable”, but `lib/seed/wc2026-results.ts` now records all 72 group matches as completed. The commercial gate and the results seed have drifted.

Not run (long / data-heavy): `backtest:worldcups`, `backtest:model-variants`, `data:import`. Those scripts exist and are the lab’s real research value.

### Working-tree notes

- Oracle `main` is clean vs `origin/main`.
- AI Lab is **not** on `main`. It is on `integration/feature-audit-20260614` with a dirty marketing/video working tree. That branch is a donor snapshot, not a production base.

---

## 1. What each repository actually is

```text
Hicruben/world-cup-2026-prediction-model
        │
        ├── worldcup-oracle-agent     ← AGENT + PRODUCT + LIVE WC2026 OPS
        │     Next.js 15 · MongoDB Atlas · DeepSeek/Gemini
        │     stacked match engine · official 2026 bracket
        │     news agent · live elimination gating
        │     /accuracy track record · Python ridge-DC betting lab
        │
        └── world-cup-ai-lab          ← RESEARCH LAB + FREEMIUM DASHBOARD
              Next.js 15 · optional Supabase/Stripe
              same Elo/DC core · Model V2 + ensemble
              historical internationals pipeline
              paywall / match explorer / marketing kit
```

They are **siblings**, not parent/child. Blind-merging them would fight two product identities.

---

## 2. Oracle Agent — architecture (code, not README)

### 2.1 Directory map

```text
worldcup-oracle-agent/
├── app/                         # Next.js App Router
│   ├── page.tsx                 # agent chat (the product)
│   ├── news/  memory/  schedule/  accuracy/
│   └── api/agent/predict        # runAgent
│       api/agent/gemini-tools   # Gemini function-calling loop
│       api/news/*  api/memory/*  api/accuracy  api/predictions/recent
├── lib/
│   ├── agent/                   # planner → resolvers → impact → sim → explain
│   ├── prediction-engine/       # statistical core + WC2026 layers
│   ├── news/                    # multi-provider ingest + classifier + store
│   ├── llm/                     # DeepSeek default, Gemini escalation + tools
│   ├── live-sports/             # football-data.org / API-Football + gating
│   ├── db/mongodb.ts            # predictions + team_news + live cache
│   ├── data-truth/              # provenance + freshness
│   ├── i18n/                    # 5-language voice + localization
│   ├── schedule/                # group fixtures + standings + qualification
│   └── seed/                    # 2026 groups, recorded results, daily news
├── betting-backtest/            # independent Python ridge-DC + edge engine
├── scripts/                     # 20+ invariant test scripts + backtest/evolve
└── docs/
```

There is **no competition abstraction**. The World Cup *is* the architecture.

### 2.2 Prediction pipeline (live path)

```text
query
  → planQuery()                         lib/agent/planner.ts
  → resolveTeams / news / scenario      lib/agent/matchResolver.ts, newsResolver.ts
  → analyzeNewsImpact()                 lib/agent/impactAnalyzer.ts   (capped 1X2 nudge)
  → predictMatch()                      lib/prediction-engine/engine.ts
       getUpdatedRating()               ratingUpdates.ts   (K=60, date-ordered)
     + getAvailabilityDelta()           availabilityAdjustments.ts  (value-weighted, cap ±55)
     + getConfederationDelta()          confederationForm.ts
     + getTacticalMatchup()             tacticalMatchups.ts         (per-fixture, cap ±30)
     + getIntelDelta()                  preMatchIntelligence.ts     (fixture-scoped, cap ±35)
     + getBounceBack()                  bounceBack.ts
     + gapCalibration()                 confidenceCalibration.ts    (GAP_SCALE=1.10, cap ±30)
     + homeBonus()                      HOST_SLUGS × HOME_ADVANTAGE
     → matchProb()                      elo.ts  (DC ρ = −0.13, 0–8 grid)
     → applyDrawPropensity()            drawPropensity.ts  (group fixtures only)
  → runSimulation()                     lib/agent/simulator.ts  (10k, mulberry32)
  → narrate (DeepSeek/Gemini/template)
  → savePrediction()                    lib/db/mongodb.ts
```

Closed-form 1X2 comes from Dixon-Coles. Monte Carlo is a **seeded visualisation and tournament sampler**, not the source of single-match probabilities.

The **live card, the tournament sampler, and the published 68% track record are three different stacks**:

| Surface | Ratings + layers | 1X2 source |
| --- | --- | --- |
| `predictMatch` (chat card) | results + avail + confed + tactical + **intel** + bounce + **stakes** + gap-cal + group-draw | closed-form DC, then agent news nudge (±10pp, skips `modelled` items) |
| Tournament / group MC | results + avail + confed + tactical + **intel** + bounce + gap-cal. **No stakes, no news, no τ in `sampleMatch`** | independent Poisson samples |
| `/accuracy` `+cal` (68%) | results (date-strict) + avail (**current** table) + confed (walk-forward) + tactical (**current** styles) + bounce + draw + gap-cal. **No intel, no stakes, no news** | closed-form DC |

Do not advertise the agent line as the backtest line. League season MC must condition on remaining fixtures; the WC title board does not.

### 2.3 Statistical models that actually exist

| Model | File | What the code does |
| --- | --- | --- |
| Elo win expectancy | `lib/prediction-engine/elo.ts` `expectedScore` | logistic, 400-scale |
| Elo → λ | `elo.ts` `expectedGoals` | `1.35 + diff/350`, clamped `[0.3, 3.5]` |
| Dixon-Coles τ | `elo.ts` `dcTau` / `matchProb` | real τ on (0,0)(0,1)(1,0)(1,1), **ρ = −0.13** |
| Scoreline grid | `elo.ts` `scorelineGrid` | 9×9, normalised |
| Seeded MC sample | `elo.ts` `sampleMatch` + `mulberry32` | knockout `allowDraw=false` nudges via Elo expectancy |
| Frozen base ratings | `ratings.ts` | 48-nation table from Hicruben 920-match calibration + 9 play-off priors |
| Walk-forward Elo | `ratingUpdates.ts` | K=60, no GD multiplier, host bonus included |
| Official 2026 MC | `engine.ts` `simulateTournament` + `bracket-2026.ts` | 12 groups, best-8 thirds, Annex C matching, 10k sims |
| Independent fitted DC | `betting-backtest/dc_model.py` | attack/defence, γ home, ρ, **ridge MLE**, LOO, stdlib only |

**There is no true shot-based xG model.** UI copy says “expected goals / xG”. The number is Elo-derived λ. Same in AI Lab.

### 2.4 Agent orchestration

`lib/agent/index.ts` `runAgent` is a real pipeline, not an LLM wrapper.

**Deterministic intents** in `planner.ts`: match-prediction, champion-odds / tournament-forecast, scenario, tiktok-preview, team-news, group-qualification, path-analysis, team-analysis, team-comparison, rules-explanation, model-explanation, unknown/clarification.

**Hard scope guard** — this is the single most important line for the Big Five migration:

```ts
// lib/agent/planner.ts
const OTHER_COMP_RE =
  /\b(euros?\s*(20\d\d)?|uefa euro|champions league|europa league|premier league|la liga|serie a|bundesliga|copa am[eé]rica|nations league|club world cup|olympics?|gold cup|afcon)\b/i;
```

`isOutOfScopeCompetition()` **rejects Premier League / La Liga / Serie A / Bundesliga by design**. Tests lock this in (`test-llm-routing.ts`).

**The reject list is incomplete.** Ligue 1, EPL, MLS, Eredivisie, Liga MX are not in `OTHER_COMP_RE`. A query like “Arsenal vs Chelsea” also never hits the regex — it falls through to `unknown` only because there is no club resolver. Inverting the guard for Phase 1 is not just deleting the regex; the planner must become competition-aware, and Ligue 1 must be treated as a first-class Big Five config even though today’s reject list forgot it.

LLM layer (`lib/llm/provider.ts`):

- DeepSeek = default narrative / intent polish / zh localization
- Gemini = complexity escalation (path, group/best-third, combined rules)
- Gemini tool loop (`geminiAgent.ts`): `resolve_team`, `predict_match`, `get_team_news`, `get_tournament_state`
- Numbers stay engine-owned. Fail-soft if no keys.

### 2.5 Data ingestion

| Source | Role | Code |
| --- | --- | --- |
| Manual recorded results | offline source of truth for Elo + track record | `lib/seed/recorded-match-results.ts` (102 matches through 15 Jul) |
| football-data.org | live fixtures / results / elimination | `lib/live-sports/footballData.ts` — `FOOTBALL_DATA_COMPETITION` **defaults to `"WC"`** |
| API-Football | fixtures + injuries | `lib/live-sports/apiFootball.ts` — `API_FOOTBALL_LEAGUE_ID` **defaults to `1`** (World Cup) |
| GNews / NewsAPI / SerpAPI / GCS | contextual news only | `lib/news/newsProvider.ts` |
| Keyword classifier | category / impact / direction | `lib/news/newsClassifier.ts` |
| Mongo `team_news` | persist classified signals | `lib/news/teamNewsStore.ts` |
| Vercel cron | daily `/api/news/refresh` at 06:00 UTC | `vercel.json` |

**League-shaped hooks already exist as env vars** (`FOOTBALL_DATA_COMPETITION`, `API_FOOTBALL_LEAGUE_ID`, `API_FOOTBALL_SEASON`) but every consumer still assumes 48 national teams and a World Cup.

### 2.6 Feature engineering (Oracle-only layers)

These are **not** in AI Lab, and several are World-Cup-specific:

| Layer | File | League-portable? |
| --- | --- | --- |
| Value-weighted player availability | `availabilityAdjustments.ts` | **yes** (best injury model of the two) |
| 2-axis tactical clash (lowBlock × breakdown) | `tacticalMatchups.ts` | yes, if restyled for clubs |
| Fixture-scoped pre-match intel | `preMatchIntelligence.ts` | yes (time-boxed, does not leak across fixtures) |
| Group-draw propensity + kill/fortress | `drawPropensity.ts` | **no as-is** (WC group openers). Idea of a draw-mass layer is portable |
| Final-matchday rotation / stakes | `matchStakes.ts` | **no as-is**. Dead-rubber idea exists in leagues but needs a new definition |
| Bounce-back after under-performance | `bounceBack.ts` | weak for a 38-game season; **do not port blindly** |
| Confederation form | `confederationForm.ts` | **no** (no confederations in a domestic league) |
| Gap calibration | `confidenceCalibration.ts` | protocol yes; **constants must be re-fit** |
| Match-type classifier (fade / trust / coin-flip) | `matchType.ts` | yes, as a label layer |
| Discipline / fair-play | `discipline.ts` | WC qualification only; cards matter in leagues differently |
| Official Annex C bracket | `bracket-2026.ts` | **World Cup plugin only** |

### 2.7 Evaluation / backtesting

- `lib/prediction-engine/trackRecord.ts` is the **single source of truth** for `/accuracy`, `scripts/backtest.ts`, and `test-track-record.ts`. Walk-forward: predict match *t* from results with date `< t`. Seven cumulative variants, so each layer has to earn its keep.
- `scripts/evolve.ts` grid-searches `gapScale` × `drawBoost` walk-forward.
- Python `dc_model.py` is a **second, independently specified** Dixon-Coles (attack/defence MLE + ridge chosen by LOO log-loss). It is not a stub.
- `betting-backtest/` scores **pre-recorded** predictions against prices. Edge = `model_prob − 1/price` (vig already inside the price). Default is **NO BET**. Sample prices are synthetic.

Limitation: the TS backtest universe is **only the 102 completed 2026 World Cup matches**. It does not walk through a multi-year club history.

### 2.8 Storage

MongoDB Atlas, db `worldcup_oracle`:

- `predictions` — every intent
- `team_news` — classified signals
- `team_state` / `live_fixtures` / `live_injuries` — live cache

Fail-soft `globalThis` memory store if Atlas is unreachable. `scripts/setup-mongo.ts` creates indexes.

### 2.9 Frontend

Agent product, not a match catalogue:

- `/` chat + reasoning timeline + prediction card + news impact + simulation + transparency
- `/news` daily team news
- `/memory` Mongo-backed session browser
- `/schedule` verified fixtures, TBA if unknown (does not invent kickoff/venue)
- `/accuracy` live track record

Dark “stadium-night” theme. Voice in EN / zh / es / pt / ja.

### 2.10 Deployment

Vercel. `vercel.json` daily news cron. Zero-config demo mode. Live demo: https://worldcup-oracle-agent.vercel.app

### 2.11 World-Cup-specific assumptions (must be generalized)

1. 48 nations, 12 groups of 4, top-2 + 8 best thirds = 32.
2. FIFA group order: points → **overall GD → overall GF → then H2H**. Last resort in code is **Elo + slug**, not FIFA ranking (README overclaims).
3. Official R32 slots + Annex C bipartite matching (`bracket-2026.ts`).
4. Host nations USA / Mexico / Canada get `HOME_ADVANTAGE` regardless of the actual venue (`engine.ts` `homeBonus`).
5. Ratings table is 48 national-team slugs.
6. Knockout draws resolve via Elo-weighted extra-goal nudge, not 1X2.
7. Planner rejects Big Five league questions.
8. Live APIs default to WC competition codes.
9. Confederation form, best-third qualification, champion/path intents.
10. Mongo db name, copy, screenshots, Devpost positioning.

### 2.12 Existing league support

**None as a product.** Only:

- env knobs that *could* point at another football-data.org / API-Football competition
- an explicit **rejection** of league queries

football-data.org already uses competition codes `PL`, `PD`, `BL1`, `SA`, `FL1`. That is the cheapest live-data on-ramp.

### 2.13 Technical debt

- Many engine layers are **hand-curated 2026 priors** (tactical scores, availability entries, intel). They work because a human updated them during the tournament. A 380-match Big Five season cannot be operated that way.
- `HOME_ADVANTAGE` is a host-nation flag, not true home/away.
- `DC_RHO = -0.13` is inherited, not re-tuned on the 102-match sample (AI Lab retuned to −0.16 on 2,544 internationals).
- Agent planner is regex-heavy; works, but will need a competition-aware rewrite.
- Results seed is a large TypeScript file, not a database of fixtures.
- No model version constant in the TS engine (Python DC writes `model_version: "DC-ridge-LOO"`).
- Betting lab sample odds are synthetic; no live odds ingest.
- Tests are `tsx` scripts, not a test runner (`vitest`/`jest`). They are good, but not CI-standard.

### 2.14 Leakage risks (Oracle)

**Well-handled**

- `trackRecord.ts` / `backtest.ts`: date-strict walk-forward.
- `preMatchIntelligence.ts`: `expiresAfterMatch`; tests prove Partey intel does **not** leak to Ghana’s later fixtures.
- `completedFixtures.ts`: already-played fixtures are labelled retrospective.
- `freshness.ts` / honesty tests: stale results get a warning; betting-advice language is blocked.
- Python DC LOO really refits without the held-out match (`dc:selftest` asserts this).
- Provenance: `verified: true` without a source is downgraded.

**Residual risk**

- Base Elo in `ratings.ts` was calibrated on internationals **through May 2026**. Using those ratings to “predict” June–July 2026 is fine for a tournament that started after the calibration window; **reusing the same national-team Elo for club sides would be a silent, severe leak / category error**.
- Availability / tactical / intel tables were updated **after** some of the matches they describe (comments dated 16 Jun, 2 Jul, 16 Jul). The walk-forward backtest **does** recompute injuries/tactical from the live tables for every historical match, so a late-tournament injury list can slightly contaminate early-match counterfactuals. Caps keep this small; it is still not a pure as-of-match availability tape.
- Confederation form is computed from the **same tournament’s** residuals (shrunk). It is a within-tournament prior, not a pre-tournament feature.
- `GAP_SCALE` and `GROUP_DRAW_BOOST` were grid-searched on the same WC sample they later score (`evolve.ts`). The code shrinks off the grid edge; it is still in-sample regularization, not a disjoint holdout.
- Live `predictMatch` includes intel + match-stakes + (in the agent) a news 1X2 nudge. The published `+cal` 68% track record **does not include news or stakes**. Do not advertise the agent line as the backtest line.
- Tournament title odds replay **all 12 groups from scratch**. `gateChampionOdds` **removes** eliminated teams from the list; it does **not** re-simulate the remaining knockout tree and it does **not** renormalise the leftover percentages (they no longer sum to 1). After the semis, champion % is still a pre-tournament prior with names deleted.
- The chat path for an already-played fixture still runs the full stacked `predictMatch` (whose Elo updates include **that** match via `ALL_MATCH_RESULTS`) and then slaps an “already played” banner. The honest pre-match number lives only in `trackRecord.ts` / `/accuracy`.
- `fetchInjuries()` writes `live_injuries` and nothing in the prediction engine reads it. Injuries that move Elo are the hand-curated availability / intel tables.
- News search is hardcoded: `queryFor()` = `"${name}" AND ("World Cup" OR "national team")`. `TRACKED_TEAMS` is 10 nations, not 48.
- `docs/MODEL_EVALUATION.md` is stale (n=32). `/accuracy` and `npm run backtest` are current (n=102). Do not cite the markdown file.
- README “two models landing on the same number” is overstated. The TS live stack is 68% top-pick walk-forward; the Python ridge-DC LOO in `betting-backtest/reports/dc_latest.md` is **58.8%** on the same 102 matches (different model, LOO not time-ordered). Both beat uniform. They are not the same number.

---

## 3. AI Lab — architecture and donor inventory

### 3.1 What it actually is

A **freemium World Cup dashboard**: `/matches`, `/groups`, `/tournament`, `/teams/[slug]`, Stripe unlock, Supabase optional, lots of marketing. Engine lives in `lib/prediction-engine/`. Research lives in `lib/backtesting/` + `scripts/`.

There is **no agent**. There is **no MongoDB**. There is **no live sports client**. Predictions compute from bundled ratings + optional curated news.

### 3.2 Components that look like Oracle’s — and which one wins

| Piece | AI Lab | Oracle | Winner |
| --- | --- | --- | --- |
| `elo.ts` core | same port, **ρ = −0.16**, plus `matchProbFromGoals` | ρ = −0.13, no from-goals API | **Oracle for production path**; **AI Lab API is better** |
| `ratings.ts` | same 48-nation table | same + live `ratingUpdates` | **Oracle** (learns from results) |
| `simulateTournament` | generic sporting-merit knockout (README admits this) | official 2026 bracket + Annex C | **Oracle** |
| Tactical | possession-vs-low-block, +40 to underdog | 2-axis frustration, zero-sum, tested | **Oracle** |
| Availability | squad-value factor, cap −50, curated overrides | value-vs-replacement + role weights, cap ±55, tested | **Oracle** |
| News → model | verified-only Elo ±25 | live multi-provider + capped 1X2 nudge + Mongo | **Oracle** |
| Home advantage | venue-aware host ladder (CONCACAF/CONMEBOL) | flat host-nation ±75 | neither is league-ready; **AI Lab’s *shape*** (venue-aware, capped, positive-only) is the better design to reimplement as true home/away |

### 3.3 Donor classification

Legend: **MIGRATE** = copy/adapt. **REIMPLEMENT** = keep the idea, rewrite against league data. **IGNORE** = do not take. **ALREADY_SUPERSEDED** = Oracle is strictly better.

| Component | Path | Classification | Why |
| --- | --- | --- | --- |
| Historical results pipeline | `scripts/import-historical-results.ts`, `data/raw/international-results.csv`, `data/sources.json` | **MIGRATE** (pattern + provenance file). Raw file is **internationals**, not clubs — do not train a PL model on it. | Only real ETL + `sources.json` honesty layer in either repo. |
| Team-strength profile builder | `scripts/build-team-strength-profiles.ts`, `team-strength.ts` | **REIMPLEMENT** | Attack/defence split + recency-weighted form, hard caps, uncertainty flags. Rebuild on club results. |
| Model V2 | `model-v2.ts` | **REIMPLEMENT** (phase 2+) | Multiplicative λ = base × attack × defenceWeakness × context. Header still calls it experimental; **customer 1X2 on the site is the ensemble that includes it**. Shipped V2 reads a frozen profile JSON; the backtest that justified the ensemble walk-forward-updates attack/defence (`GOAL_K=18`). Do not treat the 8k-match claim as a proof of the shipped function. |
| Ensemble + draw calibration | `ensemble.ts`, `DRAW_LOG_BIAS = -0.12` | **REIMPLEMENT** (phase 2) | 50/50 + `e^(−0.12)` draw shrink. **This is what `lib/data.ts` / `/api/predictions/run` / snapshots actually serve.** Tournament MC and `getMatchInsights()` still use raw `predictMatch`. Must be re-validated on league data; do not copy the constant. |
| Walk-forward backtest harness | `lib/backtesting/backtest.ts` | **MIGRATE** | Chronological Elo rebuild from the sample itself (does **not** use the 2026 calibrated table — correctly avoids that leak). Metrics: log-loss, Brier, ECE, scoreline top-1/3. This is the right skeleton for Big Five seasons. |
| Competition-importance K | `baseK()` in `backtest.ts` | **MIGRATE** then retune | WC 55 / qual 40 / continental 50 / NL 32 / friendly 18 / default 28. For leagues: league 20–30, domestic cup, UCL, etc. |
| Goal-difference Elo multiplier | `gMult()` | **MIGRATE** | Oracle’s `ratingUpdates` has no GD term. Small, standard, worth taking. |
| `matchProbFromGoals` / `scorelineGridFromGoals` | `elo.ts` | **MIGRATE** | Lets any λ model reuse DC τ. Oracle should have this. |
| ρ tune protocol | `scripts/tune-rho.ts` | **MIGRATE** | Oracle’s −0.13 is un-retuned. Re-run on league data. |
| Calibration experiment protocol | `scripts/experiment-calibration.ts`, `docs/MODEL_SURVEY.md` | **MIGRATE** (protocol, not constants) | Temporal holdout discipline is the thing to steal. |
| Model auditor | `lib/model-auditor/audit.ts` | **MIGRATE** | Checks 1X2 sum, confidence/upset consistency, “guaranteed” / betting wording. Cheap safety net. |
| `MODEL_VERSION` | `lib/model-meta.ts` (`1.6.0`) | **MIGRATE** | Oracle has no engine-level version string. |
| Data-quality / validate-sources | `scripts/validate-data-sources.ts`, `data-quality-report.ts` | **MIGRATE** (pattern) | Caps, provenance, honesty about community vs official. |
| Context-advantage | `context-advantage.ts` | **REIMPLEMENT** | Venue-aware, capped, never invents venue. The CONCACAF/CONMEBOL rungs are WC2026-specific — replace with **true home/away + rest/travel later**. |
| News validation workflow | `lib/news/news-validation.ts`, `docs/NEWS_WORKFLOW.md` | **MIGRATE** (rules) | `verified=false` cannot move Elo; future `publishedAt` rejected. Oracle’s live classifier is looser. |
| Squad availability (AI Lab) | `squad-availability.ts` | **ALREADY_SUPERSEDED** | Oracle’s value-weighted version is richer and tested. |
| Tactical matchup (AI Lab) | `tactical-matchup.ts` | **ALREADY_SUPERSEDED** | Oracle’s 2-axis model + first-round re-score + tests. |
| News Elo adjustment | `news-impact.ts` | **ALREADY_SUPERSEDED** | Oracle has a live ingest path. Keep AI Lab’s “unverified news cannot move the model” rule. |
| Team chemistry | `team-chemistry.ts` | **IGNORE** | Opt-in, curated, weaker than availability. |
| Generic tournament MC / `projectBracket` | `engine.ts` | **ALREADY_SUPERSEDED** | Oracle’s official bracket is the WC plugin. League season MC is a new module. |
| Stripe / Supabase / paywall / unlock | `lib/access.ts`, `lib/stripe.ts`, `app/api/checkout` | **IGNORE** | Different product. Do not drag billing into a forecast agent. |
| Marketing / post-match video factory | `marketing/` (~tens of MB, dirty tree) | **IGNORE** | Content ops, not a model. |
| Legal/pricing pages | `app/terms`, `lib/pricing.ts` | **IGNORE** | |
| Example historical datasets | `data/historical/*.example.ts` | **IGNORE** as evidence | Auditor correctly warns `EXAMPLE_DATA`. |
| Freemium match UI | `components/prediction/*`, `/matches` | **IGNORE as architecture** | A few cards (probability bars, scoreline chart) can be reused later; do not take the paywall shell. |
| Demo-video Playwright harness | `scripts/record-demo-video.ts` | **IGNORE** for v1 | Nice, not load-bearing. |

### 3.4 AI Lab World-Cup assumptions

Same 48-team seed (`lib/seed/world-cup-2026-groups.ts`). Tournament MC uses **sporting-merit reseeding**, not FIFA’s published R32 table (README is honest). Results seed stops at **group stage (72 matches, through 27 Jun)** — Oracle continued through the 15 Jul semi-finals (102). No club/league support.

### 3.5 AI Lab leakage / honesty

**Good**

- Backtest rebuilds Elo from the historical sample; does not reuse `ELO_RATINGS` (comment in `backtest.ts` is explicit about the 2022 leak this avoids).
- V2 profiles fall back to identity decomposition; “nothing is invented”.
- News must be verified + sourced to affect Elo.
- Model auditor flags example-data backtests.

**Weak**

- Production pages still sit on the **frozen May-2026 national Elo**, not the walk-forward historical engine. Ratings never update from the 72 recorded group results (`K_FACTOR_WC` is exported and unused).
- README / `/lab` still say V2 is “off for all customer-facing pages”. **Code disagrees:** `lib/data.ts` line 69 calls `predictMatchEnsemble`. Insights and `review-model.ts` still use raw `predictMatch`. The site, the insights rail, and the review script can disagree.
- Shipped V2 is **not** the walk-forward V2 that justified the ensemble. Backtested V2 (`model-variants.ts`) updates attack/defence with `GOAL_K = 18`. Shipped V2 reads a **frozen** `team-strength-profiles.json` (`datasetEnd: 2026-06-10`). The claimed 8,108-match gain is not the function the site runs. Do not migrate V2 as a proven production model.
- `validate:access` is now lying relative to recorded results.
- README “xG” is Elo λ, same as Oracle.
- Working tree is a marketing branch, not a clean research tip.

---

## 4. Capability matrix (code vs code)

| Capability | Oracle Agent | AI Lab | Best implementation | Action |
| --- | --- | --- | --- | --- |
| Data pipeline | Manual TS seeds + live football-data.org / API-Football (WC defaults) | Real ETL from martj42 internationals + `sources.json` | **Split:** Oracle for live APIs; AI Lab for historical ETL *pattern* | **MIGRATE** AI Lab pattern; **new** club-results source (football-data.org / API-Football seasons). Do **not** train leagues on martj42. |
| Elo | Frozen 48-nation table + K=60 walk-forward on WC results | Same frozen table; historical backtest rebuilds Elo with importance K + GD mult | **Oracle** for live learning; **AI Lab** for historical harness | Keep Oracle updater; **MIGRATE** `baseK` + `gMult`; rebuild ratings from **club** history |
| Dixon-Coles | Real τ, ρ=−0.13, 0–8 grid; plus **fitted ridge DC in Python** | Real τ, ρ=−0.16 (tuned on 2.5k internationals); `matchProbFromGoals` | **Oracle Python DC** is the only *fitted* DC; **AI Lab TS DC API** is cleaner | **MIGRATE** `matchProbFromGoals`; **REIMPLEMENT** ρ / attack-defence fit on league goals; keep Python DC as independent cross-check |
| Monte Carlo | 10k seeded match sim + **official** 48-team tournament. `sampleMatch` is **independent Poisson** (no τ). Title odds **replay the whole tournament from scratch**; `gateChampionOdds` **removes** eliminated teams and does **not** renormalise. | 10k seeded + generic merit reseed; same independent-Poisson `sampleMatch`; ensemble unused in MC | **Oracle bracket rules**; **neither** MC matches its closed-form 1X2 | Keep seeded PRNG. **Sample from the DC grid** in the successor. Tournament MC is a WC plugin. League season table MC is new and must condition on remaining fixtures. |
| xG | Elo λ, labelled “xG” | Elo λ + V2 multiplicative λ, still **goal-based, not shot-xG** | Neither is real xG | **Do not claim xG.** Optional later: Understat/FBref shot xG as a feature, not a rename. |
| Injury / availability | Value-vs-replacement + role weights, sourced, tested, cap ±55; API-Football injuries cached | Squad-value factor, curated, cap −50 | **Oracle** | Keep Oracle; automate from API-Football `/injuries` per league. |
| Tactical / style | 2-axis lowBlock×breakdown, first-round re-score, tests | Possession-vs-low-block underdog bump | **Oracle** | Keep; restyle as club profiles, stop hand-editing every matchday. |
| News → model | Live providers + classifier + Mongo + capped 1X2 nudge | Curated verified items → Elo ±25; empty-by-default safer | **Oracle pipeline** + **AI Lab eligibility rule** | Keep Oracle ingest; **MIGRATE** “unverified cannot move numbers”. |
| Market odds | Full decision engine (edge vs raw price, NO-BET default); **sample prices only** | Explicitly none (`MODEL_SURVEY.md`: “No odds data in this repo.”) | **Oracle** | Keep engine; **new** odds ingest (The Odds API / book CSV). Without prices this is not a betting system. |
| Calibration | Walk-forward ECE 5.0% on 102 WC matches; gap-scale 1.10 (shrunk from 1.24) | Ensemble draw-shrink on 8k internationals; ECE ~0.025 claimed | **Oracle** for *this* engine; **AI Lab** for large-N protocol | Re-fit everything on league holdouts. Copy neither constant. |
| Backtesting | Superb on 102 WC matches + layer ablation + evolve grid | General walk-forward over multi-year internationals + variant harness | **Both, different jobs** | **MIGRATE** AI Lab harness as the Big Five evaluator. Keep Oracle `/accuracy` as the live matchday page. |
| Agent layer | Full: planner, tools, memory, i18n, honesty, elimination gating | None | **Oracle** | Backbone. Generalize intents; invert the league scope guard. |
| Provenance | `data-truth/provenance.ts` + freshness + honesty tests | `sources.json` + news validation + auditor EXAMPLE_DATA warning | **Both complementary** | Keep both patterns. |
| Model versioning | Only Python `model_version` | `MODEL_VERSION = "1.6.0"` + parameter card | **AI Lab** | **MIGRATE** |
| UI | Agent chat + memory + accuracy + news | Freemium match explorer + tournament + paywall | **Oracle** as product shell | Do not take Stripe UI. Optionally later: a league table / match list page. |
| Deployment | Vercel + Atlas + cron; live | Vercel-ready; Stripe/Supabase optional; access tests currently red | **Oracle** | Stay on this stack. |
| League / club support | Explicitly out of scope | None | **Neither** | The entire point of the successor. |
| Tests | 20+ scripts, all green, plus bracket 495/495 | validate/* mostly green; `validate:access` red | **Oracle** | Keep Oracle test style; add league fixtures. |

---

## 5. What Oracle already does well

1. **It is a working agent, not a notebook.** Planner → tools → deterministic numbers → optional LLM prose → Mongo memory.
2. **The statistical core is real Dixon-Coles**, not a named stub, and it is wrapped in a stack that was **ablated walk-forward** on 102 live World Cup matches.
3. **Honesty infrastructure is unusually good:** provenance downgrade, freshness footnotes, completed-fixture retrospective, betting-language block, elimination gating that the LLM cannot override.
4. **Live data path exists** (football-data.org / API-Football) with fail-soft cache. Competition is already an env var.
5. **Independent second model** (Python ridge-DC + LOO) plus a **price-disciplined** betting engine (NO-BET default, edge vs vig-laden price).
6. **Test surface is production-grade** for a hackathon-born repo. We re-ran it; it is green.
7. **Product is already deployed.** Do not throw away the agent UI, i18n, or memory.

These are the reasons Oracle is the backbone.

---

## 6. What AI Lab contains that is worth rescuing

1. **A historical walk-forward harness that does not leak the calibrated 2026 Elo table** (`lib/backtesting/backtest.ts`). This is how a 380-match × 5-league system must be scored.
2. **`matchProbFromGoals` / `scorelineGridFromGoals`** — small, correct, immediately useful.
3. **Attack/defence decomposition + ensemble + temporal-holdout calibration protocol** — as a *research track*, not as the v1 production path.
4. **`sources.json` + profile uncertainty flags + model auditor + `MODEL_VERSION`.**
5. **Importance-weighted K and GD multiplier** for Elo updates.
6. **The rule that unverified news cannot move Elo.**
7. **Venue-aware, capped, “never invent the venue” home-advantage *shape*** (not the CONCACAF numbers).

That is the entire rescue list. Everything else is either weaker than Oracle or is a different product (paywall, marketing).

---

## 7. What should be discarded

| Discard | From | Reason |
| --- | --- | --- |
| Stripe / Supabase / signed-cookie paywall | AI Lab | Wrong product. |
| `marketing/` and post-match video factory | AI Lab | Content ops; dirty working tree. |
| Team chemistry signal | AI Lab | Redundant and weaker. |
| AI Lab tactical + availability modules | AI Lab | Superseded. |
| AI Lab generic knockout reseeding as “the” tournament engine | AI Lab | Oracle already has the official WC plugin. |
| Using martj42 internationals as Big Five training data | AI Lab | Wrong sport-population. Keep the *pipeline*, change the *source*. |
| Confederation form, Annex C, best-third, host-nation bonus, bounce-back, WC group-draw boost as global engine layers | Oracle | Keep as `competitions/world-cup` plugins. |
| Planner’s “leagues are out of scope” rule | Oracle | Invert it. |
| Claiming “xG” for Elo λ | both | Rename to expected goals. |
| Blind-copy of GAP_SCALE=1.10, DC_RHO, DRAW_LOG_BIAS | both | Re-fit or they are decoration. |
| Rewriting Oracle’s agent / Mongo / live gating | — | Working. Do not. |

---

## 8. World-Cup assumptions that must be generalized

| Assumption today | League reality |
| --- | --- |
| Team = nation slug (`argentina`) | Team = club + season (`arsenal-2025`) |
| 48-team closed field | Promotion, relegation, 18–20 clubs, winter window |
| Host-nation Elo bonus | True home / away / neutral |
| 3-match groups + knockout | 34–38 match double round-robin; no “champion MC” of the same shape |
| FIFA GD-before-H2H | League-specific tiebreakers (PL: GD then GF; La Liga: H2H first, etc.) |
| Best-third / Annex C | Does not exist |
| Confederation form | Replace with league-table form / remaining schedule strength |
| Final-group-match rotation | Optional: already-safe / already-relegated rest risk, late season only |
| Group-draw inflation | League draw rates differ by league and by month; re-estimate |
| Knockout `allowDraw=false` | League matches can draw; cups are a separate competition config |
| News about “national team camp” | Club news, lineups, manager quotes |
| `FOOTBALL_DATA_COMPETITION=WC` | `PL` / `PD` / `BL1` / `SA` / `FL1` |
| Intent: “who wins the World Cup?” | Intent: “who wins the league?”, “will X finish top 4?”, “relegation odds” |

---

## 9. Recommended architecture for the Big Five system

**Do not rewrite `worldcup-oracle-agent` in place.**

The recoverable World Cup product is tagged:

```text
worldcup-oracle-agent  tag  archive/worldcup-2026-v1  @ 9e540b3
```

Create a **new repository** (or a new sibling directory) from that tag:

```text
football-oracle-agent          ← new generalized product
worldcup-oracle-agent          ← frozen World Cup product (this repo)
world-cup-ai-lab               ← donor only, do not merge
```

Target shape:

```text
football-oracle-agent/
├── prediction-engine/         # Elo, Dixon-Coles, MC sampler, calibration
│                              # (move of lib/prediction-engine, WC layers extracted)
├── data/                      # ingest, normalize, store fixtures/results/odds
├── features/                  # availability, tactical, form, home/away, rest
├── markets/                   # odds ingest + betting-backtest decision engine
├── evaluation/                # walk-forward harness (from AI Lab) + /accuracy
├── agents/                    # current lib/agent + llm + news + memory
└── competitions/
      ├── world-cup/           # current bracket, groups, host bonus, Annex C
      ├── premier-league/
      ├── la-liga/
      ├── bundesliga/
      ├── serie-a/
      └── ligue-1/
```

A competition config should own, at minimum:

```ts
type CompetitionConfig = {
  id: "premier-league" | "la-liga" | "bundesliga" | "serie-a" | "ligue-1" | "world-cup";
  kind: "league" | "tournament";
  footballDataCode: "PL" | "PD" | "BL1" | "SA" | "FL1" | "WC";
  apiFootballLeagueId: number;
  season: number;
  teamKind: "club" | "nation";
  homeAdvantage: { mode: "true-home-away" | "host-nations"; elo: number };
  tiebreakers: Array<"points" | "h2h" | "gd" | "gf" | "fair-play">;
  allowDrawInCompetition: boolean;       // true for leagues
  monteCarlo: "season-table" | "tournament-bracket";
  outOfScope: boolean;                   // false for Big Five
};
```

World Cup becomes **one config**, not the centre.

**What stays as-is (copy forward):**

- `lib/agent/**` (then generalize planner)
- `lib/llm/**`, `lib/db/mongodb.ts`, `lib/news/**`, `lib/i18n/**`
- `lib/prediction-engine/elo.ts` + `ratingUpdates.ts` + `availabilityAdjustments.ts` + `tacticalMatchups.ts` + `preMatchIntelligence.ts` + `confidenceCalibration.ts` (re-fit later)
- `lib/data-truth/**`
- `betting-backtest/**` (drop WC third-round flags into `competitions/world-cup`)
- Agent UI shell

**What moves behind `competitions/world-cup`:**

- `bracket-2026.ts`, `bracketPath.ts`, `seed/world-cup-2026-groups.ts`
- `drawPropensity.ts`, `matchStakes.ts`, `bounceBack.ts`, `confederationForm.ts`, `discipline.ts`
- Champion / path / best-third intents

**What is imported from AI Lab (selectively):**

- `lib/backtesting/**` → `evaluation/`
- `matchProbFromGoals` → `prediction-engine/elo.ts`
- `model-auditor` + `MODEL_VERSION`
- `sources.json` pattern
- `baseK` / `gMult` (retuned)
- ensemble / V2 **only after** a league backtest beats the Oracle stack

---

## 10. First implementation phase (do this next — and only this)

**Phase 0 — already done in this audit**

- [x] Inspect both repos against code
- [x] Run Oracle tests + backtest (green)
- [x] Run AI Lab validators (access tests red, documented)
- [x] Tag `archive/worldcup-2026-v1`
- [x] Write this file

**Phase 1 — scaffold `football-oracle-agent` without breaking the World Cup repo**

1. **Create the new repo from the tag**, do not convert `worldcup-oracle-agent`.
2. Introduce `competitions/` and a `CompetitionConfig`. Move WC-only modules behind `competitions/world-cup` so the World Cup product still runs in the new repo as a config.
3. **Invert the planner scope guard.** Premier League questions become in-scope when that competition is active.
4. Add **one** league first: **Premier League**.
   - Point `FOOTBALL_DATA_COMPETITION=PL` (already supported by the client).
   - New club directory (not the 48-nation table).
   - True home/away Elo bonus; delete host-nation logic for this config.
   - League table MC (points, GD, GF) instead of knockout MC.
5. **MIGRATE** AI Lab `runRollingBacktest` and score PL historical seasons walk-forward **before** adding Oracle’s WC-only layers (no confederation, no group-draw boost, no bounce-back). Do **not** reuse the 2026 tactical / availability tables as if they were as-of-match priors.
6. **MIGRATE** `matchProbFromGoals`, `MODEL_VERSION`, model auditor, and the **snapshot-at-view-time** idea (store 1X2 keyed by match + version; never recompute a “review” with later overlays).
7. Keep the agent chat as the UI. Add a thin “this weekend’s PL slate” list that deep-links `/?q=…` (Oracle already supports `?q=`).
8. Acceptance for Phase 1:
   - World Cup path still works via config (bracket tests still pass).
   - `worldcup-oracle-agent` at `archive/worldcup-2026-v1` is untouched.
   - PL walk-forward backtest produces Brier / RPS / log-loss / ECE on a held-out season.
   - Asking “who wins Arsenal vs Liverpool?” is in-scope; “who wins the World Cup?” still routes to the WC config if loaded.
   - No Stripe. No martj42-trained club ratings. No claim of shot-xG.

**Explicitly not in Phase 1:** V2 ensemble, live odds ingest, five-league fan-out, tactical club database, injury automation, season-long betting book.

---

## 11. Direct answers to the six pre-implementation questions

1. **What Oracle already does well** — §5. Agent architecture, honest live ops, a real stacked DC engine with a 102-match walk-forward track record, independent Python DC, price-disciplined betting lab, green tests, deployed product.

2. **What AI Lab is worth rescuing** — §6. Historical walk-forward harness, from-goals DC API, attack/defence + ensemble *protocol*, provenance/versioning/auditor, importance-K + GD Elo, unverified-news lock, venue-aware HA *shape*.

3. **What should be discarded** — §7. Paywall, marketing, superseded feature twins, WC-global layers, internatonals-as-league-data, copied calibration constants, xG branding.

4. **What World-Cup assumptions must be generalized** — §8. Nation/48/host/groups/Annex C/confederation/planner-reject-leagues.

5. **Exact architecture** — §9. New repo `football-oracle-agent`, Oracle backbone, competitions as config, World Cup demoted to a plugin, AI Lab only where demonstrably better.

6. **First implementation phase** — §10. New repo from the tag; PL only; true home/away; migrate the backtest harness; do not rewrite the World Cup product.

---

## 12. Decision rule going forward

- If a module is **green, used in production, and not WC-structural** → keep it.
- If a module is **WC-structural but good** → move it to `competitions/world-cup`.
- If AI Lab has a **demonstrably better evaluation or API** → migrate that file, not the app.
- If a number was fit on internationals or on 102 WC matches → **re-fit or freeze it out of the league path**.
- Do not merge the two git histories.

No large rewrite has been started. The next concrete step is Phase 1, in a new tree, from `archive/worldcup-2026-v1`.

---

## 13. Second-pass file-level corrections

A deeper file-by-file pass (after the first write-up) confirmed or tightened the following. None of these change the backbone decision or Phase 1 plan. They do change how honestly we describe both engines.

| Finding | Where | Implication |
| --- | --- | --- |
| AI Lab **customer 1X2 is the ensemble**, not Elo+DC | `lib/data.ts:69`, `lib/snapshots.ts`, `/api/predictions/run` | README / `/lab` / `model-v2.ts` header are stale. Do not treat V2 as unused. Tournament MC and `getMatchInsights()` still use `predictMatch` only — three surfaces, two models. |
| `sampleMatch` is independent Poisson in **both** repos | `elo.ts` in each | Closed-form 1X2 has τ; MC scorelines do not. Successor should sample the DC grid. |
| Oracle title odds do not condition on the live KO tree | `simulateTournament` + `gateChampionOdds` | After semis, champion % is still a pre-tournament prior. Eliminated teams are **removed**, leftover % are **not renormalised** (they no longer sum to 1). League season MC must update from remaining fixtures. |
| Oracle live stack ≠ published 68% stack | `engine.ts` vs `trackRecord.ts` | Intel, stakes, and the agent news nudge are not in `+cal`. Availability is current-time in the backtest. |
| Chat retrospective is not a pre-match forecast | `runAgent` + `ALL_MATCH_RESULTS` | Already-played fixtures still run stacked `predictMatch` (Elo includes that match) then add a banner. Honest number is `/accuracy` only. |
| API-Football injuries are cached and unused | `apiFootball.ts` / `tournamentState.ts` | `live_injuries` is never read by the engine. Automating injuries is new work, not a wiring job. |
| News query is WC-hardcoded; only 10 teams tracked | `newsProvider.ts` `queryFor`, `demoNews.ts` `TRACKED_TEAMS` | Must be rewritten for clubs. |
| Scope guard forgets Ligue 1 | `planner.ts` `OTHER_COMP_RE` | Invert + complete the list. Club names without a league keyword already fall through. |
| Shipped Lab V2 ≠ scored V2 | `model-v2.ts` vs `model-variants.ts` | Frozen profile JSON vs walk-forward `GOAL_K=18`. Do not treat the ensemble claim as a proven shipped model. |
| `K_FACTOR_WC` is live in Oracle, dead in AI Lab | `ratingUpdates.ts` vs unused export | Another reason Oracle is the production Elo path. |
| Last WC tiebreak is Elo+slug, not FIFA ranking | `engine.ts` `rankWithinGroup` | Do not copy the README wording into league tiebreakers. |
| Python DC LOO top-pick is 58.8%, not 68% | `betting-backtest/reports/dc_latest.md` | Independent model is real; “same number” marketing is not. |
| AI Lab prediction snapshots | `lib/snapshots.ts`, migration `0005` | **MIGRATE the idea** (store 1X2 keyed by match + `model_version` at view time). Review must read the snapshot, not recompute with later overlays. |
| Asymmetric away λ (`-homeBonus/2`) | both `elo.ts` `expectedGoals` | Non-standard. For leagues, use a single home-advantage term on the home λ only, then re-tune. |
| Tactical styles were re-scored after MD1 | `tacticalMatchups.ts` V5.1.2 header | Those attributes then score matchday-1 in the same backtest. Material look-ahead; do not port the 2026 style table as a prior. |

Phase 1 addendum: when porting Monte Carlo, sample from the Dixon-Coles scoreline grid (or at least apply τ), condition season odds on remaining fixtures, and do not advertise the 68% WC figure as a league claim.
