/**
 * Strict point-in-time admission boundary for historical replay.
 *
 * This module is deliberately store-free. It never reads current/latest state,
 * never writes the production ledger, and passes only cutoff-admissible inputs
 * to the caller's predictor. It is an admission scaffold, not proof that an
 * arbitrary callback has no closed-over external state; a production replay
 * predictor still needs a separate sealed-dependency audit.
 */

import { createHash } from "node:crypto";
import { isTimedStage, windowFor } from "@/lib/competitions/premier-league/ops/stage-windows";

export const PIT_CLASSIFICATIONS = [
  "VERIFIED_PIT",
  "RECONSTRUCTABLE_FROM_IMMUTABLE_RAW",
  "NOT_PIT_SAFE",
  "UNAVAILABLE_HISTORICALLY",
] as const;

export type PitClassification = (typeof PIT_CLASSIFICATIONS)[number];

export const HISTORICAL_REPLAY_TRACK = "HISTORICAL_REPLAY" as const;

export const HISTORICAL_REPLAY_STAGES = [
  "PRESEASON",
  "EARLY",
  "T7D",
  "T24H",
  "T2H",
  "T60M",
  "FINAL_PREKICK",
] as const;

export type HistoricalReplayStage = (typeof HISTORICAL_REPLAY_STAGES)[number];

export interface PitReplayInput {
  inputId: string;
  kind: string;
  sourceId: string;
  /** First time the exact evidence was knowable to this replay. */
  availableAt: string | null;
  classification: PitClassification;
  immutable: boolean;
  /** Canonical SHA-256 returned by canonicalPayloadHash for the exact payload. */
  contentHash: string | null;
  /** Required when kind=fixture_metadata. */
  subjectFixtureId?: string | null;
  /** Required when kind=fixture_metadata. */
  kickoffAtAsKnown?: string | null;
  /** Required when kind=model_parameters. */
  bundleModelVersion?: string | null;
  /** Required when kind=model_parameters. */
  bundleFeatureVersion?: string | null;
  /** Required when kind=model_parameters; must be strictly before cutoffAt. */
  trainingCutoffAt?: string | null;
  payload: unknown;
}

export interface HistoricalReplayRequest {
  fixtureId: string;
  forecastStage: HistoricalReplayStage;
  cutoffAt: string;
  kickoffAtAsKnown: string;
  modelVersion: string;
  featureVersion: string;
  codeVersion: string;
  /** Real execution time. It is not represented as a historical issuance time. */
  replayExecutedAt: string;
}

export type ReplayAdmissionIssueCode =
  | "FIXTURE_ID_MISSING"
  | "MODEL_VERSION_MISSING"
  | "FEATURE_VERSION_MISSING"
  | "CODE_VERSION_MISSING"
  | "FORECAST_STAGE_INVALID"
  | "CUTOFF_INVALID"
  | "KICKOFF_AS_KNOWN_INVALID"
  | "REPLAY_EXECUTED_AT_INVALID"
  | "REPLAY_EXECUTED_BEFORE_CUTOFF"
  | "CUTOFF_NOT_BEFORE_KICKOFF"
  | "INPUT_ID_MISSING"
  | "INPUT_KIND_MISSING"
  | "SOURCE_ID_MISSING"
  | "INPUT_AVAILABLE_AT_MISSING_OR_INVALID"
  | "INPUT_NOT_IMMUTABLE"
  | "INPUT_CONTENT_HASH_MISSING"
  | "INPUT_CONTENT_HASH_MISMATCH"
  | "INPUT_NOT_PIT_SAFE"
  | "DUPLICATE_INPUT_ID_CONFLICT"
  | "REQUIRED_INPUT_KIND_MISSING_AT_CUTOFF"
  | "FIXTURE_METADATA_SUBJECT_MISSING_OR_MISMATCH"
  | "FIXTURE_METADATA_KICKOFF_MISSING_OR_INVALID"
  | "FIXTURE_METADATA_PAYLOAD_MISMATCH"
  | "FIXTURE_METADATA_AMBIGUOUS_AT_CUTOFF"
  | "KICKOFF_AS_KNOWN_MISMATCH"
  | "STAGE_CUTOFF_MISMATCH"
  | "MODEL_BUNDLE_MODEL_VERSION_MISMATCH"
  | "MODEL_BUNDLE_FEATURE_VERSION_MISMATCH"
  | "MODEL_BUNDLE_TRAINING_CUTOFF_MISSING_OR_INVALID"
  | "MODEL_BUNDLE_TRAINING_NOT_BEFORE_CUTOFF"
  | "MODEL_BUNDLE_PAYLOAD_MISMATCH"
  | "MODEL_BUNDLE_AMBIGUOUS_AT_CUTOFF";

