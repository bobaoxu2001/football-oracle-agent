import type { CanonicalJsonValue, Sha256Hash } from "./canonical";

export const PROVENANCE_SCHEMA_VERSION = "pl-provenance-v1" as const;
export const PROVENANCE_TEMPORAL_RULE =
  "max(input.availableAt) <= cutoffAt <= generatedAt < kickoffAtAsKnown" as const;

export const PROVENANCE_RECORD_KINDS = [
  "FIXTURE_REVISION",
  "RESULT_REVISION",
  "RESULT_CORRECTION",
  "SEASON_MEMBERSHIP",
  "RATING_STATE",
  "MODEL_BUNDLE",
  "FORECAST_INPUT_MANIFEST",
] as const;

export type ProvenanceRecordKind = (typeof PROVENANCE_RECORD_KINDS)[number];

export type ForecastLineageStatus =
  | "PIT_VERIFIED"
  | "PIT_INCOMPLETE"
  | "LEGACY_UNAVAILABLE"
  | "INVALID_STAGE_TIMING";

/** Compact immutable pointer to source bytes retained elsewhere. */
export interface SourceObservationReference {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceVersion: string | null;
  readonly observationId: string;
  readonly publishedAt: string | null;
  readonly availableAt: string;
  readonly retrievedAt: string | null;
  readonly payloadHash: Sha256Hash;
}

export interface FixtureRevisionRecord {
  readonly recordKind: "FIXTURE_REVISION";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly fixtureRevisionId: string;
  readonly competition: "premier-league";
  readonly season: string;
  readonly fixtureId: string;
  readonly homeSlug: string;
  readonly awaySlug: string;
  readonly kickoffAt: string;
  readonly kickoffCertainty: string | null;
  readonly status: string;
  readonly venue: string | null;
  readonly availableAt: string;
  readonly sourceObservation: SourceObservationReference;
  readonly supersedesFixtureRevisionId: string | null;
  readonly fixturePayloadHash: Sha256Hash;
}

export interface ResultRevisionRecord {
  readonly recordKind: "RESULT_REVISION";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly resultRevisionId: string;
  readonly competition: "premier-league";
  readonly season: string;
  readonly fixtureId: string;
  readonly status: string;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
  readonly availableAt: string;
  readonly sourceObservation: SourceObservationReference;
  readonly supersedesResultRevisionId: string | null;
  readonly resultPayloadHash: Sha256Hash;
}

export interface ResultCorrectionLink {
  readonly recordKind: "RESULT_CORRECTION";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly correctionId: string;
  readonly fixtureId: string;
  readonly previousResultRevisionId: string;
  readonly correctedResultRevisionId: string;
  readonly detectedAt: string;
  readonly availableAt: string;
  readonly correctionPayloadHash: Sha256Hash;
}

export interface SeasonMembershipSnapshot {
  readonly recordKind: "SEASON_MEMBERSHIP";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly seasonMembershipSnapshotId: string;
  readonly competition: "premier-league";
  readonly season: string;
  readonly teamSlugs: readonly string[];
  readonly availableAt: string;
  readonly sourceObservations: readonly SourceObservationReference[];
  readonly membershipPayloadHash: Sha256Hash;
  /**
   * Additive Phase 4A4 verification proof. Legacy snapshots intentionally omit
   * these fields and remain integrity-readable, but are not production-ready.
   */
  readonly verificationStatus?: "VERIFIED" | "SOURCE_CONFLICT" | "PROVISIONAL" | "STALE";
  readonly verifiedAt?: string;
  readonly verifiedAgainst?: readonly string[];
  readonly verificationArtifact?: string;
}

export interface VerifiedSeasonMembershipSnapshot extends SeasonMembershipSnapshot {
  readonly verificationStatus: "VERIFIED";
  readonly verifiedAt: string;
  readonly verifiedAgainst: readonly string[];
  readonly verificationArtifact: string;
}

export interface RatingEventReference {
  readonly ratingEventId: string;
  readonly fixtureId: string;
  readonly fixtureKickoff: string;
  readonly appliedAt: string;
  readonly availableAt: string;
  readonly payloadHash: Sha256Hash;
  /** Null is an honest legacy boundary; never manufacture a result revision. */
  readonly resultRevisionId: string | null;
  /**
   * Phase 4A4 prospective lineage. These fields are absent on legacy events;
   * their absence must never be interpreted as verified result lineage.
   */
  readonly resultPayloadHash?: Sha256Hash;
  readonly resultAvailableAt?: string;
  readonly fixtureRevisionId?: string;
  readonly fixturePayloadHash?: Sha256Hash;
  readonly ratingUpdateInputs?: RatingUpdateInputs;
}

