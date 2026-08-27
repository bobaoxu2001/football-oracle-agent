# WorldCup Oracle Agent — Handoff Summary

> **Archived research-era handoff.** This file is retained as historical project context and does not describe the current Football Oracle product, navigation, production URL, evidence contract or deployment state. Current public production is the Premier League product at `https://football-oracle-agent.vercel.app`.

> For continuing the project from another Claude Code account/session.
> **No secrets are in this file.** Connection strings, API keys, and tokens live only in
> a gitignored `.env.local` and in Vercel's encrypted env store — never in the repo.

- **Repo:** https://github.com/bobaoxu2001/worldcup-oracle-agent
- **Live app:** https://worldcup-oracle-agent.vercel.app
- **Branch:** `main` · **HEAD at handoff:** `67dc76c`
- **Local path:** `2025 找工作/AI Projects/worldcup-oracle-agent`

---

## 1. Project overview

A **daily news-aware AI agent for FIFA World Cup 2026 predictions** (built for the Google Cloud
Rapid Agent Hackathon, MongoDB Track). It is not a static dashboard: you ask a football question
in plain English (or 中文/Español/Português/日本語) and an explicit agent pipeline plans the
analysis, resolves teams, pulls recent team news, runs a Monte Carlo simulation, explains the
result, and **remembers** the session in MongoDB.

**Main user flow:** type/voice a question on `/` → animated reasoning timeline → prediction card
(win/draw/loss bars) → Latest News Impact (base-vs-adjusted) → Simulation Center → Data
Transparency card → "Saved to agent memory" → follow-up chips.

**Routes/pages:**
- `/` — agent chat (the product)
- `/news` — Daily Team News browser (per-team `team_news`)
- `/memory` — Agent Memory Center (MongoDB backend status + recent sessions + stored news)
- `POST /api/agent/predict` — runs the agent pipeline, returns an `AgentResponse`
- `GET /api/predictions/recent` — recent prediction sessions
- `GET /api/memory/status` — backend status JSON (mongo connected?, counts, news mode)
- `GET|POST /api/news/refresh` — refresh `team_news` (also a daily Vercel cron in `vercel.json`)
- `GET /api/news/team/[team]` — recent news for one team

**Positioning:** "World Cup prediction model + daily football news intelligence agent," with a
transparent, deterministic statistical core and optional LLM polish.

---

## 2. Tech stack

- **Framework:** Next.js 15 (App Router) · **Language:** TypeScript (strict) · **React 19**
- **Styling:** Tailwind CSS v3, custom dark "stadium-night" theme, `lucide-react` icons
- **Prediction model:** Elo → Dixon-Coles bivariate Poisson → seeded Monte Carlo (TS port)
- **Database:** MongoDB (`mongodb` driver) on **MongoDB Atlas** (collections `predictions`, `team_news`)
- **Deployment:** Vercel (Git-connected → push to `main` auto-deploys; daily cron configured)
- **LLM (optional):** Google Gemini via REST (`lib/llm/gemini.ts`); deterministic fallback
- **Key deps:** `next`, `react`, `mongodb`, `class-variance-authority`, `clsx`, `tailwind-merge`,
  `lucide-react`. Dev: `typescript`, `tailwindcss`, `tsx`, `eslint`. `puppeteer-core` is used only
  for screenshots and installed ad-hoc with `--no-save` (NOT in package.json).
- **Scripts (`package.json`):**
  - `dev`, `build`, `start`, `lint`, `typecheck`
  - `validate:bracket` → `tsx scripts/validate-bracket.ts` (validates the official bracket + all 495 third-place combos)
  - `setup:mongo` → `tsx scripts/setup-mongo.ts` (creates collections/indexes from `MONGODB_URI` env; seeds demo `team_news` if empty)

---

## 3. Production status

- **Vercel deployment:** ✅ live at https://worldcup-oracle-agent.vercel.app (public, zero-config capable)
- **MongoDB Atlas memory:** ✅ connected in production (Data Transparency shows `Memory: MongoDB Atlas`)
- **Verified live:** flagship predict returns `persisted: mongodb`; `/api/memory/status` →
  `backend: MongoDB Atlas, connected: true`; `predictions` + `team_news` counts > 0 from mongodb;
  `/api/predictions/recent` reads sessions from mongodb.
- **Pages checked live:** `/` (200), `/news` (200), `/memory` (200, shows MongoDB backend + saved sessions).
- **Known runtime notes:** none breaking. Fail-soft: if Atlas is ever unreachable, a `globalThis`
  in-memory store transparently takes over. Connection timeout was raised to 8s for serverless cold
  starts. (Local dev cannot reach `*.mongodb.net` on some networks due to DNS issues — that is
  environmental, not a code bug; Vercel resolves Atlas fine.)