export interface ReplayAdmissionIssue {
  code: ReplayAdmissionIssueCode;
  inputId?: string;
  kind?: string;
  detail: string;
}

export interface HistoricalReplayAdmission {
  track: typeof HISTORICAL_REPLAY_TRACK;
  admissible: boolean;
  request: HistoricalReplayRequest;
  replayKey: string;
  includedInputs: PitReplayInput[];
  maxInputAvailableAt: string | null;
  excludedPostCutoffInputIds: string[];
  excludedSupersededInputIds: string[];
  issues: ReplayAdmissionIssue[];
}

export interface HistoricalReplayProbabilities {
  home: number;
  draw: number;
  away: number;
}

export interface HistoricalReplayArtifact {
  track: typeof HISTORICAL_REPLAY_TRACK;
  replayKey: string;
  fixtureId: string;
  modelVersion: string;
  stage: HistoricalReplayStage;
  cutoffAt: string;
  kickoffAtAsKnown: string;
  replayExecutedAt: string;
  maxInputAvailableAt: string;
  sourceIds: string[];
  sourceAvailableAt: Array<{ inputId: string; sourceId: string; availableAt: string }>;
  inputLineage: Array<{
    inputId: string;
    kind: string;
    sourceId: string;
    availableAt: string;
    contentHash: string;
    classification: PitClassification;
    payloadDigest: string;
    subjectFixtureId: string | null;
    kickoffAtAsKnown: string | null;
    bundleModelVersion: string | null;
    bundleFeatureVersion: string | null;
    trainingCutoffAt: string | null;
  }>;
  featureVersion: string;
  codeVersion: string;
  probabilities: HistoricalReplayProbabilities;
  actualResult: "home" | "draw" | "away" | null;
  predictionDigest: string;
}