export interface RatingUpdateInputs {
  readonly homeSlug: string;
  readonly awaySlug: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly venue: "home" | "neutral";
  readonly preHome: number;
  readonly preAway: number;
  readonly preHomeMatches: number;
  readonly preAwayMatches: number;
  readonly postHome: number;
  readonly postAway: number;
  readonly postHomeMatches: number;
  readonly postAwayMatches: number;
  readonly formulaVersion: string;
  readonly modelVersion: string;
  /** The append-only operational verification event that admitted this fixture. */
  readonly verificationEventId: string;
}

export type RatingResultLineageStatus =
  | "VERIFIED"
  | "LEGACY_LINEAGE_INCOMPLETE";

export interface FrozenRatingStatePayload {
  readonly season: string;
  readonly clubSlugs: readonly string[];
  readonly ratings: Readonly<Record<string, number>>;
  readonly matchesPlayedSeason: Readonly<Record<string, number>>;
}

export interface FrozenRatingStateSnapshot {
  readonly recordKind: "RATING_STATE";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly ratingStateId: string;
  readonly competition: "premier-league";
  readonly season: string;
  readonly asOf: string;
  readonly availableAt: string;
  readonly modelVersion: string;
  readonly formulaVersion: string;
  readonly seasonMembershipSnapshotId: string;
  readonly ratingEvents: readonly RatingEventReference[];
  readonly state: FrozenRatingStatePayload;
  readonly ratingStateHash: Sha256Hash;
  /**
   * Additive Phase 4A4 fields. Old immutable states omit them and are
   * classified as LEGACY_LINEAGE_INCOMPLETE without being rewritten.
   */
  readonly ratingResultLineageStatus?: RatingResultLineageStatus;
  readonly orderedRatingEventIds?: readonly string[];
  readonly orderedResultRevisionIds?: readonly string[];
  readonly featureCodeVersion?: string;
  readonly codeCommitSha?: string;
  readonly ratingStateContentHash?: Sha256Hash;
}

export interface ImmutableModelBundle {
  readonly recordKind: "MODEL_BUNDLE";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly modelBundleId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly trainingCutoff: string;
  readonly parameterPayload: CanonicalJsonValue;
  readonly parameterHash: Sha256Hash;
  readonly featureSchemaVersion: string;
  readonly featureCodeVersion: string;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly codeCommitSha: string;
  readonly modelBundleHash: Sha256Hash;
}

export interface ForecastInputManifest {
  readonly recordKind: "FORECAST_INPUT_MANIFEST";
  readonly schemaVersion: typeof PROVENANCE_SCHEMA_VERSION;
  readonly manifestId: string;
  readonly fixtureId: string;
  readonly competition: "premier-league";
  readonly season: string;
  readonly forecastStage: string;
  readonly cutoffAt: string;
  readonly generatedAt: string;
  readonly kickoffAtAsKnown: string;
  readonly fixtureRevisionId: string;
  readonly fixtureRevisionHash: Sha256Hash;
  readonly fixtureRevisionAvailableAt: string;
  readonly seasonMembershipSnapshotId: string;
  readonly membershipPayloadHash: Sha256Hash;
  readonly seasonMembershipAvailableAt: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelBundleId: string;
  readonly modelBundleHash: Sha256Hash;
  readonly modelBundleAvailableAt: string;
  readonly modelTrainingCutoff: string;
  readonly featureSchemaVersion: string;
  readonly featureCodeVersion: string;
  readonly applicationCommitSha: string;
  readonly ratingStateId: string;
  readonly ratingStateHash: Sha256Hash;
  readonly ratingStateAvailableAt: string;
  readonly ratingResultLineageStatus?: "VERIFIED";
  readonly ratingResultRevisionIds?: readonly string[];
  readonly sourceObservations: readonly SourceObservationReference[];
  readonly ratingEvents: readonly RatingEventReference[];
  readonly latestIncludedInputAt: string;
  readonly temporalRule: typeof PROVENANCE_TEMPORAL_RULE;
  readonly inputLineageStatus: "PIT_VERIFIED";
  readonly manifestPayloadHash: Sha256Hash;
}

