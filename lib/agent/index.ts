/**
 * Agent orchestrator — the brain that runs the pipeline:
 *
 *   User Query
 *     → Planner                 (classify intent, name the plan)
 *     → Match Resolver          (free text → team slugs)
 *     → Daily News Resolver     (recent injuries / squad / tactics news)
 *     → Injury/Squad Analyzer   (lightweight, capped probability nudge)
 *     → Prediction Engine       (Elo + Dixon-Coles closed form)
 *     → Monte Carlo             (10,000 simulated matches)
 *     → Explanation Gen         (plain-English + fan insight + TikTok)
 *     → MongoDB Memory          (persist, with in-memory fallback)
 *     → Final Answer
 *
 * Returns a fully-formed AgentResponse the UI renders as a reasoning timeline,
 * a prediction card, a simulation summary, and a narrative. Every numeric
 * output is deterministic; Gemini (optional) only restyles the prose.
 */

import {
  predictMatch,
  getChampionProbabilities,
  getCompletedFixture,
  completedFixtureNote,
} from "@/lib/prediction-engine";
import { freshnessFootnote } from "@/lib/data-truth/freshness";
import {
  explanationFromFrozenForecast,
  loadFrozenPremierLeagueForecast,
  predictionFromFrozenForecast,
  productionRefusalFromError,
  refusedPremierLeagueResponse,
  simulationFromFrozenForecast,
  unsupportedPremierLeagueScenarioRefusal,
  unsupportedPremierLeagueTitleRefusal,
} from "./production-truth";
import {
  getTournamentState,
  gateChampionOdds,
  isEliminated,
  eliminationNotice,
  toView,
} from "@/lib/live-sports/tournamentState";
import { planQuery, isOutOfScopeCompetition, hasMatchLanguage, detectNonQualifiedTeam } from "./planner";
import { teamRef, resolveTeams } from "./matchResolver";
import { runSimulation } from "./simulator";
import { resolveScenario } from "./scenario";
import {
  buildExplanation,
  buildFanInsight,
  buildTiktokScript,
  buildChampionExplanation,
} from "./explanationGenerator";
import { savePrediction } from "@/lib/db/mongodb";
import { geminiConfigured } from "@/lib/llm/gemini";
import { resolveNews, resolveTeamNews } from "./newsResolver";
import { activeNewsProviderName } from "@/lib/news/newsIngestor";
import {
  localizeText,
  buildMatchSummary,
  buildChampionSummary,
} from "@/lib/i18n/responseLocalizer";
import { isLangCode, type LangCode } from "@/lib/i18n/languages";
import {
  classifyIntentWithLLM,
  generateNarrative,
  polishNarrative,
  generateClarification,
  assessComplexity,
  llmConfigured,
  type ActiveProvider,
} from "@/lib/llm/provider";
import { explainRules } from "./rulesExplain";
import {
  buildGroupQualification,
  buildPathAnalysis,
  buildTeamAnalysis,
  buildTeamComparison,
  buildModelExplanation,
} from "./analysis";
import { groupOf } from "@/lib/seed/world-cup-2026-groups";
import {
  analyzeNewsImpact,
  buildNewsNarrative,
  buildTeamNewsDigest,
  summarizeTeam,
} from "./impactAnalyzer";
import type {
  AgentResponse,
  PredictionBundle,
  PredictionResult,
  ReasoningStep,
  ChampionAnswer,
  NewsImpactReport,
  StructuredResult,
} from "./types";

export interface AgentInput {
  query: string;
  isFollowUp?: boolean;
  /** Slugs of the matchup the follow-up refers to (from the prior turn). */
  contextTeams?: string[];
  /** Disable persistence (e.g. internal preview). */
  persist?: boolean;
  /** Global Voice Mode: language to localize the answer to (BCP-47). */
  language?: string;
  /** Evaluation clock for frozen-forecast selection. Production callers omit this. */
  now?: Date;
}

function step(
  id: string,
  title: string,
  description: string,
  detail?: string
): ReasoningStep {
  return { id, title, status: "completed", description, detail };
}

/**
 * Narrate a structured result with the optional LLM (EN/zh), else fall back to
 * the deterministic text (translated for non-English when a translator exists).
 * The structured result is the LLM's ONLY source of truth — it may rephrase,
 * never invent.
 */
async function narrateOrFallback(
  structured: StructuredResult,
  deterministic: string,
  lang: LangCode,
  query: string,
  intent: string
): Promise<{ text: string; enhanced: boolean; provider: ActiveProvider | null }> {
  if (lang === "en-US" || lang === "zh-CN") {
    const { text, provider } = await generateNarrative(structured, lang === "zh-CN" ? "zh" : "en", {
      query,
      intent,
      teamCount: structured.teams?.length ?? 0,
      confidence: structured.confidence,
      language: lang,
    });
    if (text) return { text, enhanced: true, provider };
  }
  if (lang !== "en-US") {
    const r = await localizeText(deterministic, lang);
    const provider: ActiveProvider | null =
      r.method === "gemini" ? "gemini" : r.method === "deepseek" ? "deepseek" : null;
    return { text: r.text, enhanced: provider !== null, provider };
  }
  return { text: deterministic, enhanced: false, provider: null };
}

/**
 * Return a DETERMINISTIC answer (no LLM authorship) — used when live tournament
 * state has already decided the outcome (e.g. an eliminated team). For non-English
 * the text is translated only (numbers/facts preserved); the LLM never overrides
 * the elimination fact.
 */
async function deterministicAnswer(
  english: string,
  lang: LangCode
): Promise<{ text: string; enhanced: boolean; provider: ActiveProvider | null }> {
  if (lang === "en-US") return { text: english, enhanced: false, provider: null };
  const r = await localizeText(english, lang);
  return { text: r.text, enhanced: false, provider: null };
}

