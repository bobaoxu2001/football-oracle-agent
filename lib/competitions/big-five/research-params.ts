/**
 * Big Five research-forecast parameters.
 *
 * These are a labeled domestic-league PRIOR, not a fit. They are not the
 * Premier League production coefficients (HA=72, ρ=−0.061 on pl-live-v0.2.0)
 * and not the World Cup host-nation constants. Do not present them as
 * league-specific calibrated laws of La Liga, Bundesliga, Serie A, or Ligue 1.
 *
 * Numeric prior rationale (same starting point documented for a domestic
 * league in lib/prediction-engine/model-params.ts):
 *   • HA = 65 Elo — conservative true-home-away bonus, below the WC host +75
 *   • ρ = −0.10 — milder low-score correction than the WC −0.13
 *   • K = 20 — club-match learning rate used by the PL baseline prior
 *   • mean Elo = 1500 — no feeder league, no previous-season tape
 *
 * Changing these numbers is a model-version change. Walking forward ratings
 * after a newly observed result is a state update, not a new version.
 */

import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import type { BigFiveCompetitionId } from "@/lib/competitions/types";

export const BIG_FIVE_RESEARCH_MODEL_VERSION = "big-five-research-v0.1.0" as const;

export const RESEARCH_FORECAST_COMPETITION_IDS = [
  "la-liga",
  "bundesliga",
  "serie-a",
  "ligue-1",
] as const;

export type ResearchForecastCompetitionId =
  (typeof RESEARCH_FORECAST_COMPETITION_IDS)[number];

export function isResearchForecastCompetitionId(
  value: string
): value is ResearchForecastCompetitionId {
  return (RESEARCH_FORECAST_COMPETITION_IDS as readonly string[]).includes(value);
}

export const RESEARCH_MODEL_ROLE = "research" as const;

export interface BigFiveResearchParams {
  modelVersion: typeof BIG_FIVE_RESEARCH_MODEL_VERSION;
  modelRole: typeof RESEARCH_MODEL_ROLE;
  includedInProduction: false;
  homeAdvantage: number;
  dcRho: number;
  drawBias: number;
  goalScale: number;
  baseGoals: number;
  awayHomeShare: number;
  kFactor: number;
  meanElo: number;
  paramsOrigin: "labeled-domestic-prior";
  fittedAt: null;
  trainingWindow: null;
  notes: string;
}

export const BIG_FIVE_RESEARCH_PARAMS: BigFiveResearchParams = {
  modelVersion: BIG_FIVE_RESEARCH_MODEL_VERSION,
  modelRole: RESEARCH_MODEL_ROLE,
  includedInProduction: false,
  homeAdvantage: 65,
  dcRho: -0.1,
  drawBias: 1,
  goalScale: 350,
  baseGoals: 1.35,
  awayHomeShare: 0,
  kFactor: 20,
  meanElo: 1500,
  paramsOrigin: "labeled-domestic-prior",
  fittedAt: null,
  trainingWindow: null,
  notes:
    "Labeled domestic-league prior. Not fitted on La Liga, Bundesliga, Serie A, or Ligue 1. Not the Premier League production parameters. Not an immutable LIVE_OOS snapshot.",
};

export const RESEARCH_FORECAST_DISCLAIMER =
  "Research 1X2 from walk-forward Elo + Dixon-Coles on the canonical match ledger. Parameters are an unfitted domestic prior. This is not a Premier League production forecast, not a frozen LIVE_OOS snapshot, and not betting advice.";

/** Named so callers can assert inequality; never used as this layer's modelVersion. */
export const RESEARCH_NOT_PRODUCTION_MODEL_VERSION = PRODUCTION_MODEL_VERSION;

export function assertResearchForecastCompetition(
  competition: string
): ResearchForecastCompetitionId {
  if (competition === "premier-league") {
    throw new ResearchForecastError(
      `Premier League forecasts are production artifacts of ${PRODUCTION_MODEL_VERSION}. The Big Five research engine refuses to mint a parallel Premier League number.`,
      "PRODUCTION_ISOLATION",
      409
    );
  }
  if (!isResearchForecastCompetitionId(competition)) {
    throw new ResearchForecastError(
      `No research forecast competition named ${competition}.`,
      "UNKNOWN_COMPETITION",
      400
    );
  }
  return competition;
}

export function isPremierLeagueCompetition(id: BigFiveCompetitionId): boolean {
  return id === "premier-league";
}

export class ResearchForecastError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PRODUCTION_ISOLATION"
      | "UNKNOWN_COMPETITION"
      | "NOT_FORECASTABLE"
      | "UNKNOWN_MATCH"
      | "INVALID_CUTOFF",
    public readonly status: number
  ) {
    super(message);
    this.name = "ResearchForecastError";
  }
}
