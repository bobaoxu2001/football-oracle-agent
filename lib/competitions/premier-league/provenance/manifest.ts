import {
  assertCanonicalTimestamp,
  canonicalJson,
  canonicalSha256,
  cloneFrozen,
  contentAddress,
  latestTimestamp,
  normalizeCanonicalJson,
  normalizeSha256,
  normalizeTimestamp,
  requireNonEmpty,
  timestampMillis,
  type CanonicalJsonValue,
} from "./canonical";
import {
  PROVENANCE_SCHEMA_VERSION,
  PROVENANCE_TEMPORAL_RULE,
  type FixtureRevisionInput,
  type FixtureRevisionRecord,
  type ForecastInputManifest,
  type ForecastInputManifestInput,
  type ForecastLineageStatus,
  type FrozenRatingStatePayload,
  type FrozenRatingStateSnapshot,
  type FrozenRatingStateSnapshotInput,
  type ImmutableModelBundle,
  type ImmutableModelBundleInput,
  type ManifestReferenceSet,
  type ProvenanceRecord,
  type RatingEventReference,
  type RatingEventReferenceInput,
  type ResultCorrectionInput,
  type ResultCorrectionLink,
  type ResultRevisionInput,
  type ResultRevisionRecord,
  type SeasonMembershipSnapshot,
  type SeasonMembershipSnapshotInput,
  type SourceObservationReference,
  type SourceObservationReferenceInput,
} from "./types";

function commitSha(value: unknown, label: string): string {
  const normalized = requireNonEmpty(value, label).toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(normalized)) {
    throw new Error(`${label} must be a 7-64 character hexadecimal commit SHA`);
  }
  return normalized;
}

function nullableNonEmpty(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requireNonEmpty(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, label);
}

function assertNoLater(left: string, right: string, detail: string): void {
  if (Date.parse(left) > Date.parse(right)) throw new Error(detail);
}

function assertBefore(left: string, right: string, detail: string): void {
  if (Date.parse(left) >= Date.parse(right)) throw new Error(detail);
}

function uniqueSortedStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || !values.length) throw new Error(`${label} must not be empty`);
  const normalized = values.map((value, index) => requireNonEmpty(value, `${label}[${index}]`));
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error(`${label} contains duplicates`);
  return unique;
}

function normalizeSourceReference(
  source: SourceObservationReference,
  label = "source observation"
): SourceObservationReference {
  const publishedAt = nullableTimestamp(source.publishedAt, `${label}.publishedAt`);
  const availableAt = normalizeTimestamp(source.availableAt, `${label}.availableAt`);
  const retrievedAt = nullableTimestamp(source.retrievedAt, `${label}.retrievedAt`);
  if (publishedAt) {
    assertNoLater(
      publishedAt,
      availableAt,
      `${label}.publishedAt must not be after availableAt`
    );
  }
  if (retrievedAt) {
    assertNoLater(
      retrievedAt,
      availableAt,
      `${label}.retrievedAt must not be after availableAt`
    );
  }
  return cloneFrozen({
    sourceType: requireNonEmpty(source.sourceType, `${label}.sourceType`),
    sourceId: requireNonEmpty(source.sourceId, `${label}.sourceId`),
    sourceVersion: nullableNonEmpty(source.sourceVersion, `${label}.sourceVersion`),
    observationId: requireNonEmpty(source.observationId, `${label}.observationId`),
    publishedAt,
    availableAt,
    retrievedAt,
    payloadHash: normalizeSha256(source.payloadHash, `${label}.payloadHash`),
  });
}

function uniqueSourceReferences(
  sources: readonly SourceObservationReference[],
  label = "sourceObservations"
): SourceObservationReference[] {
  const byId = new Map<string, SourceObservationReference>();
  for (let index = 0; index < sources.length; index += 1) {
    const source = normalizeSourceReference(sources[index], `${label}[${index}]`);
    const existing = byId.get(source.observationId);
    if (existing && canonicalJson(existing) !== canonicalJson(source)) {
      throw new Error(
        `${label} reuses observationId ${source.observationId} with different content`
      );
    }
    if (!existing) byId.set(source.observationId, source);
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.availableAt.localeCompare(b.availableAt) ||
      a.observationId.localeCompare(b.observationId)
  );
}

export function buildSourceObservationReference(
  input: SourceObservationReferenceInput
): SourceObservationReference {
  return normalizeSourceReference({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion ?? null,
    observationId: input.observationId,
    publishedAt: input.publishedAt ?? null,
    availableAt: input.availableAt,
    retrievedAt: input.retrievedAt ?? null,
    payloadHash: canonicalSha256(input.payload),
  });
}

