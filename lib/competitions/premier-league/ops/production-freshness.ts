/**
 * Canonical, side-effect-free production freshness policy.
 *
 * Freshness is defined by deterministic forecast stages, not by an arbitrary
 * age threshold. Callers must inject snapshots and observer timestamps; this
 * module never reads a store, the clock, environment variables, or market data.
 */

import {
  canonicalizePredictionStage,
  type CanonicalPredictionStage,
  type EvaluationClass,
} from "@/lib/snapshots/types";
import { STAGE_WINDOWS } from "./stage-windows";
import { TIMED_STAGES, type JobStatus, type TimedStage } from "./types";

const HOUR_MS = 3_600_000;

export const PRODUCTION_FRESHNESS_POLICY_VERSION =
  "pl-production-freshness-v1" as const;
export const SCHEDULER_STALE_AFTER_MS = 15 * 60_000;
export const FIXTURE_SYNC_STALE_NEAR_MATCH_MS = 6 * HOUR_MS;
export const FIXTURE_SYNC_STALE_DEFAULT_MS = 36 * HOUR_MS;

export const BASELINE_FORECAST_STAGES = ["PRESEASON", "EARLY"] as const;
export type BaselineForecastStage = (typeof BASELINE_FORECAST_STAGES)[number];
export type ProductionFreshnessStage = BaselineForecastStage | TimedStage;

export type ForecastSnapshotRole =
  | "production"
  | "shadow"
  | "reconstruction";

export interface ForecastFreshnessSnapshotInput {
  snapshotId: string;
  fixtureId: string;
  modelRole: ForecastSnapshotRole;
  modelVersion: string;
  evaluationClass: EvaluationClass | null;
  predictionStage: string;
  /** Kickoff frozen into this immutable snapshot. */
  kickoffUtc: string | null;
  /** Maximum admissible information timestamp. */
  cutoffAt: string;
  /** Timestamp at which the immutable forecast was created. */
  generatedAt: string;
  /** Actual maximum included input timestamp, if prospectively recorded. */
  latestIncludedInputAt?: string | null;
}

export interface ForecastFreshnessJobInput {
  fixtureId: string;
  modelVersion: string;
  stage: TimedStage;
  kickoffUtc: string;
  status: JobStatus;
}

export interface FixtureForecastFreshnessInput {
  fixtureId: string;
  kickoffUtc: string;
  evaluatedAt: string;
  expectedModelVersion: string;
  snapshots: readonly ForecastFreshnessSnapshotInput[];
  jobs?: readonly ForecastFreshnessJobInput[];
}

export type FixtureForecastFreshnessStatus =
  | "CURRENT_BASELINE"
  | "CURRENT_STAGE"
  | "UPDATE_DUE"
  | "MISSED_STAGE"
  | "BLOCKED"
  | "UNAVAILABLE"
  | "INVALID";

export type TimedStagePolicyState =
  | "FUTURE"
  | "DUE"
  | "SATISFIED"
  | "MISSED"
  | "BLOCKED";

export type SnapshotFreshnessIssueCode =
  | "SNAPSHOT_ID_MISSING"
  | "SNAPSHOT_KICKOFF_INVALID"
  | "SNAPSHOT_KICKOFF_MISMATCH"
  | "SNAPSHOT_EVALUATED_AT_INVALID"
  | "SNAPSHOT_STAGE_INVALID"
  | "SNAPSHOT_CUTOFF_INVALID"
  | "SNAPSHOT_GENERATED_AT_INVALID"
  | "SNAPSHOT_CUTOFF_NOT_BEFORE_KICKOFF"
  | "SNAPSHOT_GENERATED_AT_NOT_BEFORE_KICKOFF"
  | "SNAPSHOT_CUTOFF_IN_FUTURE"
  | "SNAPSHOT_GENERATED_AT_IN_FUTURE"
  | "SNAPSHOT_GENERATED_BEFORE_CUTOFF"
  | "SNAPSHOT_STAGE_CUTOFF_MISMATCH"
  | "SNAPSHOT_GENERATED_OUTSIDE_STAGE_WINDOW"
  | "LATEST_INCLUDED_INPUT_AT_INVALID"
  | "LATEST_INCLUDED_INPUT_AFTER_CUTOFF";

export interface InvalidForecastFreshnessSnapshot {
  snapshotId: string;
  issues: SnapshotFreshnessIssueCode[];
}