---

## 4. MongoDB Atlas integration (no credentials here)

- **Database:** `worldcup_oracle`
- **Collections:**
  - `predictions` — one document per meaningful agent answer: `userQuery`, `intent`, `teams`,
    `prediction` (probabilities + confidence), `simulationResult`, `reasoningSteps`, `explanation`,
    `followUpContext`, `createdAt`.
  - `team_news` — classified news signals: `team`, `title`, `summary`, `category`, `impactLevel`,
    `direction`, `affectedPlayers`, `sourceName`, `sourceUrl`, `publishedAt`, `createdAt`, `demo`.
- **Indexes** (created by `scripts/setup-mongo.ts`; `team_news` also auto-created on first write):
  - `predictions`: `createdAt:-1`, `teams:1`, `intent:1`
  - `team_news`: `{team:1, publishedAt:-1}`, `category:1`, `impactLevel:1`, `demo:1`
- **Persistence flow:** `lib/agent/index.ts` (`runAgent`) → `savePrediction()` in `lib/db/mongodb.ts`
  (returns `"mongodb"` | `"memory"`). News is written via `lib/news/teamNewsStore.ts`.
- **/memory verification:** `app/memory/page.tsx` + `app/api/memory/status` call `mongoConnected()`,
  `countPredictions()`, `getNewsStats()` and render the backend, counts, and recent sessions.

---

## 5. Environment variables (names only — values live in `.env.local` + Vercel)

| Variable | Purpose | Where set |
|---|---|---|
| `MONGODB_URI` | Atlas connection string | gitignored `.env.local` (local) + Vercel production (encrypted) |
| `MONGODB_DB` | DB name (`worldcup_oracle`) | `.env.local` + Vercel production |
| `NEXT_PUBLIC_APP_URL` | absolute app URL for metadata | `.env.local` + Vercel production |
| `GOOGLE_API_KEY` | optional Gemini polish | optional (not set in prod) |
| `GNEWS_API_KEY` / `SERPAPI_API_KEY` / `NEWS_API_KEY` / `GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_ENGINE_ID` | optional live news (first configured wins) | optional |

> `.env.local` is in `.gitignore` and must never be committed. Atlas requires Network Access
> `0.0.0.0/0` (Vercel IPs are dynamic) and a `readWrite` DB user.

---

## 6. Files & modules that matter

**App routes** — `app/page.tsx` (home/chat shell), `app/news/page.tsx`, `app/memory/page.tsx`,
`app/api/agent/predict/route.ts`, `app/api/predictions/recent`, `app/api/memory/status`,
`app/api/news/{refresh,team/[team]}`.

**Prediction engine** — `lib/prediction-engine/`:
- `elo.ts` (Elo + Dixon-Coles math, seeded RNG), `ratings.ts` (48-team Elo + host advantage)
- `engine.ts` — `predictMatch`, `simulateGroup`, **`simulateTournament`** (group stage with FIFA
  tiebreakers incl. head-to-head, best-8-thirds, official bracket), `getChampionProbabilities`,
  `generateMatchExplanation`
- **`bracket-2026.ts`** — official R32 slots (M73–M88), R16→Final tree, FIFA **Annex C** best-third
  slot assignment (deterministic bipartite matching, all 495 combos valid), validation helpers
- `seed/world-cup-2026-groups.ts` — real 2026 draw (12 groups A–L, 48 teams)

**Agent pipeline** — `lib/agent/`:
- `planner.ts` — **intent router** (currently: `match-prediction`, `champion-odds`, `scenario`,
  `tiktok-preview`, `team-news`, `unknown`) — heuristic regex
- `matchResolver.ts` — free-text → team slugs (EN aliases + es/pt + CJK; star-player→team map)
- `newsResolver.ts`, `impactAnalyzer.ts` — pull team news + capped base-vs-adjusted nudge
- `scenario.ts` — "what-if" Elo deltas (player out / returns / form)
- `simulator.ts` — 10k Monte Carlo single match; `explanationGenerator.ts` — prose/fan/TikTok
- `index.ts` — **`runAgent` orchestrator** (per-intent branches; persists to Mongo); `types.ts`

**MongoDB / memory** — `lib/db/mongodb.ts` (client, `savePrediction`, `getRecentPredictions`,
`countPredictions`, `mongoConnected`, `getMongoDb`, globalThis in-memory fallback).

**Team news** — `lib/news/` (`newsProvider.ts` multi-source, `newsClassifier.ts`,
`teamNewsStore.ts` Mongo+memory, `newsIngestor.ts`, `demoNews.ts` curated demo signals, `types.ts`).