export function assertSourceObservationReference(
  source: SourceObservationReference
): void {
  const normalized = normalizeSourceReference(source);
  if (canonicalJson(normalized) !== canonicalJson(source)) {
    throw new Error("source observation reference is not canonically normalized");
  }
}

function fixturePayload(input: {
  competition: "premier-league";
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffAt: string;
  kickoffCertainty: string | null;
  status: string;
  venue: string | null;
}): CanonicalJsonValue {
  return normalizeCanonicalJson(input, "fixture payload");
}

export function buildFixtureRevision(input: FixtureRevisionInput): FixtureRevisionRecord {
  const season = requireNonEmpty(input.season, "fixture.season");
  const fixtureId = requireNonEmpty(input.fixtureId, "fixture.fixtureId");
  const homeSlug = requireNonEmpty(input.homeSlug, "fixture.homeSlug");
  const awaySlug = requireNonEmpty(input.awaySlug, "fixture.awaySlug");
  if (homeSlug === awaySlug) throw new Error("fixture homeSlug and awaySlug must differ");
  const kickoffAt = normalizeTimestamp(input.kickoffAt, "fixture.kickoffAt");
  const kickoffCertainty = nullableNonEmpty(
    input.kickoffCertainty,
    "fixture.kickoffCertainty"
  );
  const status = requireNonEmpty(input.status, "fixture.status");
  const venue = nullableNonEmpty(input.venue, "fixture.venue");
  const sourceObservation = normalizeSourceReference(input.sourceObservation);
  const availableAt = sourceObservation.availableAt;
  const supersedesFixtureRevisionId = nullableNonEmpty(
    input.supersedesFixtureRevisionId,
    "fixture.supersedesFixtureRevisionId"
  );
  const payload = fixturePayload({
    competition: "premier-league",
    season,
    fixtureId,
    homeSlug,
    awaySlug,
    kickoffAt,
    kickoffCertainty,
    status,
    venue,
  });
  const fixturePayloadHash = canonicalSha256(payload);
  const identity = {
    recordKind: "FIXTURE_REVISION" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    competition: "premier-league" as const,
    season,
    fixtureId,
    homeSlug,
    awaySlug,
    kickoffAt,
    kickoffCertainty,
    status,
    venue,
    availableAt,
    sourceObservation,
    supersedesFixtureRevisionId,
    fixturePayloadHash,
  };
  return cloneFrozen({
    ...identity,
    fixtureRevisionId: contentAddress("pl-fixture-revision", identity),
  });
}

