/**
 * Phase 2A.2 live-operations types.
 *
 * Prediction snapshots stay immutable. Settlement, jobs, results, and
 * rating events are separate records.
 */

import type { FixtureStatus, KickoffCertainty, VerificationStatus } from "@/lib/identity/types";
import type { CanonicalPredictionStage } from "@/lib/snapshots/types";

export const TIMED_STAGES = ["T24H", "T2H", "T60M", "FINAL_PREKICK"] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];

export const JOB_STATUSES = [
  "PENDING",
  "ELIGIBLE",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "MISSED",
  "CANCELLED",
  "BLOCKED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const RESULT_VERIFICATION = ["UNVERIFIED", "PROVISIONAL", "VERIFIED_FINAL", "CONFLICT"] as const;
export type ResultVerificationStatus = (typeof RESULT_VERIFICATION)[number];

export const MATCH_STATUSES = [
  "SCHEDULED",
  "LIVE",
  "FINISHED",
  "POSTPONED",
  "SUSPENDED",
  "ABANDONED",
  "CANCELLED",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const HEALTH_STATES = ["HEALTHY", "DEGRADED", "BLOCKED"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const SNAPSHOT_ORIGINS = ["scheduled", "manual", "committed-tape"] as const;
export type SnapshotOrigin = (typeof SNAPSHOT_ORIGINS)[number];

export type FailureClass =
  | "temporary-network"
  | "source-unavailable"
  | "invalid-source-response"
  | "data-conflict"
  | "permanent-validation"
  | "store-failure"
  | "unknown";

export interface StageWindow {
  stage: TimedStage;
  /** Offset from kickoff to the canonical asOf / target, milliseconds (negative = before). */
  targetOffsetMs: number;
  eligibleFromOffsetMs: number;
  eligibleUntilOffsetMs: number;
  /** Human description. FINAL_PREKICK is not a lineup confirmation. */
  meaning: string;
}

export interface PredictionJob {
  jobId: string;
  fixtureId: string;
  season: string;
  stage: TimedStage;
  modelVersion: string;
  kickoffUtc: string;
  scheduledFor: string;
  eligibleFrom: string;
  eligibleUntil: string;
  plannedAsOf: string;
  origin: "scheduled";
  status: JobStatus;
  snapshotKey: string | null;
  attemptedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  failureClass: FailureClass | null;
  retryCount: number;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceObservation {
  observationId: string;
  kind: "fixture" | "result";
  source: string;
  sourceFixtureId: string | null;
  fixtureId: string | null;
  retrievedAt: string;
  sourceUpdatedAt: string | null;
  raw: unknown;
  normalized: NormalizedSourceFixture;
  verificationStatus: VerificationStatus | ResultVerificationStatus;
}

export interface NormalizedSourceFixture {
  homeSlug: string | null;
  awaySlug: string | null;
  kickoffUtc: string | null;
  kickoffLocal: string | null;
  scheduledDate: string | null;
  kickoffCertainty: KickoffCertainty | null;
  status: MatchStatus;
  homeGoals: number | null;
  awayGoals: number | null;
  sourceUpdatedAt: string | null;
}

export interface FixtureScheduleRevision {
  revisionId: string;
  fixtureId: string;
  changedAt: string;
  oldKickoff: string | null;
  newKickoff: string | null;
  oldCertainty: KickoffCertainty | null | undefined;
  newCertainty: KickoffCertainty | null | undefined;
  oldStatus: FixtureStatus | string;
  newStatus: FixtureStatus | string;
  source: string;
  reason: string;
  evidence?: string;
}

export interface ResultObservation {
  observationId: string;
  fixtureId: string;
  source: string;
  sourceFixtureId: string | null;
  retrievedAt: string;
  matchStatus: MatchStatus;
  homeGoals: number | null;
  awayGoals: number | null;
  resultTimestamp: string | null;
  raw: unknown;
}

export interface ResultVerification {
  fixtureId: string;
  status: ResultVerificationStatus;
  matchStatus: MatchStatus;
  homeGoals: number | null;
  awayGoals: number | null;
  sources: string[];
  verifiedAt: string | null;
  conflictReason: string | null;
  updatedAt: string;
}

export interface RatingAppliedEvent {
  eventId: string;
  fixtureId: string;
  season: string;
  kickoffUtc: string;
  homeSlug: string;
  awaySlug: string;
  homeGoals: number;
  awayGoals: number;
  preHome: number;
  preAway: number;
  postHome: number;
  postAway: number;
  formulaVersion: string;
  modelVersion: string;
  appliedAt: string;
}

export interface SettlementCorrection {
  correctionId: string;
  snapshotUniqueKey: string;
  fixtureId: string;
  recordedAt: string;
  reason: string;
  previousScore: { home: number; away: number };
  reportedScore: { home: number; away: number };
  ratingsTouched: false;
}

export interface DataConflict {
  kind: "fixture-kickoff" | "result-score";
  fixtureId: string;
  sources: string[];
  detail: string;
  recordedAt: string;
}

export interface LiveOpsTickState {
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastFixtureSyncAt: string | null;
  lastFixtureSyncOkAt: string | null;
  lastResultSyncAt: string | null;
  lastResultSyncOkAt: string | null;
  lastVerifiedResultAt: string | null;
  lastVerifiedFixtureId: string | null;
  ticks: number;
  /** Last tick that actually minted a new shadow snapshot. Additive; older state omits it. */
  lastShadowFreezeAt?: string | null;
  /** Last error from the shadow freeze pass (cleared on a clean freeze pass). */
  lastShadowError?: string | null;
  /** How many shadow snapshots that successful freeze pass minted. */
  lastShadowFrozen?: number;
}

export type { CanonicalPredictionStage };
