/**
 * Deterministic tools available to the match-scoped Agent.
 *
 * These functions are deliberately boring data accessors over one immutable
 * MatchIntelligence context. They are the only forecasting surface the prose
 * layer needs; none accepts an LLM-authored probability or numeric adjustment.
 */

import { getMatchIntelligence } from "./service";
import type { ForecastComparison, MatchForecast, MatchIntelligence } from "./types";

export interface MatchAgentToolContext {
  intelligence: MatchIntelligence;
}

export async function getMatchContext(matchId: string): Promise<MatchAgentToolContext> {
  return { intelligence: await getMatchIntelligence(matchId) };
}

export function getMatchForecast(context: MatchAgentToolContext): MatchForecast {
  return context.intelligence.forecast;
}

export function getScoreDistribution(context: MatchAgentToolContext): {
  scoreMatrix: number[][];
  exactScores: MatchForecast["exactScores"];
  topScores: MatchForecast["topScores"];
  immutableForecastId: string;
} {
  const forecast = getMatchForecast(context);
  return {
    scoreMatrix: forecast.scoreMatrix,
    exactScores: forecast.exactScores,
    topScores: forecast.topScores,
    immutableForecastId: forecast.provenance.immutableForecastId,
  };
}

export function getMarketProbabilities(context: MatchAgentToolContext) {
  const forecast = getMatchForecast(context);
  return {
    result: forecast.result,
    expectedGoals: forecast.expectedGoals,
    totals: forecast.totals,
    btts: forecast.btts,
    doubleChance: forecast.doubleChance,
    drawNoBet: forecast.drawNoBet,
    teamTotals: forecast.teamTotals,
    immutableForecastId: forecast.provenance.immutableForecastId,
  };
}

export function getForecastProvenance(context: MatchAgentToolContext) {
  return context.intelligence.audit;
}

export function getTeamNews(context: MatchAgentToolContext) {
  return context.intelligence.context.news;
}

export function getTeamAvailability(context: MatchAgentToolContext) {
  return context.intelligence.context.availability;
}

export function getProbabilityHistory(context: MatchAgentToolContext) {
  return context.intelligence.timeline;
}

export function compareLatestForecastSnapshots(
  context: MatchAgentToolContext
): ForecastComparison | null {
  return context.intelligence.comparison;
}

export function runSupportedScenario(
  context: MatchAgentToolContext,
  scenario: { type: string; [key: string]: unknown }
): {
  supported: false;
  baselineForecastId: string;
  scenario: { type: string; [key: string]: unknown };
  reason: string;
} {
  return {
    supported: false,
    baselineForecastId: context.intelligence.audit.immutableForecastId,
    scenario,
    reason:
      "The current Premier League production model has no audited deterministic scenario mechanism for this input. The baseline forecast is unchanged.",
  };
}