export type ProvenanceRecord =
  | FixtureRevisionRecord
  | ResultRevisionRecord
  | ResultCorrectionLink
  | SeasonMembershipSnapshot
  | FrozenRatingStateSnapshot
  | ImmutableModelBundle
  | ForecastInputManifest;

export interface SourceObservationReferenceInput {
  sourceType: string;
  sourceId: string;
  sourceVersion?: string | null;
  observationId: string;
  publishedAt?: string | null;
  availableAt: string;
  retrievedAt?: string | null;
  payload: unknown;
}

export interface FixtureRevisionInput {
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffAt: string;
  kickoffCertainty?: string | null;
  status: string;
  venue?: string | null;
  sourceObservation: SourceObservationReference;
  supersedesFixtureRevisionId?: string | null;
}

export interface ResultRevisionInput {
  season: string;
  fixtureId: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  sourceObservation: SourceObservationReference;
  supersedesResultRevisionId?: string | null;
}

export interface ResultCorrectionInput {
  fixtureId: string;
  previousResultRevisionId: string;
  correctedResultRevisionId: string;
  detectedAt: string;
  availableAt: string;
}

export interface SeasonMembershipSnapshotInput {
  season: string;
  teamSlugs: readonly string[];
  sourceObservations: readonly SourceObservationReference[];
  verificationStatus?: "VERIFIED" | "SOURCE_CONFLICT" | "PROVISIONAL" | "STALE";
  verifiedAt?: string;
  verifiedAgainst?: readonly string[];
  verificationArtifact?: string;
}

export interface RatingEventReferenceInput {
  ratingEventId: string;
  fixtureId: string;
  fixtureKickoff: string;
  appliedAt: string;
  availableAt?: string;
  payload: unknown;
  resultRevisionId?: string | null;
  resultPayloadHash?: Sha256Hash;
  resultAvailableAt?: string;
  fixtureRevisionId?: string;
  fixturePayloadHash?: Sha256Hash;
  ratingUpdateInputs?: RatingUpdateInputs;
}

export interface FrozenRatingStateSnapshotInput {
  season: string;
  asOf: string;
  availableAt: string;
  modelVersion: string;
  formulaVersion: string;
  seasonMembershipSnapshotId: string;
  ratingEvents: readonly RatingEventReference[];
  state: FrozenRatingStatePayload;
  ratingResultLineageStatus?: RatingResultLineageStatus;
  orderedRatingEventIds?: readonly string[];
  orderedResultRevisionIds?: readonly string[];
  featureCodeVersion?: string;
  codeCommitSha?: string;
}

export interface ImmutableModelBundleInput {
  modelId: string;
  modelVersion: string;
  trainingCutoff: string;
  parameterPayload: unknown;
  featureSchemaVersion: string;
  featureCodeVersion: string;
  createdAt: string;
  availableAt: string;
  codeCommitSha: string;
}

export interface ForecastInputManifestInput {
  fixtureId: string;
  season: string;
  forecastStage: string;
  cutoffAt: string;
  generatedAt: string;
  kickoffAtAsKnown: string;
  applicationCommitSha: string;
  fixtureRevision: FixtureRevisionRecord;
  seasonMembership: SeasonMembershipSnapshot;
  ratingState: FrozenRatingStateSnapshot;
  modelBundle: ImmutableModelBundle;
  /** Exact child records traversed by every prospective rating event. */
  ratingResultRevisions?: readonly ResultRevisionRecord[];
  ratingFixtureRevisions?: readonly FixtureRevisionRecord[];
  /** Additional immutable observations directly consumed by feature assembly. */
  sourceObservations?: readonly SourceObservationReference[];
}

export interface ManifestReferenceSet {
  fixtureRevision: FixtureRevisionRecord;
  seasonMembership: SeasonMembershipSnapshot;
  ratingState: FrozenRatingStateSnapshot;
  modelBundle: ImmutableModelBundle;
  /** Optional in the TypeScript shape only for legacy serialized snapshots. */
  ratingResultRevisions?: readonly ResultRevisionRecord[];
  ratingFixtureRevisions?: readonly FixtureRevisionRecord[];
}
