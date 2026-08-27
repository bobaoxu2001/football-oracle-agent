# WorldCup Oracle Agent — Devpost

> **Archived hackathon submission.** This document is preserved as research history. It is not the current Football Oracle product shell, live-production claim set, model-evidence contract or deployment status. World Cup work now sits behind the research boundary.

**Google Cloud Rapid Agent Hackathon · MongoDB Track**

| | |
|---|---|
| **🔗 Live demo** | **https://worldcup-oracle-agent.vercel.app** |
| **💻 GitHub** | https://github.com/bobaoxu2001/worldcup-oracle-agent |
| **🎥 Demo video** | _paste your 3-min link_ |

> The deployed demo **works with zero API keys** — deterministic Elo + Dixon-Coles + Monte Carlo engine, curated demo news, and an in-memory fallback. **Production runs the full stack live:** **football-data.org** for tournament facts & elimination gating · **GNews** for contextual news signals · **MongoDB Atlas** for memory & cache · **DeepSeek** for routine narratives/localization · **Gemini** for complex-reasoning escalation — with the **deterministic engine** as the source of truth for every probability and rule.

---

## ⚡ Elevator pitch

WorldCup Oracle Agent is a **daily news-aware AI agent** for the 2026 World Cup. Ask it a football question in plain English and it plans the analysis, pulls the latest injury & squad news, runs 10,000 Monte Carlo simulations, shows how the news moves the odds, remembers the session in MongoDB, and answers your follow-ups — like a prediction model and a football news desk fused into one agent.

---

## 💡 Inspiration

Most "AI predictors" are either a static stats dashboard or a single LLM call that makes numbers up. Neither feels like an **agent**, and neither feels **current** — real football fans care about *today's* team news (who's injured, who got called up, who's suspended) as much as long-run ratings.

We wanted an agent that visibly **reasons in steps**, grounds its numbers in a real statistical model, stays **timely** by folding in daily news, and **remembers** — so a follow-up like *"does that injury change the prediction?"* actually works. MongoDB became the natural memory layer for that.

---

## 🔮 What it does

- **Understands** a natural-language question (English or 中文) and **plans** the right analysis across **10+ intent types**: match prediction · tournament forecast · **group qualification** · **team comparison** · **rules explanation** · **model explanation** · team analysis · path-to-the-final · scenario what-if · team-news digest.
- **Resolves** teams from casual names (`USA`, `Türkiye`, `the Netherlands`).
- **Pulls recent team news** (injuries, returns, call-ups, suspensions, tactics) for both sides and **classifies** each item (category · impact · direction).
- **Scores news impact** with a transparent, capped signal layer and shows **base vs news-adjusted** probabilities with per-outcome deltas.
- **Simulates** the matchup **10,000 times** (Elo → Dixon-Coles → Monte Carlo).
- **Explains** the result in plain English, plus a fan insight and an optional TikTok-style script.
- **Remembers** every session in MongoDB and answers **follow-ups** ("What if Germany's injured defender returns?").
- **Agent Memory Center** (`/memory`) makes the memory layer visible: backend status, recent sessions, stored news signals, last refresh.
- **Verified track record** (`/accuracy`) grades the agent honestly against the real tournament: a walk-forward backtest of the live engine over **every completed 2026 match** (each predicted from *only* the results before it), with top-pick accuracy, RPS-vs-baseline skill, a calibration table, and every single call on the record — cross-checked by an independent ridge Dixon-Coles model.
- **Global Voice Mode:** fans can ask predictions by voice and hear responses in **English, Chinese, Spanish, Portuguese, or Japanese** — native browser speech APIs, no extra key, with deterministic localized summaries (numbers never change) and optional Gemini-translated prose.

---

## 🛠️ How we built it

- **Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS** — a dark "stadium-night" UI that reads well on a screen recording.
- **Prediction engine** — a TypeScript port of an Elo → Dixon-Coles bivariate-Poisson → Monte Carlo model. Match probabilities are closed-form; the tournament uses a seeded 10,000-run Monte Carlo over the **official FIFA 2026 bracket** (R32 slots 73–88, Annex C best-third routing — validated for all 495 combinations via `npm run validate:bracket`).
- **Agent pipeline** — plain, typed, inspectable functions in `lib/agent/*`:
  `planner → matchResolver → newsResolver → impactAnalyzer → predictionEngine → simulator → explanationGenerator → MongoDB memory`. The reasoning timeline shown to the user mirrors these steps.