**i18n / voice** — `lib/i18n/` (`languages.ts`, `prompts.ts`, `responseLocalizer.ts`); voice UI in
`components/agent/agent-chat.tsx` (Web Speech recognition + synthesis).

**UI components** — `components/agent/*` (chat, reasoning-timeline, prediction-card,
probability-bars, simulation-center, **champion-board**, news-impact, **data-transparency**,
team-news-digest, recent-predictions), `components/news/*`, `components/memory/*`,
`components/site/navbar.tsx`, `components/ui/*`.

**Scripts** — `scripts/validate-bracket.ts`, `scripts/setup-mongo.ts`.
**Docs** — `README.md`, `DEVPOST.md`, `docs/screenshots/*.png` (live production captures).

---

## 7. Recently completed

- Official 2026 tournament format + bracket routing (`bracket-2026.ts`, Annex C, all 495 combos) — `ff13659`
- Daily news intelligence + MongoDB memory + Data Transparency + Global Voice Mode (earlier commits)
- **MongoDB Atlas**: cluster connected; connection-string hostname corrected; Atlas Network Access
  `0.0.0.0/0` added; Vercel prod env vars set (`MONGODB_URI`, `MONGODB_DB`, `NEXT_PUBLIC_APP_URL`);
  production redeploy; live verified showing **MongoDB Atlas** with saved sessions — `8581e57`
- Re-captured live production screenshots + README/DEVPOST updated to reflect live Atlas — `67dc76c`
- Recent commits:
  - `67dc76c` Refresh live screenshots and docs for MongoDB Atlas memory
  - `8581e57` Enable MongoDB Atlas memory for live deployment
  - `3ca6cf3` Enable MongoDB Atlas memory for deployment (setup:mongo script)
  - `ff13659` Fix official 2026 World Cup tournament format and bracket routing

---

## 8. Current limitations / product gaps (honest)

- ✅ Two-team **match prediction** works well (probabilities, scorelines, news impact, transparency, Mongo memory).
- ✅ **MongoDB memory** works; `/memory` and `/news` work.
- ⚠️ **Tournament/champion intent is weak.** A `champion-odds` path exists (`getChampionProbabilities`
  + `ChampionBoard`), but the planner regex is brittle — e.g. *"who will win the champion"* may not
  match and falls to `unknown`. There is no confidence level, dark-horse list, expected path, or risk framing.
- ⚠️ The agent assumes most queries are matchups; **group-qualification, path-analysis, team-analysis,
  team-comparison, rules-explanation, model-explanation** intents are not first-class.
- ⚠️ **Prediction factors are limited** (Elo, host edge, xG, draw likelihood, capped news nudge).
  No discipline/cards/suspension model; no explicit "model dimensions" UI card.
- ⚠️ Group ranking uses FIFA's **overall GD/GF before head-to-head** order (correct for the World
  Cup). **Verify against official 2026 FIFA regulations before changing** — do not blindly switch to a
  UEFA-style head-to-head-first order.
- ⚠️ Output reads as single answers; it could become a richer **sports-intelligence forecast dashboard**.

---

## 9. Recommended next improvement plan

A. **Tournament-level intent** — make `planner.ts` reliably route champion/forecast questions
   (incl. 中文). Add a `tournament-forecast` intent distinct from `champion-odds`.
B. **Champion / top-contenders forecast** — ranked contenders, championship %, expected path,
   confidence, dark horses, key risks, model limitations.
C. **Richer prediction factors** — surface attack/defense/squad-depth/form/discipline as structured factors.
D. **Prediction Factors / Model Dimensions UI card** — list the dimensions feeding each answer.
E. **Confidence + upset scenario + "what could change"** explanations on results.
F. **Persist tournament forecasts to MongoDB** (new `intentType`, rankings, modelFactors, rulesApplied…).
G. **/memory** — distinguish Match Prediction vs Tournament Forecast (and other intent types) with a type badge.
H. Run `typecheck` / `validate:bracket` / `lint` / `build`; recapture screenshots if UI changes; commit + push.

(See the next-session prompt below for the full 2026 rules-engine + intent-router + optional DeepSeek spec.)

---

## 10. Copy-paste prompt for the next Claude Code account

