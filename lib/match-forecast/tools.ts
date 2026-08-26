/**
 * Deterministic tools available to the match-scoped Agent.
 *
 * These functions are deliberately boring data accessors over one immutable
 * MatchIntelligence context. They are the only forecasting surface the prose
 * layer needs; none accepts an LLM-authored probability or numeric adjustment.
 */

import { getMatchIntelligence } from "./service";
import type { ForecastComparison, MatchForecast, MatchIntelligence } from "./types";
import { runMatchScenario, type MatchScenarioOverride } from "./scenario";

export interface MatchAgentToolContext {
  intelligence: MatchIntelligence;
}

export async function getMatchContext(
  matchId: string,
  now = new Date()
): Promise<MatchAgentToolContext> {
  return { intelligence: await getMatchIntelligence(matchId, now) };
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
  return context.intelligence.context.atForecast.availability;
}

export function getProbabilityHistory(context: MatchAgentToolContext) {
  return context.intelligence.timeline;
}

export function getForecastTimeline(context: MatchAgentToolContext) {
  return context.intelligence.timeline;
}

export function getContextEvidence(context: MatchAgentToolContext) {
  return {
    atForecast: context.intelligence.context.atForecast,
    latest: context.intelligence.context.latest,
  };
}

export function compareMatchContext(context: MatchAgentToolContext) {
  return context.intelligence.contextComparison;
}

export function compareLatestForecastSnapshots(
  context: MatchAgentToolContext
): ForecastComparison | null {
  return context.intelligence.comparison;
}

export function runSupportedScenario(
  context: MatchAgentToolContext,
  scenario: MatchScenarioOverride
) {
  return runMatchScenario({
    baseline: context.intelligence.forecast,
    matchId: context.intelligence.match.id,
    forecastId: context.intelligence.audit.immutableForecastId,
    override: scenario,
  });
}