- **News intelligence** — `lib/news/*`: a multi-source provider abstraction (**GNews live in production** / NewsAPI / SerpAPI / Google CSE), a deterministic keyword classifier, a MongoDB-backed `team_news` store, and curated demo signals as a zero-key fallback. **Contextual signals only** — injuries, suspensions, squad/tactics/form/team-tension — which may nudge probabilities within the capped impact layer; **football-data.org remains the source of truth for fixtures, results and elimination**, and LLMs never invent injuries or conflicts. Free-tier news can be delayed/rate-limited, so signals are cached (a failed fetch keeps last-known live signals).
- **DeepSeek hybrid LLM layer** (`lib/llm/*`) for intent understanding, analyst narrative, and Chinese localization — the deterministic engine remains the single source of truth for all numbers and rules.
- **Live tournament-state layer** (`lib/live-sports/*`) — API-Football fixtures/standings/injuries, MongoDB-cached, deterministically gating out eliminated teams (never the LLM/news).
- **Everything fails soft** — no MongoDB, no DeepSeek/Gemini, no news key? The app still runs end-to-end.

---

## 🍃 MongoDB usage (the memory layer) — ✅ LIVE on MongoDB Atlas

MongoDB is the agent's **memory**, not just a database — and it's **live in production on MongoDB Atlas** at https://worldcup-oracle-agent.vercel.app:

- **MongoDB Atlas persistent memory is live** — the deployed app connects to Atlas and persists across sessions.
- **Every intent type is saved to the `predictions` collection** — match predictions, tournament forecasts, group qualification, team comparisons, and rules/model explanations all persist, with `userQuery`, `intent`, `teams`, `prediction`, `simulationResult`, `reasoningSteps`, `explanation`, `followUpContext`, `createdAt`, plus the extended structured fields (`summary`, `rankings`, `modelFactors`, `rulesApplied`, `newsSignals`, `limitations`, `confidence`, `language`) and the **`llmProvider`** that produced the narrative (`deepseek` / `gemini` / none). The schema extension is backward-compatible, so older records still render. `/memory` shows each session's **intent-type badge**.
- **Team news is stored in the `team_news` collection** — classified daily signals, indexed on `team + publishedAt`, `category`, `impactLevel`, `demo`.
- **Follow-up context** is stored alongside predictions so "what-if" questions re-analyse the right matchup and news.
- **`/memory` shows the backend status and recent saved sessions** read straight from MongoDB.
- **The Data Transparency card on every result shows `Memory: MongoDB Atlas`** (i.e. `persisted: mongodb`) so judges can see the session was written to the database.

Status is also exposed as JSON at `GET /api/memory/status`. The design stays fail-soft: if the database is ever unreachable, a global in-process store transparently takes over so the agent never blocks — but in production it runs on Atlas.

---

## 🤖 Cost-aware hybrid LLM layer — DeepSeek (default) + Gemini (premium escalation) · deterministic engine = source of truth

The agent uses a **cost-aware provider router**: DeepSeek handles routine narrative/localization tasks, while Gemini is reserved for complex multi-step reasoning, ambiguous intent resolution, and fallback. Deterministic TypeScript code owns every number; the LLM layer only handles language.

**Provider chain (`lib/llm/provider.ts`):**

1. **Deterministic router first** — if the heuristic parser confidently classifies the intent and the engines produce a structured result, that result is the source of truth (numbers, rules, simulations, rankings).
2. **DeepSeek — the low-cost default** (`deepseek-chat` via REST): routine intent refinement, standard analyst narrative, Chinese localization, team comparison, model explanation, and most common questions.
3. **Gemini — premium escalation** (`gemini-2.5-flash` via REST): `selectLLMProvider()` routes a query to Gemini when `assessComplexity()` flags it — multi-step tournament reasoning, **path-to-final**, **group qualification / best-third-place** logic, **rules + prediction combined**, **more than two teams**, ambiguous intent, low deterministic confidence, or long-form Chinese explanations. Gemini is also the **fallback when DeepSeek fails/times out**.
4. **Graceful fallback** — if Gemini isn't configured → DeepSeek; if neither is configured → deterministic templates. No loss of correctness.

```
selectLLMProvider(structuredResult, query, language, complexity) → "deepseek" | "gemini" | "none"
```

