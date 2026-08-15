import type { CompetitionId } from "@/lib/competitions/types";

/** How the snapshot was produced. Not a live kickoff unless a real fixture exists. */
export type PredictionStage =
  | "historical-as-of"
  | "preseason-baseline"
  | "as-of-kickoff";

export interface SnapshotKey {
  competition: CompetitionId;
  season: string;
  fixtureId: string;
  modelVersion: string;
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

export function snapshotUniqueKey(k: SnapshotKey): string {
  return [k.competition, k.season, k.fixtureId, k.modelVersion, k.asOf].join("::");
}