export function assertFixtureRevisionIntegrity(record: FixtureRevisionRecord): void {
  const rebuilt = buildFixtureRevision({
    season: record.season,
    fixtureId: record.fixtureId,
    homeSlug: record.homeSlug,
    awaySlug: record.awaySlug,
    kickoffAt: record.kickoffAt,
    kickoffCertainty: record.kickoffCertainty,
    status: record.status,
    venue: record.venue,
    sourceObservation: record.sourceObservation,
    supersedesFixtureRevisionId: record.supersedesFixtureRevisionId,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(`fixture revision integrity mismatch: ${record.fixtureRevisionId}`);
  }
}

function score(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer or null`);
  }
  return value;
}

export function buildResultRevision(input: ResultRevisionInput): ResultRevisionRecord {
  const homeScore = score(input.homeScore, "result.homeScore");
  const awayScore = score(input.awayScore, "result.awayScore");
  if ((homeScore === null) !== (awayScore === null)) {
    throw new Error("result scores must either both be present or both be null");
  }
  const sourceObservation = normalizeSourceReference(input.sourceObservation);
  const payload = normalizeCanonicalJson(
    {
      competition: "premier-league",
      season: requireNonEmpty(input.season, "result.season"),
      fixtureId: requireNonEmpty(input.fixtureId, "result.fixtureId"),
      status: requireNonEmpty(input.status, "result.status"),
      homeScore,
      awayScore,
    },
    "result payload"
  );
  const base = payload as Extract<CanonicalJsonValue, Record<string, CanonicalJsonValue>>;
  const identity = {
    recordKind: "RESULT_REVISION" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    competition: "premier-league" as const,
    season: String(base.season),
    fixtureId: String(base.fixtureId),
    status: String(base.status),
    homeScore,
    awayScore,
    availableAt: sourceObservation.availableAt,
    sourceObservation,
    supersedesResultRevisionId: nullableNonEmpty(
      input.supersedesResultRevisionId,
      "result.supersedesResultRevisionId"
    ),
    resultPayloadHash: canonicalSha256(payload),
  };
  return cloneFrozen({
    ...identity,
    resultRevisionId: contentAddress("pl-result-revision", identity),
  });
}

export function assertResultRevisionIntegrity(record: ResultRevisionRecord): void {
  const rebuilt = buildResultRevision({
    season: record.season,
    fixtureId: record.fixtureId,
    status: record.status,
    homeScore: record.homeScore,
    awayScore: record.awayScore,
    sourceObservation: record.sourceObservation,
    supersedesResultRevisionId: record.supersedesResultRevisionId,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(`result revision integrity mismatch: ${record.resultRevisionId}`);
  }
}

export function buildResultCorrection(input: ResultCorrectionInput): ResultCorrectionLink {
  const previousResultRevisionId = requireNonEmpty(
    input.previousResultRevisionId,
    "correction.previousResultRevisionId"
  );
  const correctedResultRevisionId = requireNonEmpty(
    input.correctedResultRevisionId,
    "correction.correctedResultRevisionId"
  );
  if (previousResultRevisionId === correctedResultRevisionId) {
    throw new Error("a correction must link two different result revisions");
  }
  const detectedAt = normalizeTimestamp(input.detectedAt, "correction.detectedAt");
  const availableAt = normalizeTimestamp(input.availableAt, "correction.availableAt");
  assertNoLater(
    detectedAt,
    availableAt,
    "correction.detectedAt must not be after availableAt"
  );
  const payload = {
    fixtureId: requireNonEmpty(input.fixtureId, "correction.fixtureId"),
    previousResultRevisionId,
    correctedResultRevisionId,
    detectedAt,
    availableAt,
  };
  const correctionPayloadHash = canonicalSha256(payload);
  const identity = {
    recordKind: "RESULT_CORRECTION" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    ...payload,
    correctionPayloadHash,
  };
  return cloneFrozen({
    ...identity,
    correctionId: contentAddress("pl-result-correction", identity),
  });
}

export function assertResultCorrectionIntegrity(record: ResultCorrectionLink): void {
  const rebuilt = buildResultCorrection(record);
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(`result correction integrity mismatch: ${record.correctionId}`);
  }
}

export function buildSeasonMembershipSnapshot(
  input: SeasonMembershipSnapshotInput
): SeasonMembershipSnapshot {
  const teamSlugs = uniqueSortedStrings(input.teamSlugs, "membership.teamSlugs");
  const sourceObservations = uniqueSourceReferences(input.sourceObservations);
  if (!sourceObservations.length) {
    throw new Error("membership requires at least one immutable source observation");
  }
  const season = requireNonEmpty(input.season, "membership.season");
  const availableAt = latestTimestamp(
    sourceObservations.map((source) => source.availableAt),
    "membership source availability"
  );
  const membershipPayloadHash = canonicalSha256({
    competition: "premier-league",
    season,
    teamSlugs,
  });
  const identity = {
    recordKind: "SEASON_MEMBERSHIP" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    competition: "premier-league" as const,
    season,
    teamSlugs,
    availableAt,
    sourceObservations,
    membershipPayloadHash,
  };
  return cloneFrozen({
    ...identity,
    seasonMembershipSnapshotId: contentAddress("pl-season-membership", identity),
  });
}

export function assertSeasonMembershipIntegrity(record: SeasonMembershipSnapshot): void {
  const rebuilt = buildSeasonMembershipSnapshot({
    season: record.season,
    teamSlugs: record.teamSlugs,
    sourceObservations: record.sourceObservations,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(
      `season membership integrity mismatch: ${record.seasonMembershipSnapshotId}`
    );
  }
}

function normalizeRatingEvent(
  event: RatingEventReference,
  label = "rating event"
): RatingEventReference {
  const fixtureKickoff = normalizeTimestamp(event.fixtureKickoff, `${label}.fixtureKickoff`);
  const appliedAt = normalizeTimestamp(event.appliedAt, `${label}.appliedAt`);
  const availableAt = normalizeTimestamp(event.availableAt, `${label}.availableAt`);
  assertBefore(fixtureKickoff, appliedAt, `${label}.fixtureKickoff must be before appliedAt`);
  assertNoLater(appliedAt, availableAt, `${label}.appliedAt must not be after availableAt`);
  return cloneFrozen({
    ratingEventId: requireNonEmpty(event.ratingEventId, `${label}.ratingEventId`),
    fixtureId: requireNonEmpty(event.fixtureId, `${label}.fixtureId`),
    fixtureKickoff,
    appliedAt,
    availableAt,
    payloadHash: normalizeSha256(event.payloadHash, `${label}.payloadHash`),
    resultRevisionId: nullableNonEmpty(event.resultRevisionId, `${label}.resultRevisionId`),
  });
}

export function buildRatingEventReference(
  input: RatingEventReferenceInput
): RatingEventReference {
  return normalizeRatingEvent({
    ratingEventId: input.ratingEventId,
    fixtureId: input.fixtureId,
    fixtureKickoff: input.fixtureKickoff,
    appliedAt: input.appliedAt,
    availableAt: input.availableAt ?? input.appliedAt,
    payloadHash: canonicalSha256(input.payload),
    resultRevisionId: input.resultRevisionId ?? null,
  });
}

function uniqueRatingEvents(events: readonly RatingEventReference[]): RatingEventReference[] {
  const byId = new Map<string, RatingEventReference>();
  for (let index = 0; index < events.length; index += 1) {
    const event = normalizeRatingEvent(events[index], `ratingEvents[${index}]`);
    const existing = byId.get(event.ratingEventId);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) {
      throw new Error(
        `ratingEvents reuses ratingEventId ${event.ratingEventId} with different content`
      );
    }
    if (!existing) byId.set(event.ratingEventId, event);
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.fixtureKickoff.localeCompare(b.fixtureKickoff) ||
      a.ratingEventId.localeCompare(b.ratingEventId)
  );
}

function normalizeRatingState(state: FrozenRatingStatePayload): FrozenRatingStatePayload {
  const season = requireNonEmpty(state.season, "ratingState.state.season");
  const clubSlugs = uniqueSortedStrings(state.clubSlugs, "ratingState.state.clubSlugs");
  const clubs = new Set(clubSlugs);
  for (const key of Object.keys(state.ratings)) {
    if (!clubs.has(key)) throw new Error(`ratingState.ratings contains unknown club ${key}`);
  }
  for (const key of Object.keys(state.matchesPlayedSeason)) {
    if (!clubs.has(key)) {
      throw new Error(`ratingState.matchesPlayedSeason contains unknown club ${key}`);
    }
  }
  const ratings: Record<string, number> = {};
  const matchesPlayedSeason: Record<string, number> = {};
  for (const club of clubSlugs) {
    const rating = state.ratings[club];
    if (typeof rating !== "number" || !Number.isFinite(rating)) {
      throw new Error(`ratingState.ratings.${club} must be finite`);
    }
    const played = state.matchesPlayedSeason[club] ?? 0;
    if (!Number.isInteger(played) || played < 0) {
      throw new Error(`ratingState.matchesPlayedSeason.${club} must be a non-negative integer`);
    }
    ratings[club] = rating;
    matchesPlayedSeason[club] = played;
  }
  return cloneFrozen({ season, clubSlugs, ratings, matchesPlayedSeason });
}

export function buildFrozenRatingState(
  input: FrozenRatingStateSnapshotInput
): FrozenRatingStateSnapshot {
  const season = requireNonEmpty(input.season, "ratingState.season");
  const asOf = normalizeTimestamp(input.asOf, "ratingState.asOf");
  const availableAt = normalizeTimestamp(input.availableAt, "ratingState.availableAt");
  assertNoLater(availableAt, asOf, "ratingState.availableAt must not be after asOf");
  const state = normalizeRatingState(input.state);
  if (state.season !== season) throw new Error("rating state payload season mismatch");
  const ratingEvents = uniqueRatingEvents(input.ratingEvents);
  for (const event of ratingEvents) {
    assertBefore(
      event.fixtureKickoff,
      asOf,
      `rating event ${event.ratingEventId} kickoff must be before rating state asOf`
    );
    assertNoLater(
      event.appliedAt,
      asOf,
      `rating event ${event.ratingEventId} appliedAt is after rating state asOf`
    );
    assertNoLater(
      event.availableAt,
      asOf,
      `rating event ${event.ratingEventId} availableAt is after rating state asOf`
    );
  }
  const ratingStateHash = canonicalSha256(state);
  const identity = {
    recordKind: "RATING_STATE" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    competition: "premier-league" as const,
    season,
    asOf,
    availableAt,
    modelVersion: requireNonEmpty(input.modelVersion, "ratingState.modelVersion"),
    formulaVersion: requireNonEmpty(input.formulaVersion, "ratingState.formulaVersion"),
    seasonMembershipSnapshotId: requireNonEmpty(
      input.seasonMembershipSnapshotId,
      "ratingState.seasonMembershipSnapshotId"
    ),
    ratingEvents,
    state,
    ratingStateHash,
  };
  return cloneFrozen({
    ...identity,
    ratingStateId: contentAddress("pl-rating-state", identity),
  });
}

export function assertFrozenRatingStateIntegrity(record: FrozenRatingStateSnapshot): void {
  const rebuilt = buildFrozenRatingState({
    season: record.season,
    asOf: record.asOf,
    availableAt: record.availableAt,
    modelVersion: record.modelVersion,
    formulaVersion: record.formulaVersion,
    seasonMembershipSnapshotId: record.seasonMembershipSnapshotId,
    ratingEvents: record.ratingEvents,
    state: record.state,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(`rating state integrity mismatch: ${record.ratingStateId}`);
  }
}

export function buildImmutableModelBundle(
  input: ImmutableModelBundleInput
): ImmutableModelBundle {
  const trainingCutoff = normalizeTimestamp(input.trainingCutoff, "model.trainingCutoff");
  const createdAt = normalizeTimestamp(input.createdAt, "model.createdAt");
  const availableAt = normalizeTimestamp(input.availableAt, "model.availableAt");
  assertBefore(trainingCutoff, createdAt, "model.trainingCutoff must be before createdAt");
  assertNoLater(createdAt, availableAt, "model.createdAt must not be after availableAt");
  const parameterPayload = normalizeCanonicalJson(input.parameterPayload, "model.parameterPayload");
  const parameterHash = canonicalSha256(parameterPayload);
  const semantic = {
    recordKind: "MODEL_BUNDLE" as const,
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    modelId: requireNonEmpty(input.modelId, "model.modelId"),
    modelVersion: requireNonEmpty(input.modelVersion, "model.modelVersion"),
    trainingCutoff,
    parameterPayload,
    parameterHash,
    featureSchemaVersion: requireNonEmpty(
      input.featureSchemaVersion,
      "model.featureSchemaVersion"
    ),
    featureCodeVersion: requireNonEmpty(
      input.featureCodeVersion,
      "model.featureCodeVersion"
    ),
    createdAt,
    availableAt,
    codeCommitSha: commitSha(input.codeCommitSha, "model.codeCommitSha"),
  };
  const modelBundleHash = canonicalSha256(semantic);
  return cloneFrozen({
    ...semantic,
    modelBundleId: contentAddress("pl-model-bundle", semantic),
    modelBundleHash,
  });
}

export function assertImmutableModelBundleIntegrity(record: ImmutableModelBundle): void {
  const rebuilt = buildImmutableModelBundle({
    modelId: record.modelId,
    modelVersion: record.modelVersion,
    trainingCutoff: record.trainingCutoff,
    parameterPayload: record.parameterPayload,
    featureSchemaVersion: record.featureSchemaVersion,
    featureCodeVersion: record.featureCodeVersion,
    createdAt: record.createdAt,
    availableAt: record.availableAt,
    codeCommitSha: record.codeCommitSha,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error(`model bundle integrity mismatch: ${record.modelBundleId}`);
  }
}

function assertInputAtCutoff(availableAt: string, cutoffAt: string, label: string): void {
  assertNoLater(
    availableAt,
    cutoffAt,
    `${label}.availableAt ${availableAt} is after forecast cutoffAt ${cutoffAt}`
  );
}

function manifestPayload(
  manifest: Omit<ForecastInputManifest, "manifestId" | "manifestPayloadHash">
): CanonicalJsonValue {
  return normalizeCanonicalJson(manifest, "forecast input manifest");
}

export function buildForecastInputManifest(
  input: ForecastInputManifestInput
): ForecastInputManifest {
  assertFixtureRevisionIntegrity(input.fixtureRevision);
  assertSeasonMembershipIntegrity(input.seasonMembership);
  assertFrozenRatingStateIntegrity(input.ratingState);
  assertImmutableModelBundleIntegrity(input.modelBundle);

  const fixtureId = requireNonEmpty(input.fixtureId, "manifest.fixtureId");
  const season = requireNonEmpty(input.season, "manifest.season");
  const forecastStage = requireNonEmpty(input.forecastStage, "manifest.forecastStage");
  const cutoffAt = normalizeTimestamp(input.cutoffAt, "manifest.cutoffAt");
  const generatedAt = normalizeTimestamp(input.generatedAt, "manifest.generatedAt");
  const kickoffAtAsKnown = normalizeTimestamp(
    input.kickoffAtAsKnown,
    "manifest.kickoffAtAsKnown"
  );
  assertNoLater(cutoffAt, generatedAt, "manifest.cutoffAt must not be after generatedAt");
  assertBefore(
    generatedAt,
    kickoffAtAsKnown,
    "manifest.generatedAt must be strictly before kickoffAtAsKnown"
  );

  const fixture = input.fixtureRevision;
  const membership = input.seasonMembership;
  const ratingState = input.ratingState;
  const model = input.modelBundle;
  if (fixture.fixtureId !== fixtureId || fixture.season !== season) {
    throw new Error("manifest fixture revision does not match fixtureId/season");
  }
  if (fixture.kickoffAt !== kickoffAtAsKnown) {
    throw new Error("manifest kickoffAtAsKnown must equal the frozen fixture revision kickoff");
  }
  if (membership.season !== season) {
    throw new Error("manifest membership season mismatch");
  }
  if (!membership.teamSlugs.includes(fixture.homeSlug) || !membership.teamSlugs.includes(fixture.awaySlug)) {
    throw new Error("manifest membership does not contain both fixture teams");
  }
  if (ratingState.season !== season) throw new Error("manifest rating state season mismatch");
  if (ratingState.seasonMembershipSnapshotId !== membership.seasonMembershipSnapshotId) {
    throw new Error("rating state references a different season membership snapshot");
  }
  if (ratingState.modelVersion !== model.modelVersion) {
    throw new Error("rating state and model bundle versions disagree");
  }
  assertNoLater(ratingState.asOf, cutoffAt, "ratingState.asOf must not be after cutoffAt");
  assertBefore(model.trainingCutoff, cutoffAt, "model trainingCutoff must be before cutoffAt");

  const sourceObservations = uniqueSourceReferences([
    fixture.sourceObservation,
    ...membership.sourceObservations,
    ...(input.sourceObservations ?? []),
  ]);
  const ratingEvents = uniqueRatingEvents(ratingState.ratingEvents);
  const availability = [
    fixture.availableAt,
    membership.availableAt,
    ratingState.availableAt,
    model.availableAt,
    ...sourceObservations.map((source) => source.availableAt),
    ...ratingEvents.map((event) => event.availableAt),
  ];
  for (const [index, availableAt] of availability.entries()) {
    assertInputAtCutoff(availableAt, cutoffAt, `manifest input[${index}]`);
  }
  const latestIncludedInputAt = latestTimestamp(availability, "manifest input availability");

  const payloadWithoutIdentity: Omit<
    ForecastInputManifest,
    "manifestId" | "manifestPayloadHash"
  > = {
    recordKind: "FORECAST_INPUT_MANIFEST",
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    fixtureId,
    competition: "premier-league",
    season,
    forecastStage,
    cutoffAt,
    generatedAt,
    kickoffAtAsKnown,
    fixtureRevisionId: fixture.fixtureRevisionId,
    fixtureRevisionHash: canonicalSha256(fixture),
    fixtureRevisionAvailableAt: fixture.availableAt,
    seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
    membershipPayloadHash: membership.membershipPayloadHash,
    seasonMembershipAvailableAt: membership.availableAt,
    modelId: model.modelId,
    modelVersion: model.modelVersion,
    modelBundleId: model.modelBundleId,
    modelBundleHash: model.modelBundleHash,
    modelBundleAvailableAt: model.availableAt,
    modelTrainingCutoff: model.trainingCutoff,
    featureSchemaVersion: model.featureSchemaVersion,
    featureCodeVersion: model.featureCodeVersion,
    applicationCommitSha: commitSha(
      input.applicationCommitSha,
      "manifest.applicationCommitSha"
    ),
    ratingStateId: ratingState.ratingStateId,
    ratingStateHash: ratingState.ratingStateHash,
    ratingStateAvailableAt: ratingState.availableAt,
    sourceObservations,
    ratingEvents,
    latestIncludedInputAt,
    temporalRule: PROVENANCE_TEMPORAL_RULE,
    inputLineageStatus: "PIT_VERIFIED",
  };
  const payload = manifestPayload(payloadWithoutIdentity);
  const manifestPayloadHash = canonicalSha256(payload);
  return cloneFrozen({
    ...payloadWithoutIdentity,
    manifestId: contentAddress("pl-forecast-input-manifest", payload),
    manifestPayloadHash,
  });
}

export function assertForecastInputManifestIntegrity(manifest: ForecastInputManifest): void {
  if (manifest.recordKind !== "FORECAST_INPUT_MANIFEST") {
    throw new Error("invalid forecast input manifest recordKind");
  }
  if (manifest.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`unsupported provenance schema: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.temporalRule !== PROVENANCE_TEMPORAL_RULE) {
    throw new Error("invalid manifest temporal rule");
  }
  if (manifest.inputLineageStatus !== "PIT_VERIFIED") {
    throw new Error("an input manifest record must be PIT_VERIFIED");
  }
  requireNonEmpty(manifest.fixtureId, "manifest.fixtureId");
  requireNonEmpty(manifest.season, "manifest.season");
  requireNonEmpty(manifest.forecastStage, "manifest.forecastStage");
  requireNonEmpty(manifest.fixtureRevisionId, "manifest.fixtureRevisionId");
  requireNonEmpty(
    manifest.seasonMembershipSnapshotId,
    "manifest.seasonMembershipSnapshotId"
  );
  requireNonEmpty(manifest.modelBundleId, "manifest.modelBundleId");
  requireNonEmpty(manifest.ratingStateId, "manifest.ratingStateId");
  commitSha(manifest.applicationCommitSha, "manifest.applicationCommitSha");
  normalizeSha256(manifest.fixtureRevisionHash, "manifest.fixtureRevisionHash");
  normalizeSha256(manifest.membershipPayloadHash, "manifest.membershipPayloadHash");
  normalizeSha256(manifest.modelBundleHash, "manifest.modelBundleHash");
  normalizeSha256(manifest.ratingStateHash, "manifest.ratingStateHash");

  const cutoffAt = assertCanonicalTimestamp(manifest.cutoffAt, "manifest.cutoffAt");
  const generatedAt = assertCanonicalTimestamp(manifest.generatedAt, "manifest.generatedAt");
  const kickoffAtAsKnown = assertCanonicalTimestamp(
    manifest.kickoffAtAsKnown,
    "manifest.kickoffAtAsKnown"
  );
  assertNoLater(cutoffAt, generatedAt, "manifest cutoffAt must not be after generatedAt");
  assertBefore(
    generatedAt,
    kickoffAtAsKnown,
    "manifest generatedAt must be strictly before kickoffAtAsKnown"
  );
  assertBefore(
    assertCanonicalTimestamp(manifest.modelTrainingCutoff, "manifest.modelTrainingCutoff"),
    cutoffAt,
    "manifest modelTrainingCutoff must be before cutoffAt"
  );
  const sourceObservations = uniqueSourceReferences(manifest.sourceObservations);
  const ratingEvents = uniqueRatingEvents(manifest.ratingEvents);
  const availability = [
    assertCanonicalTimestamp(
      manifest.fixtureRevisionAvailableAt,
      "manifest.fixtureRevisionAvailableAt"
    ),
    assertCanonicalTimestamp(
      manifest.seasonMembershipAvailableAt,
      "manifest.seasonMembershipAvailableAt"
    ),
    assertCanonicalTimestamp(
      manifest.modelBundleAvailableAt,
      "manifest.modelBundleAvailableAt"
    ),
    assertCanonicalTimestamp(
      manifest.ratingStateAvailableAt,
      "manifest.ratingStateAvailableAt"
    ),
    ...sourceObservations.map((source) => source.availableAt),
    ...ratingEvents.map((event) => event.availableAt),
  ];
  for (const [index, availableAt] of availability.entries()) {
    assertInputAtCutoff(availableAt, cutoffAt, `manifest input[${index}]`);
  }
  const expectedLatest = latestTimestamp(availability, "manifest input availability");
  if (manifest.latestIncludedInputAt !== expectedLatest) {
    throw new Error(
      `manifest latestIncludedInputAt mismatch: expected ${expectedLatest}`
    );
  }
  const { manifestId, manifestPayloadHash, ...withoutIdentity } = manifest;
  const payload = manifestPayload(withoutIdentity);
  const expectedHash = canonicalSha256(payload);
  const expectedId = contentAddress("pl-forecast-input-manifest", payload);
  if (manifestPayloadHash !== expectedHash || manifestId !== expectedId) {
    throw new Error(`forecast input manifest integrity mismatch: ${manifestId}`);
  }
}

