/**
 * Premier League answers for the legacy public agent must copy a frozen
 * LIVE_OOS forecast. They must never call the live predictor.
 */

import { getClub } from "@/lib/competitions/premier-league/clubs";
import {
  latestMatchForecast,
  MatchForecastError,
  resolvePremierLeagueFixtureByClubs,
} from "@/lib/match-forecast/service";
import type { MatchForecast } from "@/lib/match-forecast/types";
import type { LangCode } from "@/lib/i18n/languages";
import type {
  AgentIntent,
  AgentResponse,
  PredictionResult,
  ProductionRefusal,
  ReasoningStep,
  SimulationResult,
  TeamRef,
} from "./types";

function step(id: string, title: string, description: string): ReasoningStep {
  return { id, title, status: "completed", description };
}

function clubRef(slug: string, elo: number): TeamRef {
  const club = getClub(slug);
  return { slug: club.slug, name: club.name, flag: "⚽️", elo };
}

function frozenElo(forecast: MatchForecast, side: "home" | "away"): number {
  const key = side === "home" ? "eloHome" : "eloAway";
  const value = forecast.provenance.inputSnapshots[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function productionRefusalFromError(error: unknown): ProductionRefusal | null {
  if (!(error instanceof MatchForecastError)) return null;
  const code =
    error.code === "UNKNOWN_MATCH" || error.code === "NO_PRODUCTION_FORECAST"
      ? error.code
      : "FORECAST_INTEGRITY";
  return {
    code,
    message: error.message,
    status: error.status,
    competition: "premier-league",
  };
}

export function unsupportedPremierLeagueTitleRefusal(): ProductionRefusal {
  return {
    code: "UNSUPPORTED_PRODUCTION_QUESTION",
    message:
      "Premier League title probabilities are not a frozen production artifact. The production product serves per-match LIVE_OOS forecasts only. Remaining-fixture Monte Carlo from live or historical-tape ratings is not production truth.",
    status: 409,
    competition: "premier-league",
  };
}

export function unsupportedPremierLeagueScenarioRefusal(): ProductionRefusal {
  return {
    code: "UNSUPPORTED_PRODUCTION_QUESTION",
    message:
      "Player or tactical what-if requests cannot alter production probabilities. Use the Match Room scenario boundary, which fails closed without inventing a new forecast.",
    status: 409,
    competition: "premier-league",
  };
}

export function refusedPremierLeagueResponse(input: {
  query: string;
  intent: AgentIntent;
  refusal: ProductionRefusal;
  createdAt: Date;
  language: LangCode;
}): AgentResponse {
  return {
    intent: input.intent,
    query: input.query,
    reasoningSteps: [
      step(
        "plan",
        "Identify Premier League production question",
        "Premier League production answers must use a frozen LIVE_OOS snapshot."
      ),
      step("refuse", "Fail closed", input.refusal.message),
    ],
    explanation: input.refusal.message,
    fanInsight: "No production probability is available for this request.",
    llmEnhanced: false,
    persisted: "none",
    createdAt: input.createdAt.toISOString(),
    language: input.language,
    productionRefusal: input.refusal,
  };
}

export function predictionFromFrozenForecast(forecast: MatchForecast): PredictionResult {
  const homeWin = forecast.result.homeWin;
  const awayWin = forecast.result.awayWin;
  const close = Math.abs(homeWin - awayWin) < 0.05;
  const top = forecast.topScores[0];
  const topProb = Math.max(homeWin, forecast.result.draw, awayWin);
  const confidenceScore = Math.round(topProb * 100);
  const confidenceLevel =
    confidenceScore >= 62
      ? "Very High"
      : confidenceScore >= 50
        ? "High"
        : confidenceScore >= 40
          ? "Moderate"
          : "Low";
  const home = clubRef(forecast.home.slug, frozenElo(forecast, "home"));
  const away = clubRef(forecast.away.slug, frozenElo(forecast, "away"));
  return {
    teamA: home,
    teamB: away,
    teamAWin: homeWin,
    draw: forecast.result.draw,
    teamBWin: awayWin,
    confidenceLevel,
    confidenceScore,
    mostLikelyScore: top ? `${top.homeGoals}–${top.awayGoals}` : "–",
    upsetProbability: Math.min(homeWin, awayWin),
    expectedScore: `${forecast.expectedGoals.home.toFixed(1)} – ${forecast.expectedGoals.away.toFixed(1)}`,
    favorite: close ? "Too close to call" : homeWin >= awayWin ? home.name : away.name,
    keyFactors: [
      {
        label: "Frozen production forecast",
        detail: `${forecast.provenance.immutableForecastId} · cutoff ${forecast.cutoffAt} · ${forecast.modelVersion}`,
        weight: "high",
      },
      {
        label: "Expected goals",
        detail: `${home.name} ${forecast.expectedGoals.home.toFixed(2)} · ${away.name} ${forecast.expectedGoals.away.toFixed(2)}`,
        weight: "medium",
      },
    ],
  };
}

export function simulationFromFrozenForecast(forecast: MatchForecast): SimulationResult {
  const top = forecast.topScores[0];
  const mostLikelyScore = top ? `${top.homeGoals}-${top.awayGoals}` : "0-0";
  return {
    simulationsRun: 0,
    teamAWin: forecast.result.homeWin,
    draw: forecast.result.draw,
    teamBWin: forecast.result.awayWin,
    mostLikelyScore,
    topScorelines: forecast.topScores.slice(0, 6).map((score) => ({
      score: `${score.homeGoals}-${score.awayGoals}`,
      share: score.probability,
    })),
    upsetProbability: Math.min(forecast.result.homeWin, forecast.result.awayWin),
    avgGoalsA: forecast.expectedGoals.home,
    avgGoalsB: forecast.expectedGoals.away,
    summary: `Derived from frozen production score matrix ${forecast.provenance.immutableForecastId}; not a live re-simulation.`,
  };
}

export function explanationFromFrozenForecast(forecast: MatchForecast, result: PredictionResult): string {
  return (
    `Frozen production forecast ${forecast.provenance.immutableForecastId}.\n` +
    `${result.teamA.name} (home) vs ${result.teamB.name} (away) — official fixture ${forecast.matchId}, kickoff ${forecast.kickoffUtc}.\n` +
    `Home ${(result.teamAWin * 100).toFixed(1)}% · Draw ${(result.draw * 100).toFixed(1)}% · Away ${(result.teamBWin * 100).toFixed(1)}%\n` +
    `Goal expectation ${result.expectedScore}. Most likely score ${result.mostLikelyScore}.\n` +
    `Model ${forecast.modelVersion} · cutoff ${forecast.cutoffAt} · evaluation class LIVE_OOS.\n` +
    `These numbers are copied from the immutable production snapshot. They are not a live recompute.`
  );
}

export async function loadFrozenPremierLeagueForecast(
  slugA: string,
  slugB: string,
  now = new Date()
): Promise<MatchForecast> {
  const fixture = resolvePremierLeagueFixtureByClubs(slugA, slugB, now);
  return latestMatchForecast(fixture.id, now);
}