const EXPLICIT_RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: string | null | undefined): number | null {
  if (!value || !EXPLICIT_RFC3339.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((child) => isJsonValue(child, seen));
    seen.delete(value);
    return valid;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const valid = Object.values(value as Record<string, unknown>).every((child) =>
    isJsonValue(child, seen)
  );
  seen.delete(value);
  return valid;
}

/** Content identity for a JSON-compatible immutable source payload. */
export function canonicalPayloadHash(payload: unknown): string {
  if (!isJsonValue(payload)) {
    throw new Error("PIT replay payloads must be finite, acyclic JSON values.");
  }
  return `sha256:${digest(payload)}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPotentiallyPitUsable(classification: PitClassification): boolean {
  return (
    classification === "VERIFIED_PIT" ||
    classification === "RECONSTRUCTABLE_FROM_IMMUTABLE_RAW"
  );
}

function validateInputShape(input: PitReplayInput): ReplayAdmissionIssue[] {
  const issues: ReplayAdmissionIssue[] = [];
  const common = { inputId: input.inputId || undefined, kind: input.kind || undefined };
  if (!input.inputId.trim()) {
    issues.push({ ...common, code: "INPUT_ID_MISSING", detail: "Input identity is required." });
  }
  if (!input.kind.trim()) {
    issues.push({ ...common, code: "INPUT_KIND_MISSING", detail: "Input kind is required." });
  }
  if (!input.sourceId.trim()) {
    issues.push({ ...common, code: "SOURCE_ID_MISSING", detail: "Source identity is required." });
  }
  if (timestamp(input.availableAt) === null) {
    issues.push({
      ...common,
      code: "INPUT_AVAILABLE_AT_MISSING_OR_INVALID",
      detail: "A valid first-known availableAt timestamp is required.",
    });
  }
  if (!input.immutable) {
    issues.push({ ...common, code: "INPUT_NOT_IMMUTABLE", detail: "Input is not immutable." });
  }
  if (!input.contentHash?.trim()) {
    issues.push({
      ...common,
      code: "INPUT_CONTENT_HASH_MISSING",
      detail: "Exact source payload needs its canonical SHA-256 content hash.",
    });
  } else {
    try {
      const computed = canonicalPayloadHash(input.payload);
      if (input.contentHash !== computed) {
        issues.push({
          ...common,
          code: "INPUT_CONTENT_HASH_MISMATCH",
          detail: `Declared contentHash does not match the canonical payload hash (${computed}).`,
        });
      }
    } catch (error) {
      issues.push({
        ...common,
        code: "INPUT_CONTENT_HASH_MISMATCH",
        detail: error instanceof Error ? error.message : "Payload is not canonically hashable.",
      });
    }
  }
  if (!isPotentiallyPitUsable(input.classification)) {
    issues.push({
      ...common,
      code: "INPUT_NOT_PIT_SAFE",
      detail: `Classification ${input.classification} is not replay-admissible.`,
    });
  }
  return issues;
}

/**
 * Select only immutable inputs first known no later than the forecast cutoff.
 * Missing material evidence fails closed; post-cutoff rows are retained only
 * in the audit exclusion list.
 */
export function prepareHistoricalReplay(input: {
  request: HistoricalReplayRequest;
  inputs: readonly PitReplayInput[];
  requiredInputKinds: readonly string[];
}): HistoricalReplayAdmission {
  const request = input.request;
  const issues: ReplayAdmissionIssue[] = [];
  const cutoffMs = timestamp(request.cutoffAt);
  const kickoffMs = timestamp(request.kickoffAtAsKnown);
  const executedMs = timestamp(request.replayExecutedAt);
  const normalizedRequest: HistoricalReplayRequest = {
    ...request,
    cutoffAt: cutoffMs === null ? request.cutoffAt : new Date(cutoffMs).toISOString(),
    kickoffAtAsKnown:
      kickoffMs === null ? request.kickoffAtAsKnown : new Date(kickoffMs).toISOString(),
    replayExecutedAt:
      executedMs === null ? request.replayExecutedAt : new Date(executedMs).toISOString(),
  };

  if (!request.fixtureId.trim()) {
    issues.push({ code: "FIXTURE_ID_MISSING", detail: "Fixture identity is required." });
  }
  if (!request.modelVersion.trim()) {
    issues.push({ code: "MODEL_VERSION_MISSING", detail: "Model version is required." });
  }
  if (!request.featureVersion.trim()) {
    issues.push({ code: "FEATURE_VERSION_MISSING", detail: "Feature version is required." });
  }
  if (!request.codeVersion.trim()) {
    issues.push({ code: "CODE_VERSION_MISSING", detail: "Replay code version is required." });
  }
  if (!HISTORICAL_REPLAY_STAGES.includes(request.forecastStage)) {
    issues.push({ code: "FORECAST_STAGE_INVALID", detail: "Forecast stage is invalid." });
  }
  if (cutoffMs === null) issues.push({ code: "CUTOFF_INVALID", detail: "cutoffAt is invalid." });
  if (kickoffMs === null) {
    issues.push({ code: "KICKOFF_AS_KNOWN_INVALID", detail: "kickoffAtAsKnown is invalid." });
  }
  if (executedMs === null) {
    issues.push({ code: "REPLAY_EXECUTED_AT_INVALID", detail: "replayExecutedAt is invalid." });
  }
  if (cutoffMs !== null && executedMs !== null && executedMs < cutoffMs) {
    issues.push({
      code: "REPLAY_EXECUTED_BEFORE_CUTOFF",
      detail: "Replay execution cannot precede the historical information cutoff.",
    });
  }
  if (cutoffMs !== null && kickoffMs !== null && cutoffMs >= kickoffMs) {
    issues.push({
      code: "CUTOFF_NOT_BEFORE_KICKOFF",
      detail: "Historical cutoff must be strictly before kickoff-as-known.",
    });
  }
  if (
    cutoffMs !== null &&
    kickoffMs !== null &&
    isTimedStage(request.forecastStage) &&
    Date.parse(windowFor(request.forecastStage, normalizedRequest.kickoffAtAsKnown).plannedAsOf) !==
      cutoffMs
  ) {
    issues.push({
      code: "STAGE_CUTOFF_MISMATCH",
      detail: `${request.forecastStage} cutoffAt must equal the canonical cutoff derived from kickoffAtAsKnown.`,
    });
  }

  const byId = new Map<string, PitReplayInput>();
  const excludedPostCutoffInputIds: string[] = [];
  for (const rawRow of input.inputs) {
    const availableMs = timestamp(rawRow.availableAt);
    const inputKickoffMs = timestamp(rawRow.kickoffAtAsKnown);
    const trainingCutoffMs = timestamp(rawRow.trainingCutoffAt);
    const row: PitReplayInput = {
      ...rawRow,
      availableAt:
        availableMs === null ? rawRow.availableAt : new Date(availableMs).toISOString(),
      kickoffAtAsKnown:
        inputKickoffMs === null || rawRow.kickoffAtAsKnown == null
          ? rawRow.kickoffAtAsKnown
          : new Date(inputKickoffMs).toISOString(),
      trainingCutoffAt:
        trainingCutoffMs === null || rawRow.trainingCutoffAt == null
          ? rawRow.trainingCutoffAt
          : new Date(trainingCutoffMs).toISOString(),
    };
    if (availableMs !== null && cutoffMs !== null && availableMs > cutoffMs) {
      excludedPostCutoffInputIds.push(row.inputId);
      continue;
    }
    const previous = byId.get(row.inputId);
    if (previous && digest(previous) !== digest(row)) {
      issues.push({
        code: "DUPLICATE_INPUT_ID_CONFLICT",
        inputId: row.inputId,
        kind: row.kind,
        detail: "The same input identity resolves to different content.",
      });
      continue;
    }
    if (!previous) byId.set(row.inputId, row);
  }

  const candidateInputs: PitReplayInput[] = [];
  for (const row of byId.values()) {
    const rowIssues = validateInputShape(row);
    if (row.kind === "fixture_metadata") {
      if (!row.subjectFixtureId?.trim() || row.subjectFixtureId !== request.fixtureId) {
        rowIssues.push({
          code: "FIXTURE_METADATA_SUBJECT_MISSING_OR_MISMATCH",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Fixture metadata must identify the replay request fixture.",
        });
      }
      if (timestamp(row.kickoffAtAsKnown) === null) {
        rowIssues.push({
          code: "FIXTURE_METADATA_KICKOFF_MISSING_OR_INVALID",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Fixture metadata needs the explicit-offset kickoff known at observation time.",
        });
      }
      const fixturePayload = recordPayload(row.payload);
      if (
        fixturePayload?.fixtureId !== row.subjectFixtureId ||
        timestamp(fixturePayload?.kickoffAt as string | undefined) !==
          timestamp(row.kickoffAtAsKnown)
      ) {
        rowIssues.push({
          code: "FIXTURE_METADATA_PAYLOAD_MISMATCH",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Fixture payload identity/kickoff must match its authoritative PIT sidecars.",
        });
      }
    }
    if (row.kind === "model_parameters") {
      if (row.bundleModelVersion !== request.modelVersion) {
        rowIssues.push({
          code: "MODEL_BUNDLE_MODEL_VERSION_MISMATCH",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Frozen model bundle version must equal the requested modelVersion.",
        });
      }
      if (row.bundleFeatureVersion !== request.featureVersion) {
        rowIssues.push({
          code: "MODEL_BUNDLE_FEATURE_VERSION_MISMATCH",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Frozen model bundle feature version must equal the requested featureVersion.",
        });
      }
      const trainedMs = timestamp(row.trainingCutoffAt);
      if (trainedMs === null) {
        rowIssues.push({
          code: "MODEL_BUNDLE_TRAINING_CUTOFF_MISSING_OR_INVALID",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Frozen model bundle needs an explicit trainingCutoffAt.",
        });
      } else if (cutoffMs !== null && trainedMs >= cutoffMs) {
        rowIssues.push({
          code: "MODEL_BUNDLE_TRAINING_NOT_BEFORE_CUTOFF",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Model training information must end strictly before the forecast cutoff.",
        });
      }
      const modelPayload = recordPayload(row.payload);
      if (
        modelPayload?.modelVersion !== row.bundleModelVersion ||
        modelPayload?.featureVersion !== row.bundleFeatureVersion ||
        timestamp(modelPayload?.trainingCutoffAt as string | undefined) !== trainedMs
      ) {
        rowIssues.push({
          code: "MODEL_BUNDLE_PAYLOAD_MISMATCH",
          inputId: row.inputId,
          kind: row.kind,
          detail: "Model payload version/training boundary must match its authoritative PIT sidecars.",
        });
      }
    }
    if (rowIssues.length) {
      issues.push(...rowIssues);
      continue;
    }
    candidateInputs.push(row);
  }

  candidateInputs.sort((a, b) => {
    const byTime = (timestamp(a.availableAt) ?? 0) - (timestamp(b.availableAt) ?? 0);
    return byTime || a.inputId.localeCompare(b.inputId);
  });
  excludedPostCutoffInputIds.sort();

  const fixtureRows = candidateInputs.filter((row) => row.kind === "fixture_metadata");
  const excludedSupersededInputIds: string[] = [];
  let effectiveInputs = candidateInputs;
  if (fixtureRows.length) {
    const latestFixtureTime = Math.max(
      ...fixtureRows.map((row) => timestamp(row.availableAt) as number)
    );
    const latestFixtureRows = fixtureRows.filter(
      (row) => timestamp(row.availableAt) === latestFixtureTime
    );
    const knownKickoffs = new Set(latestFixtureRows.map((row) => row.kickoffAtAsKnown));
    const knownPayloads = new Set(latestFixtureRows.map((row) => row.contentHash));
    if (knownKickoffs.size !== 1 || knownPayloads.size !== 1) {
      issues.push({
        code: "FIXTURE_METADATA_AMBIGUOUS_AT_CUTOFF",
        kind: "fixture_metadata",
        detail: "Latest fixture observations at cutoff disagree on kickoff or canonical payload.",
      });
    } else if (latestFixtureRows[0]?.kickoffAtAsKnown !== normalizedRequest.kickoffAtAsKnown) {
      issues.push({
        code: "KICKOFF_AS_KNOWN_MISMATCH",
        inputId: latestFixtureRows[0]?.inputId,
        kind: "fixture_metadata",
        detail: "Request kickoffAtAsKnown does not match the latest admissible fixture observation.",
      });
    }
    const latestIds = new Set(latestFixtureRows.map((row) => row.inputId));
    for (const row of fixtureRows) {
      if (!latestIds.has(row.inputId)) excludedSupersededInputIds.push(row.inputId);
    }
    effectiveInputs = candidateInputs.filter(
      (row) => row.kind !== "fixture_metadata" || latestIds.has(row.inputId)
    );
  }

  const modelRows = effectiveInputs.filter((row) => row.kind === "model_parameters");
  if (modelRows.length > 1) {
    issues.push({
      code: "MODEL_BUNDLE_AMBIGUOUS_AT_CUTOFF",
      kind: "model_parameters",
      detail: "Exactly one frozen model bundle may be admissible at cutoff.",
    });
  }

  const requiredKinds = [
    ...new Set([
      "fixture_metadata",
      "model_parameters",
      ...input.requiredInputKinds.map((kind) => kind.trim()),
    ]),
  ]
    .filter(Boolean)
    .sort();
  const includedKinds = new Set(effectiveInputs.map((row) => row.kind));
  for (const kind of requiredKinds) {
    if (!includedKinds.has(kind)) {
      issues.push({
        code: "REQUIRED_INPUT_KIND_MISSING_AT_CUTOFF",
        kind,
        detail: `No admissible ${kind} input exists at or before cutoffAt.`,
      });
    }
  }

  const includedInputs = effectiveInputs.map((row) =>
    deepFreeze(cloneJson(row))
  );
  const maxInputAvailableAt = includedInputs.length
    ? new Date(
        Math.max(...includedInputs.map((row) => timestamp(row.availableAt) as number))
      ).toISOString()
    : null;
  excludedSupersededInputIds.sort();

  const replayKey = digest({
    track: HISTORICAL_REPLAY_TRACK,
    fixtureId: normalizedRequest.fixtureId,
    forecastStage: normalizedRequest.forecastStage,
    cutoffAt: normalizedRequest.cutoffAt,
    kickoffAtAsKnown: normalizedRequest.kickoffAtAsKnown,
    modelVersion: normalizedRequest.modelVersion,
    featureVersion: normalizedRequest.featureVersion,
    codeVersion: normalizedRequest.codeVersion,
    inputs: includedInputs.map((row) => ({
      inputId: row.inputId,
      kind: row.kind,
      sourceId: row.sourceId,
      availableAt: row.availableAt,
      classification: row.classification,
      contentHash: row.contentHash,
      payloadDigest: canonicalPayloadHash(row.payload),
      subjectFixtureId: row.subjectFixtureId ?? null,
      kickoffAtAsKnown: row.kickoffAtAsKnown ?? null,
      bundleModelVersion: row.bundleModelVersion ?? null,
      bundleFeatureVersion: row.bundleFeatureVersion ?? null,
      trainingCutoffAt: row.trainingCutoffAt ?? null,
    })),
  });

  return deepFreeze({
    track: HISTORICAL_REPLAY_TRACK,
    admissible: issues.length === 0,
    request: normalizedRequest,
    replayKey,
    includedInputs,
    maxInputAvailableAt,
    excludedPostCutoffInputIds,
    excludedSupersededInputIds,
    issues,
  });
}

function validateProbabilities(probabilities: HistoricalReplayProbabilities): void {
  const values = [probabilities.home, probabilities.draw, probabilities.away];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Replay probabilities must be finite values in [0, 1].");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`Replay probabilities must sum to 1 (observed ${total}).`);
  }
}

/**
 * Run a callback from the admitted, deep-frozen input slice. The returned
 * artifact is explicitly HISTORICAL_REPLAY and has no production-ledger
 * persistence path. The callback itself must be separately audited before a
 * performance replay because JavaScript closures can access external state.
 */
export function runHistoricalReplay(input: {
  request: HistoricalReplayRequest;
  inputs: readonly PitReplayInput[];
  requiredInputKinds: readonly string[];
  actualResult?: HistoricalReplayArtifact["actualResult"];
  predict: (inputs: readonly PitReplayInput[]) => HistoricalReplayProbabilities;
}): HistoricalReplayArtifact {
  const admission = prepareHistoricalReplay(input);
  if (!admission.admissible) {
    throw new Error(
      `HISTORICAL BACKTEST NOT YET ADMISSIBLE: ${admission.issues
        .map((issue) => issue.code)
        .join(", ")}`
    );
  }
  const predicted = input.predict(admission.includedInputs);
  validateProbabilities(predicted);
  const probabilities: HistoricalReplayProbabilities = deepFreeze({ ...predicted });

  const predictionDigest = digest({
    replayKey: admission.replayKey,
    probabilities,
  });
  return deepFreeze({
    track: HISTORICAL_REPLAY_TRACK,
    replayKey: admission.replayKey,
    fixtureId: admission.request.fixtureId,
    modelVersion: admission.request.modelVersion,
    stage: admission.request.forecastStage,
    cutoffAt: admission.request.cutoffAt,
    kickoffAtAsKnown: admission.request.kickoffAtAsKnown,
    replayExecutedAt: admission.request.replayExecutedAt,
    maxInputAvailableAt: admission.maxInputAvailableAt as string,
    sourceIds: [...new Set(admission.includedInputs.map((row) => row.sourceId))].sort(),
    sourceAvailableAt: admission.includedInputs.map((row) => ({
      inputId: row.inputId,
      sourceId: row.sourceId,
      availableAt: row.availableAt as string,
    })),
    inputLineage: admission.includedInputs.map((row) => ({
      inputId: row.inputId,
      kind: row.kind,
      sourceId: row.sourceId,
      availableAt: row.availableAt as string,
      contentHash: row.contentHash as string,
      classification: row.classification,
      payloadDigest: canonicalPayloadHash(row.payload),
      subjectFixtureId: row.subjectFixtureId ?? null,
      kickoffAtAsKnown: row.kickoffAtAsKnown ?? null,
      bundleModelVersion: row.bundleModelVersion ?? null,
      bundleFeatureVersion: row.bundleFeatureVersion ?? null,
      trainingCutoffAt: row.trainingCutoffAt ?? null,
    })),
    featureVersion: input.request.featureVersion,
    codeVersion: input.request.codeVersion,
    probabilities,
    actualResult: input.actualResult ?? null,
    predictionDigest,
  });
}
