/**
 * Agent domain types — the contract between the agent pipeline, the API layer,
 * and the UI. Everything the chat surface renders is described here.
 */

import type { MatchPrediction } from "@/lib/types";
import type { NewsCategory, NewsDirection, NewsImpact, NewsSource } from "@/lib/news/types";
import type { TournamentStateView } from "@/lib/live-sports/types";

/** What the planner decided the user is asking for. */
export type AgentIntent =
  | "match-prediction" // "Who wins Argentina vs Portugal?"
  | "champion-odds" // "Who will win the 2026 World Cup?"
  | "scenario" // follow-up: "What if Messi was unavailable?"
  | "tiktok-preview" // "Give me a TikTok-style preview..."
  | "team-news" // "Show me the latest Argentina news"
  | "rules-explanation" // "How do best third-placed teams advance?"
  | "group-qualification" // "Which teams qualify from Group A?"
  | "path-analysis" // "Argentina path to the final"
  | "team-analysis" // "Is Argentina strong this year?"
  | "team-comparison" // "Compare Argentina and France"
  | "model-explanation" // "How does your model work?"
  | "unknown";

/** A single visible step in the agent's reasoning timeline. */
export interface ReasoningStep {
  id: string;
  title: string;
  status: "completed" | "running" | "pending";
  description: string;
  /** Optional structured detail rendered under the step. */
  detail?: string;
}

/** Output of the Monte Carlo single-match simulator. */
export interface SimulationResult {
  simulationsRun: number;
  teamAWin: number; // share 0–1
  draw: number;
  teamBWin: number;
  mostLikelyScore: string; // "2-1"
  topScorelines: { score: string; share: number }[];
  upsetProbability: number; // share the underdog wins outright
  avgGoalsA: number;
  avgGoalsB: number;
  summary: string;
}

/** The headline numbers the prediction card renders. */
export interface PredictionResult {
  teamA: TeamRef;
  teamB: TeamRef;
  teamAWin: number; // 0–1
  draw: number;
  teamBWin: number;
  confidenceLevel: string;
  confidenceScore: number; // 0–100
  mostLikelyScore: string;
  upsetProbability: number; // 0–1
  expectedScore: string;
  favorite: string; // team name or "Too close to call"
  keyFactors: { label: string; detail: string; weight: string }[];
}

export interface TeamRef {
  slug: string;
  name: string;
  flag: string;
  elo: number;
}

/** Champion-odds answer (for "who wins the whole thing" queries). */
export interface ChampionAnswer {
  simulationsRun: number;
  contenders: {
    slug: string;
    name: string;
    flag: string;
    champion: number; // 0–1
    elo: number;
  }[];
}

/** One news item as rendered in the UI / explanation. */
export interface NewsItemView {
  title: string;
  summary: string;
  category: NewsCategory;
  impactLevel: NewsImpact;
  direction: NewsDirection;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string; // ISO
  demo: boolean;
  /** Mirrors a sourced signal already folded into the BASE model (squad
   *  availability / pre-match intel) — displayed, but excluded from the news
   *  nudge so it is never double-counted. */
  modelled?: boolean;
}

/** Per-team news view inside a news-impact report. */
export interface TeamNewsView {
  team: TeamRef;
  items: NewsItemView[];
  netDirection: NewsDirection | "mixed";
  /** One-line read of what the news means for this team. */
  headline: string;
}

/** How news shifted the headline probabilities (percentage points). */
export interface NewsAdjustment {
  applied: boolean; // true if any non-trivial shift happened
  base: { teamAWin: number; draw: number; teamBWin: number };
  adjusted: { teamAWin: number; draw: number; teamBWin: number };
  deltaPts: { teamAWin: number; draw: number; teamBWin: number };
}

/** The "Latest News Impact" report attached to a matchup prediction. */
export interface NewsImpactReport {
  teamA: TeamNewsView;
  teamB: TeamNewsView;
  adjustment: NewsAdjustment;
  note: string; // "Prediction impact: ..."
  source: NewsSource; // 'api' | 'demo'
  disclaimer: string;
}

