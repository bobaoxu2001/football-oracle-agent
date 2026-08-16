import type { CompetitionId } from "@/lib/competitions/types";

/**
 * Stable prediction-stage enum.
 *
 * Phase 2A stages identify time-to-kickoff, not lineup confirmation.
 * `T60M` does NOT mean the starting XI is known.
 *
 * Legacy Phase 1 strings are still accepted and canonicalized.
 */
export const PREDICTION_STAGES = [
  "HISTORICAL",
  "PRESEASON",
  "EARLY",
  "T24H",
  "T2H",
  "T60M",
  "FINAL_PREKICK",
  "RETROSPECTIVE",
] as const;

export type PredictionStage = (typeof PREDICTION_STAGES)[number] | LegacyPredictionStage;

export type LegacyPredictionStage = "historical-as-of" | "preseason-baseline" | "as-of-kickoff";

export type CanonicalPredictionStage = (typeof PREDICTION_STAGES)[number];

export type EvaluationClass = "BACKTEST" | "RETROSPECTIVE" | "LIVE_OOS";

const LEGACY_STAGE: Record<string, CanonicalPredictionStage> = {
  "historical-as-of": "HISTORICAL",
  "preseason-baseline": "PRESEASON",
  "as-of-kickoff": "FINAL_PREKICK",
  HISTORICAL: "HISTORICAL",
  PRESEASON: "PRESEASON",
  EARLY: "EARLY",
  T24H: "T24H",
  T2H: "T2H",
  T60M: "T60M",
  FINAL_PREKICK: "FINAL_PREKICK",
  RETROSPECTIVE: "RETROSPECTIVE",
};

export function canonicalizePredictionStage(stage?: string | null): CanonicalPredictionStage {
  if (!stage) return "HISTORICAL";
  return LEGACY_STAGE[stage] ?? "HISTORICAL";
}

export interface SnapshotKey {
  competition: CompetitionId;
  season: string;
  fixtureId: string;
  modelVersion: string;
  /** Optional for Phase 1 lookups; defaults to HISTORICAL. */
  predictionStage?: PredictionStage;
  asOf: string;
}

export interface PredictionSnapshot {
  competition: CompetitionId;
  season: string;
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeSlug: string;
  awaySlug: string;
  kickoff: string | null;
  createdAt: string;
  asOf: string;
  dataCutoff: string;
  modelVersion: string;
  predictionStage: PredictionStage;
  evaluationClass?: EvaluationClass;
  homeProbability: number;
  drawProbability: number;
  awayProbability: number;
  homeGoalExpectation: number;
  awayGoalExpectation: number;
  scorelineDistribution: Record<string, number>;
  modelParameters: Record<string, unknown>;
  sourceState: Record<string, unknown>;
  provenance: {
    store: "file" | "mongodb" | "memory";
    uniqueKey: string;
    notes: string;
  };
  /** Reserved: market snapshot can be attached later without a redesign. */
  market?: {
    capturedAt: string;
    home?: number;
    draw?: number;
    away?: number;
    source?: string;
  } | null;
  /** Back-compat aliases used by the Phase 1 card. */
  home: number;
  draw: number;
  away: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
}

export interface CreateSnapshotInput {
  fixtureId: string;
  competition: CompetitionId;
  season: string;
  asOf: string;
  kickoff?: string | null;
  modelVersion: string;
  predictionStage?: PredictionStage;
  evaluationClass?: EvaluationClass;
  homeSlug: string;
  awaySlug: string;
  homeTeam?: string;
  awayTeam?: string;
  home: number;
  draw: number;
  away: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  scorelineDistribution: Record<string, number>;
  modelParameters?: Record<string, unknown>;
  sourceState?: Record<string, unknown>;
  provenanceNotes?: string;
}

/** Current identity: includes predictionStage. */
export function snapshotUniqueKey(k: SnapshotKey): string {
  const stage = canonicalizePredictionStage(k.predictionStage);
  return [k.competition, k.season, k.fixtureId, k.modelVersion, stage, k.asOf].join("::");
}

/** Phase 1.1 key (no stage). Used only to resolve pre-2A snapshots. */
export function legacySnapshotUniqueKey(k: Omit<SnapshotKey, "predictionStage">): string {
  return [k.competition, k.season, k.fixtureId, k.modelVersion, k.asOf].join("::");
}