> **Hard rules:** the structured JSON is the LLM's **only** source of truth — it copies probabilities/rankings verbatim and is forbidden from inventing probabilities, news, injuries, suspensions, or sources. We deliberately do **not** claim "Gemini generates all answers."

**Gemini function-calling — the LLM drives the pipeline.** Beyond narrating, we ship a real **Gemini tool-use loop** (`lib/llm/geminiAgent.ts`): Gemini is given four declared tools — `resolve_team`, `predict_match`, `get_team_news`, `get_tournament_state` — and over a bounded multi-round loop it *decides* which to call. We execute each tool **deterministically** (the tools return the engine's own probabilities and the live elimination state), feed the JSON back, and Gemini synthesizes the final answer. **The engine still owns every number**; a system instruction forbids inventing probabilities, news, or eliminations. It's fail-soft (no key → the deterministic pipeline runs unchanged), inspectable at **`POST /api/agent/gemini-tools`** (which returns the full tool-call trace), **visible in the product** — every prediction answer carries a *"Watch Gemini drive the tools"* card that replays the question through the live loop and renders the trace — and **unit-tested offline** with a scripted fake model — `npm run test:gemini-agent` (14 checks, no network / key / cost). This is the honest version of "the LLM drives the pipeline": Gemini orchestrates the tools; deterministic code produces the facts.

**A real trace, captured from the production endpoint (4 July 2026):**

```
POST /api/agent/gemini-tools
{ "query": "Will Spain beat Argentina based on the latest news?" }

→ settled in 2 rounds. Tool calls Gemini chose:
   1. predict_match(spain, argentina)  → Spain 31% · draw 29% · Argentina 40%
   2. get_team_news(spain)             → 4 live signals
   3. get_team_news(argentina)         → 4 live signals

→ Gemini's answer (numbers quoted verbatim from the engine):
   "Argentina has a 40.1% chance of beating Spain, while Spain has a
    31.1% chance of winning, with a 28.8% chance of a draw. The expected
    score is 1.3 – 1.4 in favor of Argentina. … There is no significant
    news for either team that would alter these predictions."
```

Note what it did **not** do: it didn't guess a probability, and having read the live news signals it correctly reported they don't move the line — exactly the behavior the system instruction demands.

**Transparency:** every answer's **Data Transparency** card and the "Why?" badge show the **actual provider and its role** — `DeepSeek · routine narrative/localization`, **`Gemini escalation · complex multi-step reasoning`** (visible on path-to-final, group-qualification, and other multi-step answers), or `None · deterministic rules engine` — and the provider is persisted to MongoDB with the result. LLMs explain and classify; they never decide facts. Routing is covered by a unit test suite (`npm run test:routing`).

---

## 📊 Verified out-of-sample track record — `/accuracy`

Anyone can claim a model is accurate. We **grade ours in public**, against the real tournament, on the **[`/accuracy`](https://worldcup-oracle-agent.vercel.app/accuracy)** page:

- **Walk-forward, no peeking.** Every completed 2026 match is predicted using **only the results dated before it** — never its own outcome. This is a true out-of-sample test, not a curve fit.
- **Through 15 July (102 completed matches, semi-finals included):** the live engine calls the right result **68% of the time (69/102)**, scores **+43% skill on the Ranked Probability Score** (the football-forecasting standard) vs a no-information coin-flip, and is **well-calibrated — ECE 5.0%** (when it says 70%, it happens ~70% of the time). It went 4-for-4 on the quarter-finals and called Argentina's semi-final win over England.
- **Two independent models agree.** The live stack is an Elo → Dixon-Coles → Monte Carlo engine in TypeScript. A **completely separate ridge Dixon-Coles** bivariate-Poisson model (Python, refit nightly, leave-one-out scored) lands on the same verdict: **+22% RPS skill, 72% accuracy on decisive results.** Two differently-built pipelines agreeing out-of-sample is the credibility check no single model can fake.
- **Every layer earns its place.** The page breaks down what each engine layer (result-learning, tactics, bounce-back, draw-propensity, confidence-calibration) adds to the RPS — this is *why* the agent is a pipeline, not one number.
- **Every call on the record**, filterable to the misses. We show the losses, we don't hide them.
- **Reproducible:** `npm run backtest` prints the same numbers in the terminal (it's a thin CLI over the exact module the page uses), `npm run dc:backtest` reruns the independent Dixon-Coles fit, and `npm run test:track` guards the accounting (24 checks). Exposed as JSON at `GET /api/accuracy`.

---

## 📐 Rules-aware 2026 World Cup engine

WorldCup Oracle is **rules-aware**, not just a matchup model:

- **Official 2026 format & bracket** reused from a validated module (`lib/prediction-engine/bracket-2026.ts`) — 48 teams, 12 groups, top-2 + 8 best third-placed teams → R32 (Annex C routing, all 495 combinations validated).
- **FIFA group tiebreakers** in the correct order — points → overall goal difference → overall goals → head-to-head → fair play → FIFA ranking.
- **Configurable discipline model** (`lib/prediction-engine/discipline.ts`) — yellow-card / red-card fair-play points and suspension thresholds power the suspension-risk read and the "do cards affect group ranking?" explainer.

The agent can therefore **explain the rules** (best-third advancement, card/fair-play effects, tiebreakers) — in English or 中文 — not just output probabilities.

---

## 📡 Live tournament state (deterministic elimination)

So the agent never keeps predicting eliminated teams as champions, a **live tournament-state layer** (`lib/live-sports/*`) is the deterministic source of truth — **not** the LLM or news headlines. **It is live in production via football-data.org** (badge: `Live API` on fresh fetches, `Cached` from MongoDB):

- **Real sports data** via **API-Football / API-SPORTS** or **football-data.org** (fixtures, standings, results; injuries on API-Football), normalized to canonical team IDs and **cached aggressively in MongoDB** (`team_state`, `live_fixtures`, `live_injuries`; ~2h fixtures / ~8h injuries TTL) to respect the free tiers.
- **Conservative classification** (`active · qualified · eliminated · unknown`): elimination only from a finished **knockout loss**; group stage is never guessed, so the agent **never falsely eliminates** a team.
- **Deterministic gating overrides the model**: eliminated teams are dropped from champion/path/team analysis (title odds → 0). *"Can Portugal still win?"* after elimination returns a hard **"No — already eliminated"** the LLM cannot override.
- **Fail-soft**: API down → last cached state; no key/cache → **Demo** (all active, clearly labelled). Never fabricates eliminations.
- **Transparency**: a Tournament-State badge (`Live API / Cached / Demo / Unavailable`, last-updated, source, eliminated count) on answers and at `GET /api/memory/status`.
- News providers stay **article/injury context only** — never the elimination source of truth.

Covered by `npm run test:tournament`. A **`/schedule`** page surfaces verified fixtures/live tournament-state data when available, with **TBA** labels instead of invented details (drawn group pairings + official knockout bracket are exact; dates/venues stay TBA until verified).

---

## 🧩 Agent workflow & MCP-assisted development

**The app is designed around an explicit agent workflow** (not a single chatbot call):

```
intent planning → intent routing → rules/simulation engines → memory → LLM narrative → MongoDB persist
```

Each stage is a real, inspectable TypeScript function and the reasoning timeline is shown live to the user.

**MCP was used on the development & deployment side** (via connected tools in our agent IDE), not as a production runtime dependency:

- **Vercel MCP** — connected and used to inspect project/deployment/runtime state during the deploy; environment-variable management and the production redeploy were performed with the **Vercel CLI** (`vercel env add`, `vercel redeploy`).
- **Browser-automation MCP + Playwright** and a **local-preview MCP** — used to drive the live app and **capture the production screenshots** and verify behavior.

> **Honest scope:** this is an **MCP-assisted development/deployment workflow**. We did **not** use **MongoDB MCP**, **GitHub MCP**, or **Google Cloud Agent Builder**, and no MCP server runs inside the deployed app. MongoDB integration is a **runtime** integration via the official `mongodb` Node driver (see below); git operations used the `git`/`gh` CLI.

---

## ✅ Hackathon compliance

| Requirement | Status |
|---|---|
| **Hosted project URL** | https://worldcup-oracle-agent.vercel.app (live, zero-config) |
| **Public repository** | https://github.com/bobaoxu2001/worldcup-oracle-agent |
| **Open-source license** | **MIT** (`LICENSE` in repo root) |
| **MongoDB track integration** | **MongoDB Atlas** is the live production **memory layer** via the official `mongodb` driver — `predictions` (all intent types) + `team_news` collections, follow-up context, status surfaced at `/memory` and `GET /api/memory/status` |
| **MCP usage** | MCP-assisted **development/deployment** (Vercel MCP inspection; browser/preview MCP for screenshots & verification). Not a production runtime dependency. |
| **Gemini / Google usage** | **Google Gemini** (`gemini-2.5-flash`, `lib/llm/gemini.ts`) is **live in production** as the **premium escalation provider** in the cost-aware router (complex multi-step reasoning, ambiguous intent, DeepSeek fallback), **and** as the driver of a real **function-calling agent loop** (`lib/llm/geminiAgent.ts`, `POST /api/agent/gemini-tools`) where Gemini chooses which deterministic tools to call. DeepSeek remains the low-cost default. |
| **Agent behavior beyond chat** | Plans, classifies intent (10+ types), routes to deterministic rules/simulation engines, persists to memory, explains results, answers follow-ups — **and** (with a Gemini key) drives a multi-round tool-use loop over declared tools. |
| **Multi-step workflow** | Visible reasoning timeline: plan → resolve → news → impact → engine → Monte Carlo → narrate → persist. Gemini function-calling adds a model-driven variant of the same steps. |
| **Verified accuracy** | Walk-forward backtest of the live engine on every completed 2026 result (`/accuracy`, `GET /api/accuracy`): **68% top-pick, +43% RPS skill, ECE 5.0%**, cross-checked by an independent Dixon-Coles LOO fit. Reproduced by `npm run backtest`; guarded by `npm run test:track`. |
| **Demo video** | _paste your 3-min link_ |

---

## 🧗 Challenges we ran into

- **Tournament correctness.** The 2026 format isn't a generic seeded bracket — it's fixed R32 slots plus FIFA's "Annex C" best-third routing (C(12,8) = 495 combinations). We encoded the official slots and wrote a deterministic bipartite matcher that produces a rules-valid third-placed assignment for **all 495**, verified by a test suite.
- **Keeping news honest.** Without a paid news key we use curated demo signals — so we label them clearly as "sample signals" and use generic player roles ("starting defender") to never fake attributions.
- **Making news *move* the model transparently.** We capped the news effect (≤ ±10 pts/team, redistributed 60/40 to opponent/draw) and render an explicit **base → adjusted** table, so the layer is explainable, never a black box.
- **Demo reliability.** Every external dependency (MongoDB, Gemini, news APIs) degrades gracefully so the flagship demo always works.

---

## 🏆 Accomplishments we're proud of

- A genuinely **agentic** product: a visible, inspectable pipeline with planning, tool steps, and memory — not a single prompt.
- **News-aware predictions** with a transparent base-vs-adjusted view.
- A **Data Transparency card** on every result — judges can see exactly what produced the answer (Elo · Dixon-Coles · 10k Monte Carlo · live/demo news · MongoDB/in-memory · DeepSeek/deterministic), reflecting the live runtime state. No black-box "AI numbers."
- A **rules-aware, multi-intent agent** — match prediction, tournament forecast, group qualification, team comparison, and rules/model explanations, in English and 中文.
- **Live or demo news, clearly labelled** — plug in a GNews/SerpAPI/NewsAPI/Google CSE key for live mode; otherwise honest, generic sample signals.
- **Official, validated** 2026 bracket (all 495 Annex C combinations pass).
- **MongoDB as a first-class memory layer** with a dedicated Memory Center.
- **Zero-config** end-to-end: clone, `npm install`, `npm run dev`.

---

## 🔭 What's next

- ✅ Native **Gemini function-calling** so the LLM drives the pipeline (planner → tools) — **shipped** (`lib/llm/geminiAgent.ts`, `POST /api/agent/gemini-tools`), ✅ **including the live tool-call trace in the agent panel** (a "Watch Gemini drive the tools" card on every prediction answer).
- **Richer live news** — cross-provider dedupe, real player entity resolution, recency weighting.
- **MongoDB Atlas Vector Search** over news + historical matches for "find similar situations."
- **Multi-turn memory recall** — the agent cites its own past predictions in follow-ups.
- A user **bracket builder** to simulate custom knockout paths.

---

## 💬 Recommended demo prompts

1. **Who will win Argentina vs Germany based on the latest team news?** _(flagship)_
2. Does Germany's injury news change the prediction?
3. What if Germany's injured defender returns?
4. Show me the latest Argentina team news before predicting.
5. Which team has the best chance to win the 2026 World Cup?
6. **谁会赢得世界杯冠军？** _(Chinese tournament forecast — DeepSeek-enhanced)_
7. **Compare Argentina and France** _(team comparison)_
8. **How do best third-place teams advance?** _(rules explanation)_
9. **黄牌会影响小组排名吗？** _(yellow-card / fair-play rules, in Chinese)_
10. **How does your model work?** _(model explanation)_

---

## 🎬 Demo script (≈ 2 minutes, live)

1. **Land on the home page.** "This is an AI agent for the 2026 World Cup — news-aware, with MongoDB memory." Point at the chips: *48 teams · real 2026 draw*, *Elo + Dixon-Coles + Monte Carlo*, *Daily news-aware*.
2. **Click the flagship prompt:** *"Who will win Argentina vs Germany based on the latest team news?"*
   - Watch the **agent reasoning timeline** run: gather data → resolve daily news → injury/squad impact → analyze strength → run 10,000 sims → report.
   - **Prediction card** appears with win/draw/loss bars + 10,000 simulations.
   - **Latest News Impact**: show the **base → adjusted** table (Germany −3 pts from a high-impact defender injury) and the "Impact:" explanation.
   - **Click "Watch Gemini drive the tools"** on the answer — the live Gemini function-calling loop replays the question, and the panel shows exactly which tools Gemini chose (`predict_match`, `get_team_news`, …), what each deterministic tool returned, and Gemini's synthesized answer quoting the engine's numbers verbatim. "The LLM orchestrates; the engine owns the numbers."
   - Point at **"Saved to agent memory · MongoDB / In-memory."**
3. **Click the follow-up** *"What if Germany's injured defender returns?"* — the agent re-analyses and Germany's odds recover. "It remembered the matchup and the news."
4. **Global Voice Mode (optional, ~10s):** switch the language to **Español**, ask the same question by voice, and play the spoken answer — the result reads back in Spanish.
5. **Open `/accuracy` (Track Record).** "This isn't a demo that only looks smart — here's the model graded against the real tournament, walk-forward. 68% of results called right, +43% skill over a coin-flip, well-calibrated — and an independent Dixon-Coles model agrees. Every call is on the record, misses included."
6. **Open `/memory` (Agent Memory Center).** Show the memory backend, recent sessions, stored `team_news` signals, last news update, and "Why MongoDB matters."
7. **Open `/news` (Daily Team News).** Switch teams, show impact/category/source badges, hit **Refresh news now**.
8. Close: "Statistical rigor + a verified track record + daily news intelligence + agent memory + global voice — that's WorldCup Oracle Agent."

---

## 🎥 3-minute video script

> **[0:00–0:20] Hook.** "Most AI predictors either spit out a number or make one up. WorldCup Oracle Agent is different — it's a news-aware AI agent that reasons step by step, runs real simulations, and remembers." Show the home page.

> **[0:20–0:35] The ask.** Type/click *"Who will win Argentina vs Germany based on the latest team news?"* "Plain English in — let's watch the agent work."

> **[0:35–1:05] The pipeline.** Narrate the reasoning timeline as steps complete: "It gathers match data, pulls **recent team news**, analyzes the **injury and squad impact**, then runs **10,000 Monte Carlo simulations** on the official 2026 bracket." Land on the prediction card.

> **[1:05–1:45] News intelligence (the differentiator).** Scroll to **Latest News Impact**. "Germany's starting defender is ruled out — a high-impact injury. The agent shows you **base vs news-adjusted** probabilities: Germany drops three points, redistributed to Argentina and the draw — capped and fully explained, never a black box." Point at the per-team news cards and source/demo badges.

> **[1:45–2:10] Memory + follow-up.** Point at **"Saved to agent memory · MongoDB."** Click **"What if Germany's injured defender returns?"** "It remembers the matchup and re-analyses — Germany's odds bounce back."

> **[2:10–2:40] MongoDB Track.** Open **/memory**. "MongoDB is the agent's memory layer: a `predictions` collection and an indexed `team_news` collection, plus follow-up context. Here's the live backend status, recent sessions, and stored news signals." Hit **Refresh news now**.

> **[2:40–3:00] Close.** "Statistical rigor, daily news intelligence, and real agent memory — and it runs with zero config, failing soft on every external service. That's WorldCup Oracle Agent." Show the GitHub repo + MIT license.

---

*Predictions are model estimates for entertainment & informational use only. Not betting or financial advice.*