/** One model dimension / prediction factor shown in the factors card. */
export interface StructuredFactor {
  label: string;
  value: string;
  weight: "high" | "medium" | "low";
}

/**
 * Normalized structured result attached to every answer type. This is what the
 * UI factors card renders, what the optional LLM narrates (its ONLY source of
 * truth), and what gets persisted to MongoDB alongside the legacy fields.
 */
export interface StructuredResult {
  intentType: string;
  language: string;
  query: string;
  teams: string[];
  group: string | null;
  stage: string | null;
  summary: string;
  probabilities: Record<string, number> | null;
  rankings: Array<Record<string, unknown>> | null;
  modelFactors: StructuredFactor[];
  rulesApplied: string[];
  newsSignals: string[];
  limitations: string[];
  confidence: number; // 0–100
}

/** Group-qualification table view for the UI. */
export interface GroupTableData {
  group: string;
  rows: {
    slug: string;
    name: string;
    flag: string;
    elo: number;
    winGroup: number;
    advance: number;
    expectedPoints: number;
  }[];
  focusSlug?: string;
}

export type ProductionRefusalCode =
  | "NO_PRODUCTION_FORECAST"
  | "UNKNOWN_MATCH"
  | "FORECAST_INTEGRITY"
  | "UNSUPPORTED_PRODUCTION_QUESTION";

/** Fail-closed Premier League production answer: no invented probabilities. */
export interface ProductionRefusal {
  code: ProductionRefusalCode;
  message: string;
  status: number;
  competition: "premier-league";
}

export interface ProductionForecastRef {
  matchId: string;
  forecastId: string;
  cutoffAt: string;
  modelVersion: string;
  modelRole: "production";
}

/** The complete answer the agent returns for one turn. */
export interface AgentResponse {
  intent: AgentIntent;
  query: string;
  reasoningSteps: ReasoningStep[];
  /** Present for match-prediction / scenario / tiktok intents. */
  prediction?: PredictionResult;
  simulation?: SimulationResult;
  /** Present for champion-odds intent. */
  champions?: ChampionAnswer;
  explanation: string; // plain-English "Why?"
  fanInsight: string; // punchy one/two-liner
  tiktokScript?: string; // optional social preview
  /** Scenario follow-ups note what changed vs the base prediction. */
  scenarioNote?: string;
  /** Daily news intelligence considered for this matchup (two-team intents). */
  newsImpact?: NewsImpactReport;
  /** Normalized structured result (new intents; the LLM's only source of truth). */
  structured?: StructuredResult;
  /** Group-qualification table (group-qualification intent). */
  groupTable?: GroupTableData;
  /** Single-team news digest (team-news intent). */
  teamNews?: TeamNewsView;
  /** Whether news shown is from a live API ('api') or curated demo data. */
  newsSource?: NewsSource;
  /** Active live news provider name (e.g. "GNews"), or null in demo mode. */
  newsProvider?: string | null;
  /** True when an LLM generated/polished the narrative, false on deterministic fallback. */
  llmEnhanced: boolean;
  /** Which LLM actually produced the prose (cost-aware router): deepseek · gemini · null. */
  llmProvider?: "deepseek" | "gemini" | null;
  persisted: "mongodb" | "memory" | "none";
  createdAt: string;
  /** Global Voice Mode: the language the answer was localized to (BCP-47). */
  language?: string;
  /** In-language one-line result summary (deterministic, used for TTS/headline). */
  localizedSummary?: string;
  /** How the narrative was localized: none (English) · gemini · deepseek · template. */
  localizationMethod?: "none" | "gemini" | "deepseek" | "template";
  /** Live tournament-state badge (Live API / Cached / Demo, eliminated count). */
  tournamentState?: TournamentStateView;
  /** Set when a Premier League request is refused instead of inventing numbers. */
  productionRefusal?: ProductionRefusal;
  /** Frozen LIVE_OOS identity when Premier League match numbers are served. */
  productionForecast?: ProductionForecastRef;
}

/** Internal: raw model bundle before narrative generation. */
export interface PredictionBundle {
  prediction: MatchPrediction;
  teamA: TeamRef;
  teamB: TeamRef;
  simulation: SimulationResult;
}
