/**
 * Phase 4B match-context contracts.
 *
 * This is an observational evidence envelope. It is deliberately separate
 * from prediction math: admitting an item to a context does not mean the
 * production model consumed it. That relationship is recorded explicitly by
 * `usedInForecast` against one exact forecast snapshot key.
 */

export const MATCH_CONTEXT_SCHEMA_VERSION = "pl-match-context-v1" as const;
export const MATCH_CONTEXT_TEMPORAL_RULE = "availableAt <= cutoffAt" as const;

export const MATCH_CONTEXT_EVIDENCE_KINDS = [
  "FIXTURE",
  "TEAM_NEWS",
  "SQUAD_AVAILABILITY",
  "LINEUP",
  "TACTICAL_CONTEXT",
] as const;

export type MatchContextEvidenceKind = (typeof MATCH_CONTEXT_EVIDENCE_KINDS)[number];

export const LINEUP_STATUSES = [
  "NONE",
  "EXPECTED",
  "CONFIRMED",
] as const;

export type LineupStatus = (typeof LINEUP_STATUSES)[number];
export type LineupEvidenceStatus = Exclude<LineupStatus, "NONE">;
export type OverallLineupStatus = LineupStatus | "PARTIAL";

export const AVAILABILITY_STATUSES = [
  "AVAILABLE",
  "EXPECTED_AVAILABLE",
  "DOUBTFUL",
  "OUT",
  "SUSPENDED",
  "UNKNOWN",
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface MatchContextSourceInput {
  /** Stable provider/system name, for example `the-odds-api`. */
  name: string;
  /** Stable record identity within that source. */
  recordId: string;
  /** Optional human-auditable source location. */
  url?: string | null;
}

export interface MatchContextSource {
  readonly name: string;
  readonly recordId: string;
  readonly url: string | null;
}

export interface MatchContextEvidenceInput {
  fixtureId: string;
  kind: MatchContextEvidenceKind;
  /** Stable subject identity: fixture, team, or player/provider entity. */
  entityId: string;
  /** Null for match-wide evidence; otherwise it must be one of the two teams. */
  teamSlug?: string | null;
  /** Time represented by the source record. */
  observedAt: string;
  /** Time the raw record reached this system. */
  fetchedAt: string;
  /** First instant this exact evidence was available to the system. */
  availableAt: string;
  /** Source/normalizer confidence only; never a forecast probability. */
  confidence: number;
  /** SHA-256 of the retained raw source bytes. */
  rawEvidenceHash: string;
  source: MatchContextSourceInput;
  payload: JsonValue;
  /** Explicit relation to `forecastSnapshotKey`; never inferred from kind. */
  usedInForecast: boolean;
  /** Required only for LINEUP evidence. NONE is derived, never ingested. */
  lineupStatus?: LineupEvidenceStatus | null;
  /** Required only for SQUAD_AVAILABILITY evidence. */
  availabilityStatus?: AvailabilityStatus | null;
}

export interface MatchContextEvidence {
  /** SHA-256 address of evidence content. `usedInForecast` is relational metadata. */
  readonly evidenceId: string;
  readonly fixtureId: string;
  readonly kind: MatchContextEvidenceKind;
  readonly entityId: string;
  readonly teamSlug: string | null;
  readonly observedAt: string;
  readonly fetchedAt: string;
  readonly availableAt: string;
  readonly confidence: number;
  readonly rawEvidenceHash: string;
  readonly source: MatchContextSource;
  readonly payload: JsonValue;
  readonly usedInForecast: boolean;
  readonly lineupStatus: LineupEvidenceStatus | null;
  readonly availabilityStatus: AvailabilityStatus | null;
}

export interface TeamLineupContext {
  readonly teamSlug: string;
  readonly status: LineupStatus;
  readonly evidenceId: string | null;
  readonly availableAt: string | null;
  readonly usedInForecast: boolean;
}

export interface MatchLineupContext {
  readonly home: TeamLineupContext;
  readonly away: TeamLineupContext;
  /** Both sides agree on status, otherwise PARTIAL. */
  readonly overall: OverallLineupStatus;
}

export interface EntityAvailabilityContext {
  readonly entityId: string;
  readonly status: AvailabilityStatus;
  readonly evidenceId: string;
  readonly availableAt: string;
  readonly confidence: number;
  readonly usedInForecast: boolean;
}

export type AvailabilityStatusCounts = Readonly<Record<AvailabilityStatus, number>>;

export interface TeamAvailabilityContext {
  readonly teamSlug: string;
  readonly entities: readonly EntityAvailabilityContext[];
  readonly statusCounts: AvailabilityStatusCounts;
  readonly latestAvailableAt: string | null;
}

export interface MatchAvailabilityContext {
  readonly home: TeamAvailabilityContext;
  readonly away: TeamAvailabilityContext;
}

export interface MatchContextSnapshot {
  /** SHA-256 address of every immutable field below except contextId itself. */
  readonly contextId: string;
  readonly schemaVersion: typeof MATCH_CONTEXT_SCHEMA_VERSION;
  readonly competition: "premier-league";
  readonly season: string;
  readonly fixtureId: string;
  readonly homeSlug: string;
  readonly awaySlug: string;
  /** Kickoff identity this context was assembled for; a reschedule creates a new context. */
  readonly kickoffAt: string;
  readonly cutoffAt: string;
  /** Audit metadata, excluded from contextId so an identical retry has one address. */
  readonly generatedAt: string;
  /** Exact forecast this usage annotation describes, or null when purely observational. */
  readonly forecastSnapshotKey: string | null;
  readonly temporalRule: typeof MATCH_CONTEXT_TEMPORAL_RULE;
  readonly evidence: readonly MatchContextEvidence[];
  readonly usedInForecastEvidenceIds: readonly string[];
  readonly lineup: MatchLineupContext;
  readonly availability: MatchAvailabilityContext;
}

export interface AssembleMatchContextInput {
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffAt: string;
  cutoffAt: string;
  generatedAt: string;
  /** Must be explicitly null when the context is not bound to a forecast. */
  forecastSnapshotKey: string | null;
  evidence: readonly MatchContextEvidenceInput[];
}

export interface MatchContextBuildDiagnostics {
  readonly candidateEvidenceCount: number;
  readonly admittedEvidenceCount: number;
  /** Deliberately kept outside the immutable snapshot to prevent future-data leakage. */
  readonly excludedAfterCutoffEvidenceIds: readonly string[];
  readonly duplicateEvidenceIds: readonly string[];
}

export interface MatchContextBuildResult {
  readonly snapshot: MatchContextSnapshot;
  readonly diagnostics: MatchContextBuildDiagnostics;
}

export interface ForecastUsageChange {
  readonly evidenceId: string;
  readonly kind: MatchContextEvidenceKind;
  readonly before: boolean;
  readonly after: boolean;
}

export interface LineupContextChange {
  readonly side: "home" | "away";
  readonly teamSlug: string;
  readonly before: TeamLineupContext;
  readonly after: TeamLineupContext;
}

export interface AvailabilityContextChange {
  readonly side: "home" | "away";
  readonly teamSlug: string;
  readonly entityId: string;
  readonly before: EntityAvailabilityContext | null;
  readonly after: EntityAvailabilityContext | null;
}

export interface MatchContextDiff {
  readonly fixtureId: string;
  readonly fromContextId: string;
  readonly toContextId: string;
  readonly fromCutoffAt: string;
  readonly toCutoffAt: string;
  readonly addedEvidence: readonly MatchContextEvidence[];
  readonly removedEvidence: readonly MatchContextEvidence[];
  readonly forecastUsageChanges: readonly ForecastUsageChange[];
  readonly lineupChanges: readonly LineupContextChange[];
  readonly availabilityChanges: readonly AvailabilityContextChange[];
  readonly kickoffChanged: { readonly before: string; readonly after: string } | null;
  readonly forecastReferenceChanged: {
    readonly before: string | null;
    readonly after: string | null;
  } | null;
  readonly causalAttribution: "not-established";
  readonly causalNote: string;
}