export interface SelectedFreshnessSnapshot {
  snapshotId: string;
  stage: ProductionFreshnessStage;
  cutoffAt: string;
  generatedAt: string;
  /** Age of the information cutoff, not the generation timestamp. */
  cutoffAgeHours: number;
  /** Never inferred from cutoffAt. Missing prospective evidence stays null. */
  latestIncludedInputAt: string | null;
  latestIncludedInputStatus: "RECORDED" | "UNAVAILABLE";
}

export interface TimedStageFreshness {
  stage: TimedStage;
  state: TimedStagePolicyState;
  scheduledFor: string;
  eligibleFrom: string;
  eligibleUntil: string;
  snapshotId: string | null;
  jobStatus: JobStatus | null;
}

export type FixtureFreshnessReasonCode =
  | "BASELINE_CURRENT_BEFORE_FIRST_TIMED_STAGE"
  | "LATEST_REQUIRED_STAGE_SATISFIED"
  | "ACTIVE_STAGE_MISSING"
  | "ACTIVE_STAGE_BLOCKED"
  | "LATEST_REQUIRED_STAGE_MISSED"
  | "NO_VALID_PRODUCTION_SNAPSHOT"
  | "INVALID_FIXTURE_ID"
  | "INVALID_KICKOFF"
  | "INVALID_EVALUATED_AT"
  | "EVALUATED_AT_AFTER_KICKOFF"
  | "INVALID_CURRENT_PRODUCTION_SNAPSHOT";

export interface FixtureForecastFreshness {
  policyVersion: typeof PRODUCTION_FRESHNESS_POLICY_VERSION;
  fixtureId: string;
  kickoffUtc: string;
  evaluatedAt: string;
  expectedModelVersion: string;
  status: FixtureForecastFreshnessStatus;
  meetsStagePolicy: boolean;
  selectedStage: ProductionFreshnessStage | null;
  cutoffAt: string | null;
  generatedAt: string | null;
  /** Age of the selected snapshot's information cutoff. */
  cutoffAgeHours: number | null;
  /** Actual recorded input evidence only; never copied from cutoffAt. */
  latestIncludedInputAt: string | null;
  latestIncludedInputStatus: "RECORDED" | "UNAVAILABLE";
  latestRequiredStage: TimedStage | null;
  activeDueStage: TimedStage | null;
  nextStage: TimedStage | null;
  missedStages: TimedStage[];
  blockedStages: TimedStage[];
  selectedSnapshot: SelectedFreshnessSnapshot | null;
  stages: TimedStageFreshness[];
  invalidSnapshots: InvalidForecastFreshnessSnapshot[];
  ignoredSnapshots: {
    nonProductionRole: number;
    wrongEvaluationClass: number;
    wrongModelVersion: number;
    wrongFixture: number;
    obsoleteKickoff: number;
  };
  reasonCodes: FixtureFreshnessReasonCode[];
}