// Betting-intent wording gets an explicit deterministic disclaimer appended
// after narration (the footer/disclaimer alone is too easy to miss). The phrase
// list also covers tipping-style asks that omit the words "bet/odds" ("sure
// thing", "should I back …", "lock of the day"), worded narrowly to avoid false
// positives like "locker room" or "background".
const BETTING_RE =
  /\b(bet|bets|betting|wager|wagering|gamble|gambling|parlay|stake|bookie|odds slip|sure thing|safe pick|shoo-?in)\b|\bshould i back\b|\block of the\b|赌|投注|下注/i;
const BETTING_NOTE =
  "\n\n_⚠️ Not betting advice. Probabilities are model estimates expressing uncertainty, for entertainment & informational purposes only._";
function withBettingNote(text: string, query: string): string {
  return BETTING_RE.test(query) && !text.includes("Not betting advice") ? text + BETTING_NOTE : text;
}
/** Whether a query reads as a betting/tipping ask (used by the disclaimer + tests). */
export function mentionsBetting(query: string): boolean {
  return BETTING_RE.test(query);
}

// "今晚/tonight" wording must not imply we verified an official fixture — the
// engine simulates any matchup; it does not check the real schedule.
const TONIGHT_RE = /今晚|今天|tonight|today/i;
function withFixtureNote(text: string, query: string, lang: string): string {
  if (!TONIGHT_RE.test(query)) return text;
  const note =
    lang === "zh-CN"
      ? "\n\n_（这是基于模型的对阵模拟，并非经核实的官方赛程。）_"
      : "\n\n_Model-based matchup simulation — not a verified official fixture._";
  return text.includes("official fixture") || text.includes("官方赛程") ? text : text + note;
}

/** Build the normalized StructuredResult shell shared by the new intents. */
function makeStructured(
  base: Partial<StructuredResult> & Pick<StructuredResult, "intentType" | "query" | "summary">
): StructuredResult {
  return {
    language: "en",
    teams: [],
    group: null,
    stage: null,
    probabilities: null,
    rankings: null,
    modelFactors: [],
    rulesApplied: [],
    newsSignals: [],
    limitations: [],
    confidence: 50,
    ...base,
  };
}

function toPredictionResult(b: PredictionBundle): PredictionResult {
  const { prediction: p, teamA, teamB, simulation: sim } = b;
  const favIsA = p.teamAWinProbability > p.teamBWinProbability;
  const close = Math.abs(p.teamAWinProbability - p.teamBWinProbability) < 0.05;
  return {
    teamA,
    teamB,
    teamAWin: p.teamAWinProbability,
    draw: p.drawProbability,
    teamBWin: p.teamBWinProbability,
    confidenceLevel: p.confidenceLevel,
    confidenceScore: p.confidenceScore,
    mostLikelyScore: sim.mostLikelyScore.replace("-", "–"),
    upsetProbability: sim.upsetProbability,
    expectedScore: p.expectedScore,
    favorite: close ? "Too close to call" : favIsA ? teamA.name : teamB.name,
    keyFactors: p.factors.map((f) => ({
      label: f.label,
      detail: f.detail,
      weight: f.weight,
    })),
  };
}

/**
 * Finalize the narrative for the chosen language.
 * - English: the existing Gemini polish (English path is byte-identical to before).
 * - Other language: Gemini-translate preserving numbers, or keep English on
 *   fallback (the in-language result summary carries the localized headline).
 */
async function finalizeNarrative(
  english: string,
  context: string,
  lang: LangCode,
  query: string,
  intent: string
): Promise<{
  text: string;
  enhanced: boolean;
  method: "none" | "gemini" | "deepseek" | "template";
  provider: ActiveProvider | null;
}> {
  if (lang === "en-US") {
    const { text, provider } = await polishNarrative(english, context, { query, intent });
    const method = provider ?? "none";
    return { text, enhanced: provider !== null, method, provider };
  }
  // Non-English: cost-aware localization — premium (Gemini) only for complex queries.
  const r = await localizeText(english, lang, { preferGemini: assessComplexity(query, { intent }) });
  const provider: ActiveProvider | null =
    r.method === "gemini" ? "gemini" : r.method === "deepseek" ? "deepseek" : null;
  return { text: r.text, enhanced: provider !== null, method: r.method, provider };
}