/** Validate the manifest's compact hashes against the exact referenced records. */
export function assertForecastInputManifestReferences(
  manifest: ForecastInputManifest,
  references: ManifestReferenceSet
): void {
  assertForecastInputManifestIntegrity(manifest);
  assertFixtureRevisionIntegrity(references.fixtureRevision);
  assertSeasonMembershipIntegrity(references.seasonMembership);
  assertFrozenRatingStateIntegrity(references.ratingState);
  assertImmutableModelBundleIntegrity(references.modelBundle);
  const expected = buildForecastInputManifest({
    fixtureId: manifest.fixtureId,
    season: manifest.season,
    forecastStage: manifest.forecastStage,
    cutoffAt: manifest.cutoffAt,
    generatedAt: manifest.generatedAt,
    kickoffAtAsKnown: manifest.kickoffAtAsKnown,
    applicationCommitSha: manifest.applicationCommitSha,
    fixtureRevision: references.fixtureRevision,
    seasonMembership: references.seasonMembership,
    ratingState: references.ratingState,
    modelBundle: references.modelBundle,
    sourceObservations: manifest.sourceObservations,
  });
  if (canonicalJson(expected) !== canonicalJson(manifest)) {
    throw new Error("forecast input manifest does not match its referenced immutable records");
  }
}

