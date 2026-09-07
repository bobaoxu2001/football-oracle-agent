import type { CompetitionId } from "@/lib/competitions/types";
import fittedPremierLeagueParams from "@/data/processed/premier-league/model-params.json";

/**
 * League-scoped (or tournament-scoped) fitted parameters.
 * Do not share World Cup ρ / host bonus with Premier League.
 */
export interface ModelParams {
  competition: CompetitionId;
  modelVersion: string;
  homeAdvantage: number;
  dcRho: number;
  /** Extra log-draw shrink after DC (1 = off). Phase 1 PL uses 1 unless fit justifies. */
  drawBias: number;
  goalScale: number;
  baseGoals: number;
  /** See elo.ts GoalModelOptions.awayHomeShare */
  awayHomeShare: number;
  kFactor: number;
  fittedAt: string;
  trainingWindow: { from: string; to: string };
  notes: string;
}

/** World Cup live stack — historic constants, not re-fit in Phase 1. */
export const WORLD_CUP_MODEL_PARAMS: ModelParams = {
  competition: "world-cup",
  modelVersion: "wc-live-v1.0.0",
  homeAdvantage: 75,
  dcRho: -0.13,
  drawBias: 1,
  goalScale: 350,
  baseGoals: 1.35,
  awayHomeShare: 0.5,
  kFactor: 60,
  fittedAt: "2026-05-01",
  trainingWindow: { from: "2023-10-01", to: "2026-05-31" },
  notes:
    "Inherited World Cup constants. Host-nation bonus, not true home/away. ρ is the historic international default, not a PL value.",
};

/**
 * Premier League Phase 1 baseline.
 *
 * homeAdvantage and dcRho are LABELED PRIORS until scripts/fit-pl-params.ts
 * overwrites them from the training window (2018-19 … 2024-25). The held-out
 * season is never used to pick these numbers.
 *
 * Prior rationale (not fake precision):
 *   • Home advantage ~65 Elo is a conservative domestic-league starting
 *     point (well below the WC host-nation +75).
 *   • ρ = −0.10 shrinks the WC −0.13 toward zero: Premier League has a
 *     higher scoring rate than internationals, so the low-score correction
 *     should be milder. The fit script may move this.
 */
export const PREMIER_LEAGUE_MODEL_PARAMS: ModelParams = {
  competition: "premier-league",
  modelVersion: "pl-baseline-v0.1.0",
  homeAdvantage: 65,
  dcRho: -0.1,
  drawBias: 1,
  goalScale: 350,
  baseGoals: 1.35,
  awayHomeShare: 0,
  kFactor: 20,
  fittedAt: "prior",
  trainingWindow: { from: "2018-08-01", to: "2025-05-31" },
  notes:
    "Phase 1 labeled prior. Fit on 2018-19–2024-25 only (see data/processed/premier-league/model-params.json if present). Held-out 2025-26 is never used to pick ρ or HA.",
};

export function paramsFor(competition: CompetitionId): ModelParams {
  if (competition === "premier-league") return loadPremierLeagueParams();
  if (competition === "world-cup") return WORLD_CUP_MODEL_PARAMS;
  throw new Error(
    `${competition} has no production model parameters. Research forecasts use lib/competitions/big-five/research-params.ts and are not production.`
  );
}

/** On-disk file is the source of truth once the fit script has run. */
export function loadPremierLeagueParams(): ModelParams {
  const fitted = fittedPremierLeagueParams as ModelParams;
  if (fitted?.modelVersion && typeof fitted.dcRho === "number") return fitted;
  return PREMIER_LEAGUE_MODEL_PARAMS;
}