export interface ValidProductionForecastSnapshot {
  input: ForecastFreshnessSnapshotInput;
  stage: ProductionFreshnessStage;
  cutoffMs: number;
  generatedMs: number;
  latestIncludedInputAt: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function finiteTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isProductionFreshnessStage(
  stage: CanonicalPredictionStage
): stage is ProductionFreshnessStage {
  return (
    (BASELINE_FORECAST_STAGES as readonly string[]).includes(stage) ||
    (TIMED_STAGES as readonly string[]).includes(stage)
  );
}

function windowTimes(stage: TimedStage, kickoffMs: number) {
  const window = STAGE_WINDOWS[stage];
  return {
    scheduledForMs: kickoffMs + window.targetOffsetMs,
    eligibleFromMs: kickoffMs + window.eligibleFromOffsetMs,
    eligibleUntilMs: kickoffMs + window.eligibleUntilOffsetMs,
  };
}

function jobForStage(
  input: FixtureForecastFreshnessInput,
  stage: TimedStage,
  kickoffMs: number
): ForecastFreshnessJobInput | null {
  const matches = (input.jobs ?? []).filter((job) => {
    const jobKickoffMs = finiteTimestamp(job.kickoffUtc);
    return (
      job.fixtureId === input.fixtureId &&
      job.modelVersion === input.expectedModelVersion &&
      job.stage === stage &&
      jobKickoffMs === kickoffMs
    );
  });
  return matches.at(-1) ?? null;
}

function emptyStageRows(kickoffMs: number): TimedStageFreshness[] {
  if (!Number.isFinite(kickoffMs)) return [];
  return TIMED_STAGES.map((stage) => {
    const times = windowTimes(stage, kickoffMs);
    return {
      stage,
      state: "FUTURE" as const,
      scheduledFor: iso(times.scheduledForMs),
      eligibleFrom: iso(times.eligibleFromMs),
      eligibleUntil: iso(times.eligibleUntilMs),
      snapshotId: null,
      jobStatus: null,
    };
  });
}

function invalidFixtureResult(
  input: FixtureForecastFreshnessInput,
  kickoffMs: number,
  reasonCodes: FixtureFreshnessReasonCode[],
  invalidSnapshots: InvalidForecastFreshnessSnapshot[] = [],
  ignoredSnapshots: FixtureForecastFreshness["ignoredSnapshots"] = {
    nonProductionRole: 0,
    wrongEvaluationClass: 0,
    wrongModelVersion: 0,
    wrongFixture: 0,
    obsoleteKickoff: 0,
  }
): FixtureForecastFreshness {
  return {
    policyVersion: PRODUCTION_FRESHNESS_POLICY_VERSION,
    fixtureId: input.fixtureId,
    kickoffUtc: input.kickoffUtc,
    evaluatedAt: input.evaluatedAt,
    expectedModelVersion: input.expectedModelVersion,
    status: "INVALID",
    meetsStagePolicy: false,
    selectedStage: null,
    cutoffAt: null,
    generatedAt: null,
    cutoffAgeHours: null,
    latestIncludedInputAt: null,
    latestIncludedInputStatus: "UNAVAILABLE",
    latestRequiredStage: null,
    activeDueStage: null,
    nextStage: null,
    missedStages: [],
    blockedStages: [],
    selectedSnapshot: null,
    stages: emptyStageRows(kickoffMs),
    invalidSnapshots,
    ignoredSnapshots,
    reasonCodes,
  };
}

function validateCurrentSnapshot(
  snapshot: ForecastFreshnessSnapshotInput,
  kickoffMs: number,
  evaluatedAtMs: number
): { valid: ValidProductionForecastSnapshot | null; issues: SnapshotFreshnessIssueCode[] } {
  const issues: SnapshotFreshnessIssueCode[] = [];
  const canonicalStage = canonicalizePredictionStage(snapshot.predictionStage);
  const stage = isProductionFreshnessStage(canonicalStage)
    ? canonicalStage
    : null;
  const cutoffMs = finiteTimestamp(snapshot.cutoffAt);
  const generatedMs = finiteTimestamp(snapshot.generatedAt);

  if (!snapshot.snapshotId.trim()) issues.push("SNAPSHOT_ID_MISSING");
  if (!stage) issues.push("SNAPSHOT_STAGE_INVALID");
  if (cutoffMs === null) issues.push("SNAPSHOT_CUTOFF_INVALID");
  if (generatedMs === null) issues.push("SNAPSHOT_GENERATED_AT_INVALID");

  if (cutoffMs !== null) {
    if (cutoffMs >= kickoffMs) issues.push("SNAPSHOT_CUTOFF_NOT_BEFORE_KICKOFF");
    if (cutoffMs > evaluatedAtMs) issues.push("SNAPSHOT_CUTOFF_IN_FUTURE");
  }
  if (generatedMs !== null) {
    if (generatedMs >= kickoffMs) {
      issues.push("SNAPSHOT_GENERATED_AT_NOT_BEFORE_KICKOFF");
    }
    if (generatedMs > evaluatedAtMs) issues.push("SNAPSHOT_GENERATED_AT_IN_FUTURE");
  }
  if (cutoffMs !== null && generatedMs !== null && generatedMs < cutoffMs) {
    issues.push("SNAPSHOT_GENERATED_BEFORE_CUTOFF");
  }

  if (stage && cutoffMs !== null && generatedMs !== null) {
    if ((TIMED_STAGES as readonly string[]).includes(stage)) {
      const timedStage = stage as TimedStage;
      const times = windowTimes(timedStage, kickoffMs);
      if (cutoffMs !== times.scheduledForMs) {
        issues.push("SNAPSHOT_STAGE_CUTOFF_MISMATCH");
      }
      if (
        generatedMs < times.eligibleFromMs ||
        generatedMs > times.eligibleUntilMs
      ) {
        issues.push("SNAPSHOT_GENERATED_OUTSIDE_STAGE_WINDOW");
      }
    }
  }

  const latestIncludedInputAt = snapshot.latestIncludedInputAt ?? null;
  if (latestIncludedInputAt !== null) {
    const latestInputMs = finiteTimestamp(latestIncludedInputAt);
    if (latestInputMs === null) {
      issues.push("LATEST_INCLUDED_INPUT_AT_INVALID");
    } else if (cutoffMs !== null && latestInputMs > cutoffMs) {
      issues.push("LATEST_INCLUDED_INPUT_AFTER_CUTOFF");
    }
  }

  if (issues.length || !stage || cutoffMs === null || generatedMs === null) {
    return { valid: null, issues };
  }
  return {
    valid: {
      input: snapshot,
      stage,
      cutoffMs,
      generatedMs,
      latestIncludedInputAt,
    },
    issues,
  };
}

/**
 * Canonical per-snapshot stage and temporal validity contract.
 *
 * Match Room selection, fixture ledgers, evaluation evidence, and freshness
 * must all call this same policy so a mislabeled or out-of-window stage can be
 * retained for audit without ever becoming the current production forecast.
 */
export function validateProductionForecastSnapshot(input: {
  snapshot: ForecastFreshnessSnapshotInput;
  expectedKickoffUtc: string;
  evaluatedAt: string;
}): { valid: ValidProductionForecastSnapshot | null; issues: SnapshotFreshnessIssueCode[] } {
  const kickoffMs = finiteTimestamp(input.expectedKickoffUtc);
  const evaluatedAtMs = finiteTimestamp(input.evaluatedAt);
  const snapshotKickoffMs = finiteTimestamp(input.snapshot.kickoffUtc);
  const issues: SnapshotFreshnessIssueCode[] = [];
  if (kickoffMs === null || snapshotKickoffMs === null) {
    issues.push("SNAPSHOT_KICKOFF_INVALID");
  } else if (snapshotKickoffMs !== kickoffMs) {
    issues.push("SNAPSHOT_KICKOFF_MISMATCH");
  }
  if (evaluatedAtMs === null) issues.push("SNAPSHOT_EVALUATED_AT_INVALID");
  if (issues.length || kickoffMs === null || evaluatedAtMs === null) {
    return { valid: null, issues };
  }
  return validateCurrentSnapshot(input.snapshot, kickoffMs, evaluatedAtMs);
}

/**
 * Evaluate one fixture against the immutable production-stage policy.
 *
 * Isolation filters run before temporal validation: a shadow,
 * reconstruction, retrospective, other-model, or obsolete-kickoff row can
 * never satisfy production freshness and cannot poison the production scope.
 */
export function evaluateFixtureForecastFreshness(
  input: FixtureForecastFreshnessInput
): FixtureForecastFreshness {
  const kickoffMs = finiteTimestamp(input.kickoffUtc);
  const evaluatedAtMs = finiteTimestamp(input.evaluatedAt);
  const topLevelReasons: FixtureFreshnessReasonCode[] = [];
  if (!input.fixtureId.trim()) topLevelReasons.push("INVALID_FIXTURE_ID");
  if (kickoffMs === null) topLevelReasons.push("INVALID_KICKOFF");
  if (evaluatedAtMs === null) topLevelReasons.push("INVALID_EVALUATED_AT");
  if (topLevelReasons.length || kickoffMs === null || evaluatedAtMs === null) {
    return invalidFixtureResult(input, kickoffMs ?? Number.NaN, topLevelReasons);
  }

  const ignoredSnapshots: FixtureForecastFreshness["ignoredSnapshots"] = {
    nonProductionRole: 0,
    wrongEvaluationClass: 0,
    wrongModelVersion: 0,
    wrongFixture: 0,
    obsoleteKickoff: 0,
  };
  const currentCandidates: ForecastFreshnessSnapshotInput[] = [];
  const invalidSnapshots: InvalidForecastFreshnessSnapshot[] = [];

  for (const snapshot of input.snapshots) {
    if (snapshot.fixtureId !== input.fixtureId) {
      ignoredSnapshots.wrongFixture += 1;
      continue;
    }
    if (snapshot.modelRole !== "production") {
      ignoredSnapshots.nonProductionRole += 1;
      continue;
    }
    if (snapshot.evaluationClass !== "LIVE_OOS") {
      ignoredSnapshots.wrongEvaluationClass += 1;
      continue;
    }
    if (snapshot.modelVersion !== input.expectedModelVersion) {
      ignoredSnapshots.wrongModelVersion += 1;
      continue;
    }
    const snapshotKickoffMs = finiteTimestamp(snapshot.kickoffUtc);
    if (snapshotKickoffMs === null) {
      invalidSnapshots.push({
        snapshotId: snapshot.snapshotId,
        issues: ["SNAPSHOT_KICKOFF_INVALID"],
      });
      continue;
    }
    if (snapshotKickoffMs !== kickoffMs) {
      ignoredSnapshots.obsoleteKickoff += 1;
      continue;
    }
    currentCandidates.push(snapshot);
  }

  const validSnapshots: ValidProductionForecastSnapshot[] = [];
  for (const snapshot of currentCandidates) {
    const checked = validateProductionForecastSnapshot({
      snapshot,
      expectedKickoffUtc: input.kickoffUtc,
      evaluatedAt: input.evaluatedAt,
    });
    if (checked.valid) validSnapshots.push(checked.valid);
    else invalidSnapshots.push({ snapshotId: snapshot.snapshotId, issues: checked.issues });
  }

  validSnapshots.sort(
    (a, b) =>
      a.cutoffMs - b.cutoffMs ||
      a.generatedMs - b.generatedMs ||
      a.input.snapshotId.localeCompare(b.input.snapshotId)
  );
  const selected = validSnapshots.at(-1) ?? null;
  const byStage = new Map<ProductionFreshnessStage, ValidProductionForecastSnapshot>();
  for (const snapshot of validSnapshots) byStage.set(snapshot.stage, snapshot);

  let latestRequiredStage: TimedStage | null = null;
  let nextStage: TimedStage | null = null;
  let activeStage: TimedStage | null = null;
  const missedStages: TimedStage[] = [];
  const blockedStages: TimedStage[] = [];
  const stages: TimedStageFreshness[] = [];

  for (const stage of TIMED_STAGES) {
    const times = windowTimes(stage, kickoffMs);
    const snapshot = byStage.get(stage) ?? null;
    const job = jobForStage(input, stage, kickoffMs);
    const blocked = !snapshot && (job?.status === "BLOCKED" || job?.status === "CANCELLED");
    let state: TimedStagePolicyState;

    if (snapshot) {
      state = "SATISFIED";
    } else if (evaluatedAtMs < times.eligibleFromMs) {
      state = "FUTURE";
    } else if (evaluatedAtMs <= times.eligibleUntilMs) {
      state = blocked ? "BLOCKED" : "DUE";
      activeStage = stage;
    } else {
      state = "MISSED";
      missedStages.push(stage);
    }

    if (blocked) blockedStages.push(stage);
    if (evaluatedAtMs >= times.eligibleFromMs) latestRequiredStage = stage;
    else if (nextStage === null) nextStage = stage;

    stages.push({
      stage,
      state,
      scheduledFor: iso(times.scheduledForMs),
      eligibleFrom: iso(times.eligibleFromMs),
      eligibleUntil: iso(times.eligibleUntilMs),
      snapshotId: snapshot?.input.snapshotId ?? null,
      jobStatus: job?.status ?? null,
    });
  }

  const latestRequiredSatisfied = latestRequiredStage
    ? byStage.has(latestRequiredStage)
    : Boolean(selected && (BASELINE_FORECAST_STAGES as readonly string[]).includes(selected.stage));
  let meetsStagePolicy = Boolean(selected) && latestRequiredSatisfied;
  const reasonCodes: FixtureFreshnessReasonCode[] = [];
  let status: FixtureForecastFreshnessStatus;

  if (!selected) {
    status = "UNAVAILABLE";
    reasonCodes.push("NO_VALID_PRODUCTION_SNAPSHOT");
  } else if (latestRequiredStage === null) {
    status = "CURRENT_BASELINE";
    reasonCodes.push("BASELINE_CURRENT_BEFORE_FIRST_TIMED_STAGE");
  } else if (latestRequiredSatisfied) {
    status = "CURRENT_STAGE";
    reasonCodes.push("LATEST_REQUIRED_STAGE_SATISFIED");
  } else if (activeStage && blockedStages.includes(activeStage)) {
    status = "BLOCKED";
    reasonCodes.push("ACTIVE_STAGE_BLOCKED");
  } else if (activeStage) {
    status = "UPDATE_DUE";
    reasonCodes.push("ACTIVE_STAGE_MISSING");
  } else {
    status = "MISSED_STAGE";
    reasonCodes.push("LATEST_REQUIRED_STAGE_MISSED");
  }
  if (invalidSnapshots.length) {
    status = "INVALID";
    meetsStagePolicy = false;
    reasonCodes.unshift("INVALID_CURRENT_PRODUCTION_SNAPSHOT");
  }
  if (evaluatedAtMs >= kickoffMs) reasonCodes.push("EVALUATED_AT_AFTER_KICKOFF");

  const selectedSnapshot: SelectedFreshnessSnapshot | null = selected
    ? {
        snapshotId: selected.input.snapshotId,
        stage: selected.stage,
        cutoffAt: selected.input.cutoffAt,
        generatedAt: selected.input.generatedAt,
        cutoffAgeHours:
          Math.round(((evaluatedAtMs - selected.cutoffMs) / HOUR_MS) * 10) / 10,
        latestIncludedInputAt: selected.latestIncludedInputAt,
        latestIncludedInputStatus: selected.latestIncludedInputAt
          ? "RECORDED"
          : "UNAVAILABLE",
      }
    : null;

  return {
    policyVersion: PRODUCTION_FRESHNESS_POLICY_VERSION,
    fixtureId: input.fixtureId,
    kickoffUtc: input.kickoffUtc,
    evaluatedAt: input.evaluatedAt,
    expectedModelVersion: input.expectedModelVersion,
    status,
    meetsStagePolicy,
    selectedStage: selected?.stage ?? null,
    cutoffAt: selectedSnapshot?.cutoffAt ?? null,
    generatedAt: selectedSnapshot?.generatedAt ?? null,
    cutoffAgeHours: selectedSnapshot?.cutoffAgeHours ?? null,
    latestIncludedInputAt: selectedSnapshot?.latestIncludedInputAt ?? null,
    latestIncludedInputStatus:
      selectedSnapshot?.latestIncludedInputStatus ?? "UNAVAILABLE",
    latestRequiredStage,
    activeDueStage: activeStage,
    nextStage,
    missedStages,
    blockedStages,
    selectedSnapshot,
    stages,
    invalidSnapshots,
    ignoredSnapshots,
    reasonCodes,
  };
}

export type OperationalFreshnessStatus = "FRESH" | "STALE" | "NEVER" | "ERROR";
export type OperationalFreshnessReasonCode =
  | "FRESH_WITHIN_THRESHOLD"
  | "NEVER_ATTEMPTED"
  | "NO_SUCCESS_RECORDED"
  | "LAST_ERROR_RECORDED"
  | "INVALID_EVALUATED_AT"
  | "INVALID_STALE_THRESHOLD"
  | "INVALID_CADENCE"
  | "LAST_ATTEMPT_INVALID"
  | "LAST_SUCCESS_INVALID"
  | "LAST_ATTEMPT_IN_FUTURE"
  | "LAST_SUCCESS_IN_FUTURE"
  | "LAST_ATTEMPT_STALE"
  | "LAST_SUCCESS_STALE";

export interface OperationalFreshnessInput {
  evaluatedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  staleAfterMs: number;
  cadenceMs: number | null;
  lastError?: string | null;
}

type OperationalFreshnessScope = "scheduler" | "fixtureSync" | "marketObserver";

export interface OperationalFreshness<Scope extends OperationalFreshnessScope> {
  scope: Scope;
  status: OperationalFreshnessStatus;
  evaluatedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAttemptAgeMs: number | null;
  lastSuccessAgeMs: number | null;
  staleAfterMs: number;
  cadenceMs: number | null;
  reasonCodes: OperationalFreshnessReasonCode[];
}

function evaluateOperationalFreshness<Scope extends OperationalFreshnessScope>(
  scope: Scope,
  input: OperationalFreshnessInput
): OperationalFreshness<Scope> {
  const evaluatedAtMs = finiteTimestamp(input.evaluatedAt);
  const attemptMs = finiteTimestamp(input.lastAttemptAt);
  const successMs = finiteTimestamp(input.lastSuccessAt);
  const reasons: OperationalFreshnessReasonCode[] = [];

  if (evaluatedAtMs === null) reasons.push("INVALID_EVALUATED_AT");
  if (!Number.isFinite(input.staleAfterMs) || input.staleAfterMs <= 0) {
    reasons.push("INVALID_STALE_THRESHOLD");
  }
  if (
    input.cadenceMs !== null &&
    (!Number.isFinite(input.cadenceMs) || input.cadenceMs <= 0)
  ) {
    reasons.push("INVALID_CADENCE");
  }
  if (input.lastAttemptAt !== null && attemptMs === null) reasons.push("LAST_ATTEMPT_INVALID");
  if (input.lastSuccessAt !== null && successMs === null) reasons.push("LAST_SUCCESS_INVALID");
  if (input.lastError?.trim()) reasons.push("LAST_ERROR_RECORDED");

  if (evaluatedAtMs !== null) {
    if (attemptMs !== null && attemptMs > evaluatedAtMs) reasons.push("LAST_ATTEMPT_IN_FUTURE");
    if (successMs !== null && successMs > evaluatedAtMs) reasons.push("LAST_SUCCESS_IN_FUTURE");
  }
  const structuralError = reasons.length > 0;
  let status: OperationalFreshnessStatus;
  if (structuralError) {
    status = "ERROR";
  } else if (attemptMs === null && successMs === null) {
    status = "NEVER";
    reasons.push("NEVER_ATTEMPTED");
  } else if (attemptMs === null || successMs === null) {
    status = "ERROR";
    reasons.push(attemptMs === null ? "NEVER_ATTEMPTED" : "NO_SUCCESS_RECORDED");
  } else {
    const attemptAge = evaluatedAtMs! - attemptMs;
    const successAge = evaluatedAtMs! - successMs;
    if (attemptAge > input.staleAfterMs) reasons.push("LAST_ATTEMPT_STALE");
    if (successAge > input.staleAfterMs) reasons.push("LAST_SUCCESS_STALE");
    if (reasons.length) status = "STALE";
    else {
      status = "FRESH";
      reasons.push("FRESH_WITHIN_THRESHOLD");
    }
  }

  return {
    scope,
    status,
    evaluatedAt: input.evaluatedAt,
    lastAttemptAt: input.lastAttemptAt,
    lastSuccessAt: input.lastSuccessAt,
    lastAttemptAgeMs:
      evaluatedAtMs !== null && attemptMs !== null ? evaluatedAtMs - attemptMs : null,
    lastSuccessAgeMs:
      evaluatedAtMs !== null && successMs !== null ? evaluatedAtMs - successMs : null,
    staleAfterMs: input.staleAfterMs,
    cadenceMs: input.cadenceMs,
    reasonCodes: reasons,
  };
}

export interface SchedulerFreshnessInput
  extends Omit<OperationalFreshnessInput, "staleAfterMs"> {
  staleAfterMs?: number;
}

export function evaluateSchedulerFreshness(
  input: SchedulerFreshnessInput
): OperationalFreshness<"scheduler"> {
  return evaluateOperationalFreshness("scheduler", {
    ...input,
    staleAfterMs: input.staleAfterMs ?? SCHEDULER_STALE_AFTER_MS,
  });
}

export interface FixtureSyncFreshnessInput
  extends Omit<OperationalFreshnessInput, "staleAfterMs"> {
  nearMatch: boolean;
  staleAfterNearMatchMs?: number;
  staleAfterDefaultMs?: number;
}

export interface FixtureSyncFreshness extends OperationalFreshness<"fixtureSync"> {
  nearMatch: boolean;
}

export function evaluateFixtureSyncFreshness(
  input: FixtureSyncFreshnessInput
): FixtureSyncFreshness {
  const staleAfterMs = input.nearMatch
    ? input.staleAfterNearMatchMs ?? FIXTURE_SYNC_STALE_NEAR_MATCH_MS
    : input.staleAfterDefaultMs ?? FIXTURE_SYNC_STALE_DEFAULT_MS;
  const report = evaluateOperationalFreshness("fixtureSync", {
    evaluatedAt: input.evaluatedAt,
    lastAttemptAt: input.lastAttemptAt,
    lastSuccessAt: input.lastSuccessAt,
    cadenceMs: input.cadenceMs,
    lastError: input.lastError,
    staleAfterMs,
  });
  return { ...report, nearMatch: input.nearMatch };
}

export type MarketObserverFreshnessStatus =
  | "FRESH"
  | "STALE"
  | "UNCONFIGURED"
  | "ERROR";
export type MarketObserverFreshnessReasonCode =
  | OperationalFreshnessReasonCode
  | "MARKET_OBSERVER_UNCONFIGURED";

export interface MarketObserverFreshnessInput extends OperationalFreshnessInput {
  configured: boolean;
}

export interface MarketObserverFreshness {
  scope: "marketObserver";
  status: MarketObserverFreshnessStatus;
  evaluatedAt: string;
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAttemptAgeMs: number | null;
  lastSuccessAgeMs: number | null;
  staleAfterMs: number;
  cadenceMs: number | null;
  reasonCodes: MarketObserverFreshnessReasonCode[];
  /** Market observation is never an input to the production forecast model. */
  affectsProductionForecast: false;
}

/** Pure/injected observer health; never reads odds, stores, or configuration. */
export function evaluateMarketObserverFreshness(
  input: MarketObserverFreshnessInput
): MarketObserverFreshness {
  if (!input.configured) {
    return {
      scope: "marketObserver",
      status: "UNCONFIGURED",
      evaluatedAt: input.evaluatedAt,
      configured: false,
      lastAttemptAt: input.lastAttemptAt,
      lastSuccessAt: input.lastSuccessAt,
      lastAttemptAgeMs: null,
      lastSuccessAgeMs: null,
      staleAfterMs: input.staleAfterMs,
      cadenceMs: input.cadenceMs,
      reasonCodes: ["MARKET_OBSERVER_UNCONFIGURED"],
      affectsProductionForecast: false,
    };
  }
  const operational = evaluateOperationalFreshness("marketObserver", input);
  return {
    scope: "marketObserver",
    status: operational.status === "NEVER" ? "STALE" : operational.status,
    evaluatedAt: operational.evaluatedAt,
    configured: true,
    lastAttemptAt: operational.lastAttemptAt,
    lastSuccessAt: operational.lastSuccessAt,
    lastAttemptAgeMs: operational.lastAttemptAgeMs,
    lastSuccessAgeMs: operational.lastSuccessAgeMs,
    staleAfterMs: operational.staleAfterMs,
    cadenceMs: operational.cadenceMs,
    reasonCodes: operational.reasonCodes,
    affectsProductionForecast: false,
  };
}

export type ForecastCoverageStatus = "CURRENT" | "DEGRADED" | "UNAVAILABLE";

export interface ForecastCoverageFreshness {
  status: ForecastCoverageStatus;
  totalFixtures: number;
  current: number;
  updateDue: number;
  missed: number;
  blocked: number;
  unavailable: number;
  invalid: number;
  meetsStagePolicy: number;
}

export function summarizeForecastCoverage(
  fixtures: readonly FixtureForecastFreshness[]
): ForecastCoverageFreshness {
  const current = fixtures.filter(
    (fixture) =>
      fixture.status === "CURRENT_BASELINE" || fixture.status === "CURRENT_STAGE"
  ).length;
  const updateDue = fixtures.filter((fixture) => fixture.status === "UPDATE_DUE").length;
  const missed = fixtures.filter((fixture) => fixture.status === "MISSED_STAGE").length;
  const blocked = fixtures.filter((fixture) => fixture.status === "BLOCKED").length;
  const unavailable = fixtures.filter((fixture) => fixture.status === "UNAVAILABLE").length;
  const invalid = fixtures.filter((fixture) => fixture.status === "INVALID").length;
  const unavailableLike = unavailable + invalid;
  const status: ForecastCoverageStatus =
    fixtures.length === 0 || unavailableLike === fixtures.length
      ? "UNAVAILABLE"
      : current === fixtures.length
        ? "CURRENT"
        : "DEGRADED";
  return {
    status,
    totalFixtures: fixtures.length,
    current,
    updateDue,
    missed,
    blocked,
    unavailable,
    invalid,
    meetsStagePolicy: fixtures.filter((fixture) => fixture.meetsStagePolicy).length,
  };
}

export interface ProductionFreshnessReport {
  policyVersion: typeof PRODUCTION_FRESHNESS_POLICY_VERSION;
  evaluatedAt: string;
  sourceRevision: string | null;
  scheduler: OperationalFreshness<"scheduler">;
  fixtureSync: FixtureSyncFreshness;
  forecastCoverage: ForecastCoverageFreshness;
  fixtures: FixtureForecastFreshness[];
  marketObserver: MarketObserverFreshness;
}

export interface ProductionFreshnessReportInput {
  evaluatedAt: string;
  sourceRevision: string | null;
  fixtures: readonly Omit<FixtureForecastFreshnessInput, "evaluatedAt">[];
  scheduler: Omit<SchedulerFreshnessInput, "evaluatedAt">;
  fixtureSync: Omit<FixtureSyncFreshnessInput, "evaluatedAt">;
  marketObserver: Omit<MarketObserverFreshnessInput, "evaluatedAt">;
}

/** Build all public freshness scopes from one clock instant and one policy. */
export function buildProductionFreshnessReport(
  input: ProductionFreshnessReportInput
): ProductionFreshnessReport {
  const fixtures = input.fixtures.map((fixture) =>
    evaluateFixtureForecastFreshness({ ...fixture, evaluatedAt: input.evaluatedAt })
  );
  return {
    policyVersion: PRODUCTION_FRESHNESS_POLICY_VERSION,
    evaluatedAt: input.evaluatedAt,
    sourceRevision: input.sourceRevision,
    scheduler: evaluateSchedulerFreshness({
      ...input.scheduler,
      evaluatedAt: input.evaluatedAt,
    }),
    fixtureSync: evaluateFixtureSyncFreshness({
      ...input.fixtureSync,
      evaluatedAt: input.evaluatedAt,
    }),
    forecastCoverage: summarizeForecastCoverage(fixtures),
    fixtures,
    marketObserver: evaluateMarketObserverFreshness({
      ...input.marketObserver,
      evaluatedAt: input.evaluatedAt,
    }),
  };
}