export function provenanceRecordId(record: ProvenanceRecord): string {
  switch (record.recordKind) {
    case "FIXTURE_REVISION":
      return record.fixtureRevisionId;
    case "RESULT_REVISION":
      return record.resultRevisionId;
    case "RESULT_CORRECTION":
      return record.correctionId;
    case "SEASON_MEMBERSHIP":
      return record.seasonMembershipSnapshotId;
    case "RATING_STATE":
      return record.ratingStateId;
    case "MODEL_BUNDLE":
      return record.modelBundleId;
    case "FORECAST_INPUT_MANIFEST":
      return record.manifestId;
  }
}

export function assertProvenanceRecordIntegrity(record: ProvenanceRecord): void {
  switch (record.recordKind) {
    case "FIXTURE_REVISION":
      return assertFixtureRevisionIntegrity(record);
    case "RESULT_REVISION":
      return assertResultRevisionIntegrity(record);
    case "RESULT_CORRECTION":
      return assertResultCorrectionIntegrity(record);
    case "SEASON_MEMBERSHIP":
      return assertSeasonMembershipIntegrity(record);
    case "RATING_STATE":
      return assertFrozenRatingStateIntegrity(record);
    case "MODEL_BUNDLE":
      return assertImmutableModelBundleIntegrity(record);
    case "FORECAST_INPUT_MANIFEST":
      return assertForecastInputManifestIntegrity(record);
  }
}