```
You are continuing the WorldCup Oracle Agent project (Google Cloud Rapid Agent Hackathon, MongoDB Track).

Repo: https://github.com/bobaoxu2001/worldcup-oracle-agent   Live: https://worldcup-oracle-agent.vercel.app   Branch: main
Read HANDOFF.md first — it explains the architecture, the live MongoDB Atlas integration, and what already exists.

GROUND RULES
- Start with `git status` and inspect the codebase before editing. Do NOT rebuild what exists.
- Preserve the existing MongoDB Atlas integration, the official bracket engine (lib/prediction-engine/bracket-2026.ts),
  and the fail-soft fallbacks. Do not redo Mongo/Vercel setup.
- NEVER print, commit, or expose secrets. Do not commit .env.local, MongoDB URI, Vercel tokens, or API keys.
  Any API key must be placed by the human into a gitignored .env.local / Vercel env — not by you, not in the repo.
- Before coding tournament rules, VERIFY the latest 2026 FIFA World Cup rules from official/reliable sources and
  add citations/comments. NOTE: the current code uses FIFA's overall-GD/GF-before-head-to-head group order
  (correct for the World Cup, unlike UEFA). Confirm before changing it. Do not invent real player/injury/news data;
  label all demo/static assumptions clearly.

GOAL: upgrade from mostly two-team matchups into a robust, rules-aware 2026 World Cup forecasting agent.

BUILD
1. Intent router (extend lib/agent/planner.ts + runAgent): MATCH_PREDICTION, TOURNAMENT_FORECAST,
   GROUP_QUALIFICATION, PATH_ANALYSIS, TEAM_ANALYSIS, TEAM_COMPARISON, NEWS_OR_INJURY, RULES_EXPLANATION,
   MODEL_EXPLANATION, and a helpful CLARIFICATION/FALLBACK (don't just fail). Handle EN + 中文 phrasings
   (e.g. "who will win the champion", "谁会赢得世界杯冠军？", "小组第三怎么晋级？").
2. Tournament rules engine: reuse/extend simulateTournament + bracket-2026 (48 teams, 12 groups, top-2 +
   8 best thirds = 32, R32→Final). Surface: champion %, top contenders, expected path, confidence, dark horses,
   group tables, best-third ranking ("8 of 12 advance"), tie-breaker explanations.
3. Discipline model: yellow/red cards → fair-play/team-conduct ranking + suspension risk. Add config constants
   (YELLOW_CARD_FAIR_PLAY_POINTS=-1, INDIRECT_RED=-3, DIRECT_RED=-4, YELLOW_PLUS_DIRECT_RED=-5,
   YELLOW_CARD_SUSPENSION_THRESHOLD, YELLOW_CARD_RESET_STAGE, RED_CARD_AUTO_SUSPENSION_MATCHES). If 2026
   yellow-reset timing is uncertain, leave a clearly-labeled configurable TODO — do not invent it.
4. Lightweight availability model (injuries/suspensions/squad depth) using team-level demo signals, clearly labeled.
5. UI (keep the dark premium design): intent badge, Model Dimensions/Prediction Factors card, Tournament Forecast
   card, Group Table card, Best Third-Place card, Discipline/Suspension Risk card, Rules Explainer card, and a
   memory-type badge in the sidebar + /memory.
6. MongoDB persistence: persist all meaningful intent types (add intentType, tournamentStage, group, rankings,
   modelFactors, rulesApplied, summary, probabilities, language, createdAt). Update /memory to distinguish
   Match Prediction vs Tournament Forecast vs Group Qualification vs Path Analysis vs Team Analysis vs News vs Rules.
7. Optional DeepSeek layer (deterministic code stays the source of truth): env AI_PROVIDER=deepseek,
   DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL=https://api.deepseek.com, DEEPSEEK_MODEL=deepseek-chat. DeepSeek may
   classify intent + write narratives/clarifications only — it must NOT invent probabilities, news, injuries, or
   suspensions. Add classifyIntentWithLLM(query, deterministicGuess), generateAnalystNarrative(result, language),
   generateClarification(query, examples). Fall back to deterministic templates if env is missing. The human will
   supply DEEPSEEK_API_KEY via .env.local (a previously-pasted key should be rotated).

TEST (manually, EN + 中文): match ("Argentina vs Germany"), tournament ("Who will win the 2026 World Cup?",
"Top 5 favorites", "谁会赢得世界杯冠军？"), group/third-place ("Which teams qualify from Group A?",
"How do best third-place teams advance?", "小组第三怎么晋级？", "What happens if two teams tie on points?"),
rules/discipline ("How do yellow cards affect qualification?", "黄牌会影响小组排名吗？"), team
("Is Argentina strong this year?", "Compare Argentina and France", "Argentina path to the final"),
model ("How does your model work?").

QUALITY + SHIP: run `npm run typecheck`, `npm run validate:bracket`, `npm run lint`, `npm run build`; fix issues.
If UI changed significantly, recapture production screenshots into docs/screenshots/ and update README/DEVPOST
(no secrets). Commit and push to main. Report: rules verified, rules engine + intents implemented, files changed,
Mongo persistence status, examples tested, quality results, screenshots, commit hash, push status.
```
