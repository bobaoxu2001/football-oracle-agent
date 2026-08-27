import type { CompetitionId } from "@/lib/competitions/types";
import type {
  ForecastInputManifest,
  ManifestReferenceSet,
} from "@/lib/competitions/premier-league/provenance/types";
import {
  assertForecastInputManifestIntegrity,
  assertForecastInputManifestReferences,
} from "@/lib/competitions/premier-league/provenance/manifest";

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
  "T7D",
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
  T7D: "T7D",
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
  /**
   * Prospective Phase 4A.3 lineage. Older immutable rows intentionally omit
   * these fields and remain LEGACY_UNAVAILABLE on read.
   *
   * The complete compact manifest and its small frozen semantic records are
   * embedded with the forecast so no replica can expose probabilities while
   * losing the evidence needed to reconstruct them. The content-addressed
   * provenance tape remains the canonical cross-forecast registry.
   */
  inputManifestId?: string;
  inputManifest?: ForecastInputManifest;
  inputManifestRecords?: ManifestReferenceSet;
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

/**
 * Canonical generation timestamp for an immutable snapshot.
 *
 * Scheduled snapshots prospectively record the actual computation time in
 * `sourceState.computedAt`; other origins use the store creation timestamp.
 * Treating an arbitrary `computedAt` as authoritative would let a manual or
 * reconstructed row rewrite its apparent temporal provenance.
 */
export function effectiveSnapshotGeneratedAt(
  snapshot: Pick<PredictionSnapshot, "createdAt" | "sourceState">
): string {
  const computedAt = snapshot.sourceState?.computedAt;
  const origin = snapshot.sourceState?.origin;
  return origin === "scheduled" && typeof computedAt === "string"
    ? computedAt
    : snapshot.createdAt;
}

export const SNAPSHOT_MODEL_INPUT_TIMESTAMP_FIELDS = [
  "latestRatingEventAppliedAt",
  "fixtureRetrievedAt",
  "latestEvidenceObservedAt",
] as const;

/**
 * Latest prospectively recorded model-input availability timestamp without
 * sanitising bad evidence away. Policy cutoffs (`ratingStateAsOf`) and event
 * times (`latestEvidenceKickoff`) are intentionally excluded: neither proves
 * when the input became available. An invalid recorded value is returned
 * verbatim so the shared temporal validator can fail closed instead of
 * relabelling it unavailable.
 */
export function effectiveSnapshotLatestIncludedInputAt(
  snapshot: Pick<PredictionSnapshot, "sourceState"> &
    Partial<
      Pick<
        PredictionSnapshot,
        | "fixtureId"
        | "season"
        | "modelVersion"
        | "predictionStage"
        | "asOf"
        | "dataCutoff"
        | "kickoff"
        | "inputManifestId"
        | "inputManifest"
        | "inputManifestRecords"
      >
    >
): string | null {
  if (snapshot.inputManifest) {
    const manifest = snapshot.inputManifest;
    try {
      if (!snapshot.inputManifestRecords) {
        throw new Error("missing immutable manifest references");
      }
      assertForecastInputManifestIntegrity(manifest);
      assertForecastInputManifestReferences(manifest, snapshot.inputManifestRecords);
      if (
        snapshot.inputManifestId !== manifest.manifestId ||
        manifest.fixtureId !== snapshot.fixtureId ||
        manifest.season !== snapshot.season ||
        manifest.modelVersion !== snapshot.modelVersion ||
        manifest.forecastStage !==
          canonicalizePredictionStage(snapshot.predictionStage) ||
        manifest.cutoffAt !== snapshot.asOf ||
        snapshot.dataCutoff !== snapshot.asOf ||
        manifest.kickoffAtAsKnown !== snapshot.kickoff ||
        manifest.generatedAt !== snapshot.sourceState?.computedAt
      ) {
        throw new Error("manifest does not bind to the immutable snapshot");
      }
    } catch {
      // A present but corrupt/mismatched manifest must make the snapshot
      // temporally invalid. Falling back to legacy timestamps could allow it
      // to displace a valid production forecast.
      return "invalid:input-manifest";
    }
    const recorded = manifest.latestIncludedInputAt;
    if (typeof recorded !== "string") return "invalid:manifest.latestIncludedInputAt";
    return recorded;
  }
  if (snapshot.inputManifestId || snapshot.inputManifestRecords) {
    return "invalid:input-manifest";
  }
  let latest: { value: string; time: number } | null = null;
  for (const field of SNAPSHOT_MODEL_INPUT_TIMESTAMP_FIELDS) {
    const recorded = snapshot.sourceState?.[field];
    if (recorded === null || recorded === undefined) continue;
    if (typeof recorded !== "string") return `invalid:${field}`;
    const time = Date.parse(recorded);
    if (!Number.isFinite(time)) return recorded;
    if (!latest || time > latest.time) latest = { value: recorded, time };
  }
  return latest?.value ?? null;
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
  inputManifestId?: string;
  inputManifest?: ForecastInputManifest;
  inputManifestRecords?: ManifestReferenceSet;
}

/** Current identity: includes predictionStage. */
export function snapshotUniqueKey(k: SnapshotKey): string {
  const stage = canonicalizePredictionStage(k.predictionStage);
  return [k.competition, k.season, k.fixtureId, k.modelVersion, stage, k.asOf].join("::");
}

/**
 * Inverse of snapshotUniqueKey (and the legacy 5-part form).
 * asOf is ISO-8601 and contains no `::`, so a split is unambiguous.
 */
export function parseSnapshotUniqueKey(key: string): {
  competition: string;
  season: string;
  fixtureId: string;
  modelVersion: string;
  predictionStage: CanonicalPredictionStage | null;
  asOf: string;
} | null {
  const parts = key.split("::");
  if (parts.length < 5) return null;
  if (parts.length === 5) {
    return {
      competition: parts[0],
      season: parts[1],
      fixtureId: parts[2],
      modelVersion: parts[3],
      predictionStage: null,
      asOf: parts[4],
    };
  }
  return {
    competition: parts[0],
    season: parts[1],
    fixtureId: parts[2],
    modelVersion: parts[3],
    predictionStage: canonicalizePredictionStage(parts[4]),
    asOf: parts.slice(5).join("::"),
  };
}

/** Shared canonical identity. Same as snapshotUniqueKey. */
export function canonicalSnapshotIdentity(k: SnapshotKey): string {
  return snapshotUniqueKey(k);
}

/** Phase 1.1 key (no stage). Used only to resolve pre-2A snapshots. */
export function legacySnapshotUniqueKey(k: Omit<SnapshotKey, "predictionStage">): string {
  return [k.competition, k.season, k.fixtureId, k.modelVersion, k.asOf].join("::");
}