export function classifyForecastLineage(input: {
  manifestId?: string | null;
  manifestVerified?: boolean;
  stageTimingValid?: boolean;
}): ForecastLineageStatus {
  if (input.stageTimingValid === false) return "INVALID_STAGE_TIMING";
  if (!input.manifestId) return "LEGACY_UNAVAILABLE";
  return input.manifestVerified ? "PIT_VERIFIED" : "PIT_INCOMPLETE";
}

/** Shared invariant helper for scheduler/dry-run integration. Equality at cutoff is allowed. */
export function assertPITTemporalInvariant(input: {
  inputAvailableAt: readonly string[];
  cutoffAt: string;
  generatedAt: string;
  kickoffAtAsKnown: string;
}): { latestIncludedInputAt: string } {
  if (!input.inputAvailableAt.length) throw new Error("at least one semantic input is required");
  const cutoffAt = normalizeTimestamp(input.cutoffAt, "cutoffAt");
  const generatedAt = normalizeTimestamp(input.generatedAt, "generatedAt");
  const kickoffAtAsKnown = normalizeTimestamp(input.kickoffAtAsKnown, "kickoffAtAsKnown");
  assertNoLater(cutoffAt, generatedAt, "cutoffAt must not be after generatedAt");
  assertBefore(generatedAt, kickoffAtAsKnown, "generatedAt must be before kickoffAtAsKnown");
  const available = input.inputAvailableAt.map((value, index) =>
    normalizeTimestamp(value, `inputAvailableAt[${index}]`)
  );
  for (const [index, value] of available.entries()) {
    assertInputAtCutoff(value, cutoffAt, `inputAvailableAt[${index}]`);
  }
  return { latestIncludedInputAt: latestTimestamp(available) };
}

/** Useful to sort fixture revisions without falling back to today's current state. */
export function latestFixtureRevisionAtOrBefore(
  records: readonly FixtureRevisionRecord[],
  fixtureId: string,
  cutoffAt: string
): FixtureRevisionRecord | null {
  const cutoffMs = timestampMillis(cutoffAt, "cutoffAt");
  return (
    records
      .filter((record) => {
        assertFixtureRevisionIntegrity(record);
        return (
          record.fixtureId === fixtureId && Date.parse(record.availableAt) <= cutoffMs
        );
      })
      .sort(
        (a, b) =>
          a.availableAt.localeCompare(b.availableAt) ||
          a.fixtureRevisionId.localeCompare(b.fixtureRevisionId)
      )
      .at(-1) ?? null
  );
}