export async function runAgent(input: AgentInput): Promise<AgentResponse> {
  const { query } = input;
  const persist = input.persist ?? true;
  const hasContextMatchup = input.contextTeams?.length === 2;
  const plan = planQuery(query, input.isFollowUp, hasContextMatchup);
  const createdAt = input.now ?? new Date();
  const lang: LangCode = isLangCode(input.language) ? input.language : "en-US";

  // Out-of-scope competitions (Euros, CL, …) must never be silently answered
  // with World Cup odds — and the LLM refinement below must not "rescue" them.
  const outOfScope = isOutOfScopeCompetition(query);
  // Same for nations that didn't qualify (Italy, China, …): honest answer only.
  const nonQualified = detectNonQualifiedTeam(query);

  // ---- Optional LLM intent refinement (deterministic stays source of truth) --
  // Only when the deterministic parser is unsure AND a provider is configured.
  // The LLM only relabels intent; every number, news item and ruling remains
  // deterministic. Any failure/missing key falls back to the deterministic guess.
  if (plan.intent === "unknown" && !outOfScope && !nonQualified && llmConfigured()) {
    const llm = await classifyIntentWithLLM(query, plan.intent);
    if (llm) {
      // Backfill anchors from the LLM's labels (resolved through OUR resolver —
      // the LLM only suggests names; the deterministic resolver validates them).
      if (plan.teamSlugs.length === 0 && llm.teams.length > 0) {
        plan.teamSlugs = resolveTeams(llm.teams.join(" vs ")).map((t) => t.slug);
      }
      if (!plan.group && llm.group) plan.group = llm.group;

      const n = plan.teamSlugs.length;
      switch (llm.intentType) {
        case "TOURNAMENT_FORECAST":
          // A question with match-result wording is about ONE match — never let
          // the LLM relabel it as a tournament forecast (champion odds).
          if (!hasMatchLanguage(query)) plan.intent = "champion-odds";
          break;
        case "RULES_EXPLANATION":
          plan.intent = "rules-explanation";
          break;
        case "GROUP_QUALIFICATION":
          if (plan.group || n >= 1) plan.intent = "group-qualification";
          else plan.intent = "rules-explanation"; // generic third-place question
          break;
        case "PATH_ANALYSIS":
          if (n >= 1) plan.intent = "path-analysis";
          break;
        case "TEAM_ANALYSIS":
          if (n >= 1) plan.intent = "team-analysis";
          break;
        case "TEAM_COMPARISON":
          if (n === 2) plan.intent = "team-comparison";
          else if (n === 1) plan.intent = "team-analysis";
          break;
        case "NEWS_OR_INJURY":
          if (n >= 1) plan.intent = "team-news";
          break;
        case "MATCH_PREDICTION":
          if (n === 2) plan.intent = "match-prediction";
          break;
        case "MODEL_EXPLANATION":
          plan.intent = "model-explanation";
          break;
        // CLARIFICATION → stays "unknown" (helpful fallback below).
      }
    }
  }

  // ---- RULES EXPLANATION ------------------------------------------------
  if (plan.intent === "rules-explanation") {
    const { topic, explanation, fanInsight } = explainRules(query, lang);
    const steps: ReasoningStep[] = [
      step("identify", "Identify the rules question", `Detected a rules question (${topic}).`),
      step("locate", "Locate the 2026 rule", "Matched the relevant 2026 World Cup competition rule."),
      step("explain", "Explain in plain language", "Summarized the rule with examples."),
    ];
    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation,
          followUpContext: `rules:${topic}`,
          createdAt,
        })
      : "none";
    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      explanation,
      fanInsight,
      llmEnhanced: false,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
    };
  }

  // ---- MODEL EXPLANATION ------------------------------------------------
  if (plan.intent === "model-explanation") {
    const m = buildModelExplanation();
    const structured = makeStructured({
      intentType: "MODEL_EXPLANATION",
      query,
      language: lang === "zh-CN" ? "zh" : "en",
      summary: m.summary,
      modelFactors: m.factors,
      rulesApplied: m.rulesApplied,
      limitations: m.limitations,
      confidence: m.confidence,
    });
    const steps = plan.planLabels.map((t, i) => step(`model-${i}`, t, "Done."));
    const { text, enhanced, provider } = await narrateOrFallback(structured, m.explanation, lang, query, plan.intent);
    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: "",
          createdAt,
          language: lang,
          summary: m.summary,
          modelFactors: m.factors,
          rulesApplied: m.rulesApplied,
          limitations: m.limitations,
          confidence: m.confidence,
          llmProvider: provider,
        })
      : "none";
    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      structured,
      explanation: text,
      fanInsight: "Deterministic research engine + capped news layer + private reliability storage — the LLM only narrates and never invents numbers.",
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
    };
  }

  // ---- GROUP QUALIFICATION ----------------------------------------------
  if (plan.intent === "group-qualification") {
    const focusSlug = plan.teamSlugs[0];
    const groupName = plan.group ?? (focusSlug ? groupOf(focusSlug).name : undefined);
    if (groupName) {
      const g = buildGroupQualification(groupName, focusSlug);
      const structured = makeStructured({
        intentType: "GROUP_QUALIFICATION",
        query,
        language: lang === "zh-CN" ? "zh" : "en",
        teams: focusSlug ? [focusSlug] : [],
        group: groupName,
        summary: g.summary,
        rankings: g.rankings,
        modelFactors: g.factors,
        rulesApplied: g.rulesApplied,
        limitations: g.limitations,
        confidence: g.confidence,
      });
      const steps = plan.planLabels.map((t, i) =>
        step(`gq-${i}`, t, i === 0 ? `Group ${groupName}${focusSlug ? ` · focus ${teamRef(focusSlug).name}` : ""}.` : "Done.")
      );
      const { text, enhanced, provider } = await narrateOrFallback(structured, g.explanation, lang, query, plan.intent);
      const persisted = persist
        ? await savePrediction({
            userQuery: query,
            intent: plan.intent,
            teams: focusSlug ? [focusSlug] : [],
            prediction: null,
            simulationResult: null,
            reasoningSteps: steps.map((s) => s.title),
            explanation: text,
            followUpContext: `group:${groupName}`,
            createdAt,
            language: lang,
            group: groupName,
            summary: g.summary,
            rankings: g.rankings,
            modelFactors: g.factors,
            rulesApplied: g.rulesApplied,
            limitations: g.limitations,
            confidence: g.confidence,
            llmProvider: provider,
          })
        : "none";
      return {
        intent: plan.intent,
        query,
        reasoningSteps: steps,
        structured,
        groupTable: g.table,
        explanation: text,
        fanInsight: `🎟️ ${g.summary}`,
        llmEnhanced: enhanced,
        llmProvider: provider,
        persisted,
        createdAt: createdAt.toISOString(),
        language: lang,
      };
    }
    // No group/team anchor → answer the generic third-place rule instead.
    plan.intent = "rules-explanation";
    const { topic, explanation, fanInsight } = explainRules(query || "third place", lang);
    return {
      intent: plan.intent,
      query,
      reasoningSteps: [step("rules", "Explain the qualification rule", `Topic: ${topic}.`)],
      explanation,
      fanInsight,
      llmEnhanced: false,
      persisted: "none",
      createdAt: createdAt.toISOString(),
      language: lang,
    };
  }

  // ---- PATH ANALYSIS ------------------------------------------------------
  if (plan.intent === "path-analysis" && plan.teamSlugs.length >= 1) {
    const team = teamRef(plan.teamSlugs[0]);
    const pState = await getTournamentState();
    const pEliminated = isEliminated(team.slug, pState);
    const pStatus = pEliminated
      ? "eliminated"
      : pState.teams.find((t) => t.slug === team.slug)?.status ??
        (pState.mode === "demo" || pState.mode === "unavailable" ? "active (no live state)" : "active");
    const p = buildPathAnalysis(team, pStatus);
    const structured = makeStructured({
      intentType: "PATH_ANALYSIS",
      query,
      language: lang === "zh-CN" ? "zh" : "en",
      teams: [team.slug],
      group: groupOf(team.slug).name,
      summary: p.summary,
      rankings: p.rankings,
      modelFactors: p.factors,
      rulesApplied: p.rulesApplied,
      limitations: p.limitations,
      confidence: p.confidence,
    });
    const steps = plan.planLabels.map((t, i) =>
      step(`path-${i}`, t, i === 0 ? `${team.name} · Group ${groupOf(team.slug).name}.` : "Done.")
    );
    const narrated = pEliminated
      ? await deterministicAnswer(`${eliminationNotice(team.slug, pState, "en-US")}\n\n${p.explanation}`, lang)
      : await narrateOrFallback(structured, p.explanation, lang, query, plan.intent);
    // Deterministic bracket path appended AFTER narration — the LLM never gets
    // the chance to drop or rewrite the official routing.
    const text = p.pathBlock && !narrated.text.includes("Potential path")
      ? `${narrated.text}\n\n${p.pathBlock}`
      : narrated.text;
    const { enhanced, provider } = narrated;
    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [team.slug],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: `path:${team.slug}`,
          createdAt,
          language: lang,
          group: groupOf(team.slug).name,
          summary: p.summary,
          rankings: p.rankings,
          modelFactors: p.factors,
          rulesApplied: p.rulesApplied,
          limitations: p.limitations,
          confidence: p.confidence,
          llmProvider: provider,
        })
      : "none";
    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      structured,
      explanation: text,
      fanInsight: `🗺️ ${p.summary}`,
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
      tournamentState: toView(pState),
    };
  }

  // ---- TEAM ANALYSIS ------------------------------------------------------
  if (plan.intent === "team-analysis" && plan.teamSlugs.length >= 1) {
    const team = teamRef(plan.teamSlugs[0]);
    const taState = await getTournamentState();
    const taEliminated = isEliminated(team.slug, taState);
    const { resolved } = await resolveTeamNews(team, 4);
    const a = buildTeamAnalysis(team, resolved.items);
    const structured = makeStructured({
      intentType: "TEAM_ANALYSIS",
      query,
      language: lang === "zh-CN" ? "zh" : "en",
      teams: [team.slug],
      group: groupOf(team.slug).name,
      summary: a.summary,
      modelFactors: a.factors,
      newsSignals: resolved.items.slice(0, 3).map((n) => `${n.impactLevel}-impact ${n.category}: ${n.title}${n.demo ? " (demo)" : ""}`),
      limitations: a.limitations,
      confidence: a.confidence,
    });
    const steps = plan.planLabels.map((t, i) =>
      step(`ta-${i}`, t, i === 0 ? `${team.flag} ${team.name}.` : "Done.")
    );
    const { text, enhanced, provider } = taEliminated
      ? await deterministicAnswer(`${eliminationNotice(team.slug, taState, "en-US")}\n\n${a.explanation}`, lang)
      : await narrateOrFallback(structured, a.explanation, lang, query, plan.intent);
    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [team.slug],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: `team:${team.slug}`,
          createdAt,
          language: lang,
          summary: a.summary,
          modelFactors: a.factors,
          newsSignals: structured.newsSignals,
          limitations: a.limitations,
          confidence: a.confidence,
          llmProvider: provider,
        })
      : "none";
    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      structured,
      explanation: text,
      fanInsight: `📊 ${a.summary}`,
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
      tournamentState: toView(taState),
    };
  }

  // ---- TEAM COMPARISON ----------------------------------------------------
  if (plan.intent === "team-comparison" && plan.teamSlugs.length === 2) {
    const a = teamRef(plan.teamSlugs[0]);
    const b = teamRef(plan.teamSlugs[1]);
    const c = buildTeamComparison(a, b);
    const structured = makeStructured({
      intentType: "TEAM_COMPARISON",
      query,
      language: lang === "zh-CN" ? "zh" : "en",
      teams: [a.slug, b.slug],
      summary: c.summary,
      probabilities: c.probabilities,
      modelFactors: c.factors,
      limitations: c.limitations,
      confidence: c.confidence,
    });
    const steps = plan.planLabels.map((t, i) =>
      step(`tc-${i}`, t, i === 0 ? `${a.flag} ${a.name} vs ${b.flag} ${b.name}.` : "Done.")
    );
    const { text, enhanced, provider } = await narrateOrFallback(structured, c.explanation, lang, query, plan.intent);
    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [a.slug, b.slug],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: `compare:${a.slug}-${b.slug}`,
          createdAt,
          language: lang,
          summary: c.summary,
          modelFactors: c.factors,
          limitations: c.limitations,
          confidence: c.confidence,
          llmProvider: provider,
        })
      : "none";
    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      structured,
      explanation: text,
      fanInsight: `⚖️ ${c.summary}`,
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
    };
  }

  // ---- TEAM NEWS DIGEST -------------------------------------------------
  if (plan.intent === "team-news" && plan.teamSlugs.length >= 1) {
    const team = teamRef(plan.teamSlugs[0]);
    const { resolved, source } = await resolveTeamNews(team, 8);
    const view = summarizeTeam(resolved);

    const steps: ReasoningStep[] = [
      step("identify", "Identify the team", `Focused on ${team.name} ${team.flag}.`),
      step(
        "news",
        "Pull the latest team news",
        `Loaded ${resolved.items.length} recent item${resolved.items.length === 1 ? "" : "s"} for ${team.name}.`,
        source === "demo"
          ? "Source: curated demo signals (no live news API key configured)."
          : "Source: live news API."
      ),
      step("classify", "Classify each item", "Tagged category, impact level and direction for each item."),
      step("summary", "Summarize for the team", view.headline),
    ];

    const digest = buildTeamNewsDigest(view, source);
    const narrated = await finalizeNarrative(
      digest,
      `Latest team-news digest for ${team.name}. Keep facts intact.${
        source === "demo"
          ? " Keep the 'demo data' caveat intact."
          : " This team news is live (real sourced articles); do NOT add any 'demo data' or 'sample data' caveat."
      }`,
      lang,
      query,
      plan.intent
    );
    // Honesty guarantee: re-append the weak-signal disclosure if LLM polish
    // dropped it — the agent never implies squad trouble the sources lack.
    const strongSignal = view.items.some(
      (it) => (it.category === "injury" || it.category === "suspension") && it.impactLevel !== "low"
    );
    const text =
      source === "api" && !strongSignal && !narrated.text.includes("no strong team-specific")
        ? `${narrated.text}\n\n_I found recent headlines, but no strong team-specific injury/suspension/conflict signal in the current news batch._`
        : narrated.text;
    const { enhanced, method, provider } = narrated;

    const topNeg = view.items.find((i) => i.direction === "negative");
    const fanInsightEn = topNeg
      ? `📰 ${team.flag} ${team.name}: ${topNeg.impactLevel}-impact ${topNeg.category} update is the one to watch before kickoff.`
      : `📰 ${team.flag} ${team.name} look settled — no major negative news in the latest signals.`;
    const fanInsight = lang === "en-US" ? fanInsightEn : (await localizeText(fanInsightEn, lang)).text;

    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: [team.slug],
          prediction: null,
          simulationResult: null,
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: `team-news:${team.slug}`,
          createdAt,
          llmProvider: provider,
        })
      : "none";

    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      teamNews: view,
      explanation: text,
      fanInsight,
      newsSource: source,
      newsProvider: activeNewsProviderName(),
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
      localizationMethod: method,
    };
  }

  // ---- PREMIER LEAGUE TITLE ODDS ----------------------------------------
  // There is no frozen production title artifact. Do not mix live fixtures
  // with historical-tape Elo or ad-hoc season simulation.
  if (
    plan.competition === "premier-league" &&
    plan.intent === "champion-odds" &&
    plan.teamSlugs.length < 2
  ) {
    return refusedPremierLeagueResponse({
      query,
      intent: plan.intent,
      refusal: unsupportedPremierLeagueTitleRefusal(),
      createdAt,
      language: lang,
    });
  }

  // ---- CHAMPION ODDS ----------------------------------------------------
  if (plan.intent === "champion-odds" && plan.teamSlugs.length < 2) {
    // Deterministic tournament state gates the model: eliminated teams cannot win.
    const tState = await getTournamentState();
    const allChampions = getChampionProbabilities();
    const { champions } = gateChampionOdds(allChampions, tState);
    const focusSlug = plan.teamSlugs[0];
    const focusEliminated = focusSlug ? isEliminated(focusSlug, tState) : false;
    const answer: ChampionAnswer = {
      simulationsRun: 10000,
      contenders: champions.slice(0, 8).map((c) => ({
        slug: c.slug,
        name: c.name,
        flag: c.flag,
        champion: c.champion,
        elo: c.elo,
      })),
    };

    const stateStepDetail =
      tState.mode === "demo"
        ? "No live tournament state configured — all teams treated as active (demo)."
        : tState.mode === "unavailable"
          ? "Live tournament state unavailable — no eliminations applied."
          : `${tState.eliminatedCount} team(s) eliminated per ${tState.source}; their title odds set to 0.`;
    const steps: ReasoningStep[] = [
      step("plan", "Plan the analysis", `Intent: tournament-winner question. ${plan.planLabels[0]}.`),
      step("state", "Check live tournament state", stateStepDetail),
      step(
        "data",
        "Load team data",
        "Loaded all 48 qualified nations and their calibrated Elo ratings."
      ),
      step(
        "sim",
        "Run tournament Monte Carlo",
        "Simulated the full 48-team bracket 10,000 times (groups → best thirds → knockouts)."
      ),
      step("report", "Rank contenders", "Tallied title wins per nation and ranked the field."),
    ];

    let explanation = buildChampionExplanation(answer);
    if (focusSlug && focusEliminated) {
      // Deterministic fact — prepended and NOT overridable by the LLM below.
      explanation = `${eliminationNotice(focusSlug, tState, "en-US")}\n\n${explanation}`;
    } else {
      const focus = focusSlug ? champions.find((c) => c.slug === focusSlug) : undefined;
      if (focus) {
        explanation =
          `${focus.flag} ${focus.name} win the 2026 World Cup in ${(focus.champion * 100).toFixed(
            1
          )}% of simulations (Elo ${focus.elo}).\n\n` + explanation;
      }
    }
    if (tState.eliminatedCount > 0) {
      explanation += `\n\n_Live tournament state: ${tState.eliminatedCount} eliminated team(s) removed from title contention (source: ${tState.source})._`;
    }

    const fanInsightEn = `🏆 ${answer.contenders[0].flag} ${answer.contenders[0].name} lead the title race at ${(
      answer.contenders[0].champion * 100
    ).toFixed(1)}% — but 10k sims say it's wide open.`;

    // If the focus team is eliminated, keep the answer deterministic (translate
    // only for non-English) so the LLM can never "un-eliminate" a team.
    let text: string;
    let enhanced: boolean;
    let method: "none" | "gemini" | "deepseek" | "template";
    let provider: ActiveProvider | null;
    if (focusEliminated) {
      const loc = lang === "en-US" ? { text: explanation, method: "none" as const } : await localizeText(explanation, lang);
      text = loc.text;
      method = loc.method;
      enhanced = false;
      provider = null;
    } else {
      ({ text, enhanced, method, provider } = await finalizeNarrative(
        explanation,
        "Tournament title odds from a 10,000-run Monte Carlo simulation of the 2026 World Cup. Eliminated teams have already been removed deterministically.",
        lang,
        query,
        plan.intent
      ));
    }
    text = withBettingNote(text, query);
    const fanInsight = lang === "en-US" ? fanInsightEn : (await localizeText(fanInsightEn, lang)).text;
    const localizedSummary = lang === "en-US" ? undefined : buildChampionSummary(answer, lang);

    const persisted = persist
      ? await savePrediction({
          userQuery: query,
          intent: plan.intent,
          teams: focusSlug ? [focusSlug] : [],
          prediction: null,
          simulationResult: {
            simulationsRun: 10000,
            mostLikelyScore: `${answer.contenders[0].name} champions`,
            upsetProbability: 1 - answer.contenders[0].champion,
            summary: `${answer.contenders[0].name} most likely champions at ${(
              answer.contenders[0].champion * 100
            ).toFixed(1)}%.`,
          },
          reasoningSteps: steps.map((s) => s.title),
          explanation: text,
          followUpContext: "",
          createdAt,
          llmProvider: provider,
        })
      : "none";

    return {
      intent: plan.intent,
      query,
      reasoningSteps: steps,
      champions: answer,
      explanation: text,
      fanInsight,
      llmEnhanced: enhanced,
      llmProvider: provider,
      persisted,
      createdAt: createdAt.toISOString(),
      language: lang,
      localizedSummary,
      localizationMethod: method,
      tournamentState: toView(tState),
    };
  }

  // ---- MATCH / SCENARIO / TIKTOK ---------------------------------------
  // Resolve the two teams (fall back to the follow-up context if needed).
  let slugs = plan.teamSlugs;
  if (slugs.length < 2 && input.contextTeams && input.contextTeams.length === 2) {
    slugs = input.contextTeams;
  }

  if (slugs.length === 2 && plan.competition === "premier-league") {
    if (plan.intent === "scenario") {
      return refusedPremierLeagueResponse({
        query,
        intent: plan.intent,
        refusal: unsupportedPremierLeagueScenarioRefusal(),
        createdAt,
        language: lang,
      });
    }
    try {
      const forecast = await loadFrozenPremierLeagueForecast(slugs[0], slugs[1], createdAt);
      const result = predictionFromFrozenForecast(forecast);
      const simulation = simulationFromFrozenForecast(forecast);
      const explanation = explanationFromFrozenForecast(forecast, result);
      const steps: ReasoningStep[] = [
        step("plan", "Plan the analysis", "Premier League match prediction from frozen production truth."),
        step(
          "snapshot",
          "Load immutable LIVE_OOS forecast",
          `${forecast.matchId} · ${forecast.provenance.immutableForecastId} · cutoff ${forecast.cutoffAt}.`
        ),
        step(
          "report",
          "Copy frozen 1X2",
          `Home ${result.teamA.name} ${(result.teamAWin * 100).toFixed(1)}% · Draw ${(result.draw * 100).toFixed(1)}% · Away ${result.teamB.name} ${(result.teamBWin * 100).toFixed(1)}%.`
        ),
      ];
      const productionForecast = {
        matchId: forecast.matchId,
        forecastId: forecast.provenance.immutableForecastId,
        cutoffAt: forecast.cutoffAt,
        modelVersion: forecast.modelVersion,
        modelRole: "production" as const,
      };
      return {
        intent: "match-prediction",
        query,
        reasoningSteps: steps,
        prediction: result,
        simulation,
        explanation,
        fanInsight: `${result.teamA.name} ${(result.teamAWin * 100).toFixed(0)}% / draw ${(result.draw * 100).toFixed(0)}% / ${result.teamB.name} ${(result.teamBWin * 100).toFixed(0)}%.`,
        llmEnhanced: false,
        persisted: persist
          ? await savePrediction({
              userQuery: query,
              intent: "match-prediction",
              teams: [result.teamA.slug, result.teamB.slug],
              prediction: {
                teamAWin: result.teamAWin,
                draw: result.draw,
                teamBWin: result.teamBWin,
                confidence: result.confidenceScore,
              },
              simulationResult: {
                simulationsRun: simulation.simulationsRun,
                mostLikelyScore: simulation.mostLikelyScore,
                upsetProbability: simulation.upsetProbability,
                summary: simulation.summary,
              },
              reasoningSteps: steps.map((s) => s.title),
              explanation,
              followUpContext: `${result.teamA.name} vs ${result.teamB.name}`,
              createdAt,
            })
          : "none",
        createdAt: createdAt.toISOString(),
        language: lang,
        productionForecast,
      };
    } catch (error) {
      const refusal = productionRefusalFromError(error);
      if (refusal) {
        return refusedPremierLeagueResponse({
          query,
          intent: "match-prediction",
          refusal,
          createdAt,
          language: lang,
        });
      }
      throw error;
    }
  }

  if (slugs.length < 2) {
    // Could not find a matchup — return a helpful "unknown" response.
    const steps: ReasoningStep[] = [
      step("plan", "Parse the question", "Looked for two national teams or a tournament-level intent."),
      step(
        "data",
        "Resolve entities",
        slugs.length === 1
          ? `Found one team (${teamRef(slugs[0]).name}) but no opponent.`
          : "Could not confidently identify two teams."
      ),
    ];
    const examples = [
      "Match prediction: Who will win Argentina vs Germany?",
      "Tournament forecast: Who will win the 2026 World Cup?",
      "Group qualification: Which teams qualify from Group A?",
      "Team analysis: Is Argentina strong this year?",
      "News: Germany injury update",
      "Rules: How do yellow cards affect qualification?",
    ];
    const hasCJK = /[一-鿿]/.test(query);
    const scopeNote = nonQualified
      ? hasCJK || lang === "zh-CN"
        ? `**${nonQualified.zh}** 不在本模型的 2026 世界杯 48 强决赛圈名单中，因此无法夺冠，也无法参与对阵模拟。可以问我已晋级的球队（如阿根廷、西班牙、法国）。\n\n`
        : `**${nonQualified.en}** is not in the 2026 World Cup finals field (48 teams) in this model, so it can't win the tournament or be simulated in a matchup. Ask about a qualified team (e.g. Argentina, Spain, France).\n\n`
      : outOfScope
        ? "This production agent serves frozen **Premier League** `pl-live-v0.2.0` forecasts and the archived **FIFA World Cup 2026** research plugin. It does not emit production numbers for Euros, Champions League, or the other Big Five leagues. Labeled research 1X2 for La Liga, Bundesliga, Serie A and Ligue 1 lives on `/research/big-five` as an unfitted prior, not as production truth.\n\n"
        : "";
    const explanationEn =
      scopeNote +
      "I couldn't match that to one of my analyses yet. Here's what you can ask:\n\n• " +
      examples.join("\n• ");
    const fanEn = "Give me a matchup, a team, a group, or a rules question — I'll take it from there. ⚽";
    let explanation = explanationEn;
    // Out-of-scope / non-qualified answers stay deterministic — the LLM doesn't
    // get a chance to improvise about teams or competitions the engine doesn't model.
    if (!outOfScope && !nonQualified && llmConfigured()) {
      const c = await generateClarification(query, examples, lang === "zh-CN" ? "zh" : "en");
      if (c) explanation = c;
    }
    if (explanation === explanationEn && lang !== "en-US") {
      explanation = (await localizeText(explanationEn, lang)).text;
    }
    const fanInsight = lang === "en-US" ? fanEn : (await localizeText(fanEn, lang)).text;
    return {
      intent: "unknown",
      query,
      reasoningSteps: steps,
      explanation,
      fanInsight,
      llmEnhanced: false,
      persisted: "none",
      createdAt: createdAt.toISOString(),
      language: lang,
    };
  }

  const teamA = teamRef(slugs[0]);
  const teamB = teamRef(slugs[1]);

  // Scenario adjustment (only for follow-up what-ifs).
  const scenario =
    plan.intent === "scenario" ? resolveScenario(query, teamA, teamB) : null;
  const eloA = teamA.elo + (scenario?.eloDeltaA ?? 0);
  const eloB = teamB.elo + (scenario?.eloDeltaB ?? 0);

  const prediction = predictMatch(teamA.slug, teamB.slug, undefined, {
    eloOverrideA: scenario ? eloA : undefined,
    eloOverrideB: scenario ? eloB : undefined,
  });
  // Simulate with the SAME ratings the prediction used (prediction.eloA/eloB
  // already fold in the scenario override OR the per-fixture tactical matchup),
  // so the "we ran 10,000 sims" view stays consistent with the headline odds.
  const simulation = runSimulation(teamA, teamB, {
    eloA: prediction.eloA,
    eloB: prediction.eloB,
  });

  const bundle: PredictionBundle = { prediction, teamA, teamB, simulation };
  const result = toPredictionResult(bundle);

  // ---- Daily News Resolver + Injury / Squad Impact Analyzer -------------
  // Load recent news for both teams and compute a capped, transparent nudge to
  // the headline probabilities. News is a lightweight signal layer on top of
  // the base simulation — never a replacement for it.
  const news = await resolveNews(teamA, teamB, 4);
  const newsImpact: NewsImpactReport = analyzeNewsImpact(news, {
    teamAWin: result.teamAWin,
    draw: result.draw,
    teamBWin: result.teamBWin,
  });
  if (newsImpact.adjustment.applied) {
    const adj = newsImpact.adjustment.adjusted;
    result.teamAWin = adj.teamAWin;
    result.draw = adj.draw;
    result.teamBWin = adj.teamBWin;
    const close = Math.abs(adj.teamAWin - adj.teamBWin) < 0.05;
    result.favorite = close
      ? "Too close to call"
      : adj.teamAWin > adj.teamBWin
        ? teamA.name
        : teamB.name;
  }

  const newsStepDesc = `Pulled ${news.teamA.items.length} ${teamA.name} + ${news.teamB.items.length} ${teamB.name} recent news item${
    news.teamA.items.length + news.teamB.items.length === 1 ? "" : "s"
  }.`;
  const newsSourceNote =
    news.source === "demo"
      ? "Source: curated demo signals (no live news API key configured)."
      : "Source: live news API.";

  // Build the visible reasoning timeline.
  const steps: ReasoningStep[] =
    plan.intent === "scenario"
      ? [
          step(
            "detect",
            "Detect the scenario change",
            scenario?.label ?? "Re-evaluating the prior matchup under new conditions.",
            scenario?.description
          ),
          step(
            "reweight",
            "Re-weight team strength",
            `Adjusted ratings: ${teamA.name} ${eloA}, ${teamB.name} ${eloB}.`
          ),
          step("news", "Re-check daily team news", newsStepDesc, newsSourceNote),
          step("impact", "Re-check injury / squad impact", newsImpact.note),
          step(
            "sim",
            "Re-run Monte Carlo simulation",
            `Re-simulated the matchup ${simulation.simulationsRun.toLocaleString()} times.`
          ),
          step("report", "Explain what changed", "Compared the new probabilities to the baseline."),
        ]
      : [
          step(
            "data",
            "Gather match data",
            `Identified ${teamA.name} ${teamA.flag} and ${teamB.name} ${teamB.flag} and loaded their team profiles.`
          ),
          step("news", "Resolve daily team news", newsStepDesc, newsSourceNote),
          step(
            "impact",
            "Analyze injury / squad impact",
            newsImpact.note,
            `${newsImpact.teamA.headline} ${newsImpact.teamB.headline}`
          ),
          step(
            "analyze",
            "Analyze team strength",
            `Compared Elo (${teamA.elo} vs ${teamB.elo}), host advantage, expected goals and draw likelihood.`
          ),
          step(
            "sim",
            "Run Monte Carlo simulation",
            `Simulated the matchup ${simulation.simulationsRun.toLocaleString()} times.`,
            `Most-likely scoreline ${result.mostLikelyScore}; upset probability ${(
              simulation.upsetProbability * 100
            ).toFixed(0)}%.`
          ),
          step(
            "report",
            "Generate prediction report",
            "Converted the simulation + news signals into a clear, fan-friendly prediction."
          ),
        ];

  // Narrative.
  let explanation = buildExplanation(bundle);
  if (scenario) {
    explanation = `**What changed:** ${scenario.description}\n\n${explanation}`;
  }
  explanation = `${explanation}\n\n${buildNewsNarrative(newsImpact)}`;
  let fanInsight = buildFanInsight(bundle);
  const tiktokScript =
    plan.intent === "tiktok-preview" ? buildTiktokScript(bundle) : undefined;

  const matchNarrated = await finalizeNarrative(
    explanation,
    `News-aware match prediction: ${teamA.name} vs ${teamB.name}.${
      scenario ? " This is a what-if scenario re-analysis." : ""
    } A capped news-signal layer adjusted the probabilities; keep all numbers intact.${
      newsImpact.source === "demo"
        ? " Keep the 'demo data' caveat intact."
        : " The team news is live (real sourced articles); do NOT add any 'demo data' or 'sample data' caveat."
    }`,
    lang,
    query,
    plan.intent
  );
  // If this exact pairing has already been played (the tournament is live), lead
  // with the real score — the model's read is retrospective, not a fresh tip. A
  // what-if scenario re-frames the game hypothetically, so it is left untouched.
  const completedFixture =
    plan.intent === "match-prediction"
      ? getCompletedFixture(teamA.slug, teamB.slug)
      : null;
  const resultPrefix = completedFixtureNote(completedFixture, teamA.name, teamB.name, lang);
  // For an UPCOMING fixture (a real match-prediction the model hasn't seen played),
  // state how fresh the results behind the read are — and flag it when stale. A
  // played fixture already leads with the result banner, and scenario/tiktok
  // intents are hypothetical/stylised, so neither gets the footnote.
  const freshnessNote =
    plan.intent === "match-prediction" && !completedFixture ? freshnessFootnote(lang) : "";
  const text =
    resultPrefix +
    withFixtureNote(withBettingNote(matchNarrated.text, query), query, lang) +
    freshnessNote;
  const { enhanced, method, provider } = matchNarrated;
  // In-language deterministic headline (also used for text-to-speech).
  const localizedSummary = lang === "en-US" ? undefined : buildMatchSummary(result, lang);
  if (lang !== "en-US") fanInsight = (await localizeText(fanInsight, lang)).text;

  const followUpContext = [scenario?.label, newsImpact.adjustment.applied ? newsImpact.note : ""]
    .filter(Boolean)
    .join(" · ");

  const persisted = persist
    ? await savePrediction({
        userQuery: query,
        intent: plan.intent,
        teams: [teamA.slug, teamB.slug],
        prediction: {
          teamAWin: result.teamAWin,
          draw: result.draw,
          teamBWin: result.teamBWin,
          confidence: result.confidenceScore,
        },
        simulationResult: {
          simulationsRun: simulation.simulationsRun,
          mostLikelyScore: result.mostLikelyScore,
          upsetProbability: simulation.upsetProbability,
          summary: simulation.summary,
        },
        reasoningSteps: steps.map((s) => s.title),
        explanation: text,
        followUpContext,
        createdAt,
        llmProvider: provider,
      })
    : "none";

  return {
    intent: plan.intent,
    query,
    reasoningSteps: steps,
    prediction: result,
    simulation,
    newsImpact,
    newsSource: news.source,
    newsProvider: activeNewsProviderName(),
    explanation: text,
    fanInsight,
    tiktokScript,
    scenarioNote: scenario?.label,
    llmEnhanced: enhanced,
    llmProvider: provider,
    persisted,
    createdAt: createdAt.toISOString(),
    language: lang,
    localizedSummary,
    localizationMethod: method,
  };
}

export { geminiConfigured };
export type { AgentResponse } from "./types";
