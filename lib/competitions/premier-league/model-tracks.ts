/**
 * Explicit Premier League model tracks.
 *
 * Benchmark and production are intentionally not identical.
 * Do not silently unify them.
 *
 *   Model version  = prediction logic + fitted structural parameters.
 *   Model state    = time-varying team ratings after known results.
 *
 * A verified match result updates model state. It does not mint a new
 * model version. Changing the algorithm, HA/ρ, or season-init rule does.
 */

import type { ModelParams } from "@/lib/prediction-engine/model-params";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import productionParams from "@/data/processed/premier-league/production-params.json";

export type ModelTrackId = "benchmark" | "production";

export interface ModelTrack {
  id: ModelTrackId;
  modelVersion: string;
  /** Championship Elo feeder for newly promoted clubs. */
  useChampionshipFeeder: boolean;
  /** Apply explicit offseason shrink / promotion prior. */
  applyOffseasonInit: boolean;
  seasonInitVersion: string;
  /** Why this track exists and which features it may use. */
  features: {
    walkForwardElo: true;
    trueHomeAdvantage: true;
    dixonColes: true;
    championshipFeeder: boolean;
    officialCurrentSeasonMembership: boolean;
    liveMarketOdds: false;
    injuries: false;
    lineups: false;
    shotBasedXg: false;
  };
  rationale: string;
}

export const BENCHMARK_MODEL_VERSION = "pl-baseline-v0.1.0";
export const PRODUCTION_MODEL_VERSION = "pl-live-v0.2.0";
export const SEASON_INIT_VERSION = "pl-season-init-v0.2.0";

export const BENCHMARK_TRACK: ModelTrack = {
  id: "benchmark",
  modelVersion: BENCHMARK_MODEL_VERSION,
  useChampionshipFeeder: false,
  applyOffseasonInit: true,
  seasonInitVersion: "pl-season-init-placeholder-v0.1.0",
  features: {
    walkForwardElo: true,
    trueHomeAdvantage: true,
    dixonColes: true,
    championshipFeeder: false,
    officialCurrentSeasonMembership: false,
    liveMarketOdds: false,
    injuries: false,
    lineups: false,
    shotBasedXg: false,
  },
  rationale:
    "Frozen Phase 1 held-out path. Feeder OFF so the 380-match 2025-26 benchmark stays reproducible. HA/ρ were fit on 2018-19–2024-25 only.",
};

export const PRODUCTION_TRACK: ModelTrack = {
  id: "production",
  modelVersion: PRODUCTION_MODEL_VERSION,
  useChampionshipFeeder: true,
  applyOffseasonInit: true,
  seasonInitVersion: SEASON_INIT_VERSION,
  features: {
    walkForwardElo: true,
    trueHomeAdvantage: true,
    dixonColes: true,
    championshipFeeder: true,
    officialCurrentSeasonMembership: true,
    liveMarketOdds: false,
    injuries: false,
    lineups: false,
    shotBasedXg: false,
  },
  rationale:
    "Live 2026-27 path. Uses official membership, Championship-informed promoted priors, and explicit offseason regression. HA/ρ are the same training-window estimates as the benchmark (not recalibrated). A new version exists because the production stack is a different prediction path, not because HA/ρ moved.",
};

export function trackById(id: ModelTrackId): ModelTrack {
  return id === "benchmark" ? BENCHMARK_TRACK : PRODUCTION_TRACK;
}

/** Benchmark params — source of truth for the frozen held-out file. */
export function loadBenchmarkParams(): ModelParams {
  return loadPremierLeagueParams();
}

/** Production params. Same HA/ρ; different version + season-init metadata. */
export function loadProductionParams(): ModelParams {
  const fitted = productionParams as ModelParams;
  if (fitted?.modelVersion && typeof fitted.dcRho === "number") return fitted;
  const bench = loadBenchmarkParams();
  return { ...bench, modelVersion: PRODUCTION_MODEL_VERSION };
}

export function paramsForTrack(id: ModelTrackId): ModelParams {
  return id === "benchmark" ? loadBenchmarkParams() : loadProductionParams();
}
