/**
 * Prospective production evidence capture and PIT resolution.
 *
 * Mutable source adapters stop here. The scheduler receives only immutable,
 * content-addressed records and passes them into the sealed prediction core.
 */

import { execFileSync } from "node:child_process";
import type { Fixture } from "@/lib/identity/types";
import { canonicalizeFixtureStatus } from "../ingest";
import { liveCompetitionSeason } from "../fixture-store";
import { loadProductionParams, PRODUCTION_MODEL_VERSION } from "../model-tracks";
import { liveRatingEventsAsOf, liveRatingsAsOf } from "../ops/live-ratings";
import { RATING_FORMULA_VERSION } from "../ops/rating-events";
import type { SourceObservation, TimedStage } from "../ops/types";
import {
  provenanceFixtureRevisionPath,
  provenanceManifestPath,
  provenanceModelBundlePath,
  provenanceRatingStatePath,
  provenanceResultCorrectionPath,
  provenanceResultRevisionPath,
  provenanceSeasonMembershipPath,
} from "../ops/paths";
import {
  buildFixtureRevision,
  buildForecastInputManifest,
  buildFrozenRatingState,
  buildImmutableModelBundle,
  buildRatingEventReference,
  buildResultCorrection,
  buildResultRevision,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
  assertForecastInputManifestReferences,
} from "./manifest";
import {
  canonicalJson,
  canonicalSha256,
  normalizeTimestamp,
} from "./canonical";
import {
  fixtureRevisionStore,
  forecastInputManifestStore,
  modelBundleStore,
  ratingStateStore,
  resultCorrectionStore,
  resultRevisionStore,
  seasonMembershipStore,
} from "./store";
import type {
  FixtureRevisionRecord,
  ForecastInputManifest,
  FrozenRatingStateSnapshot,
  ImmutableModelBundle,
  ManifestReferenceSet,
  ResultRevisionRecord,
  SeasonMembershipSnapshot,
  SourceObservationReference,
} from "./types";
import {
  predictPremierLeagueFromFrozenInputs,
  SEALED_PREMIER_LEAGUE_SCHEMA_VERSION,
  type SealedPremierLeaguePredictionInput,
  type SealedPremierLeaguePredictionResult,
} from "@/lib/prediction-engine/sealed-premier-league";

export const PRODUCTION_MODEL_ID = "football-oracle-premier-league-production";
export const PRODUCTION_FEATURE_SCHEMA_VERSION = "pl-features-v0.2.0";
export const PRODUCTION_FEATURE_CODE_VERSION =
  `${SEALED_PREMIER_LEAGUE_SCHEMA_VERSION}+${RATING_FORMULA_VERSION}`;

const COMMIT_SHA = /^[a-f0-9]{40}$/;

function fixtureStore() {
  return fixtureRevisionStore(provenanceFixtureRevisionPath());
}
function resultStore() {
  return resultRevisionStore(provenanceResultRevisionPath());
}
function correctionStore() {
  return resultCorrectionStore(provenanceResultCorrectionPath());
}
function membershipStore() {
  return seasonMembershipStore(provenanceSeasonMembershipPath());
}
function ratingStore() {
  return ratingStateStore(provenanceRatingStatePath());
}
function bundleStore() {
  return modelBundleStore(provenanceModelBundlePath());
}
function manifestStore() {
  return forecastInputManifestStore(provenanceManifestPath());
}

function latestByAvailableAt<T extends { availableAt: string }>(rows: readonly T[]): T | null {
  return rows
    .slice()
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
    .at(-1) ?? null;
}

function atOrBefore<T extends { availableAt: string }>(
  rows: readonly T[],
  cutoffAt: string
): T[] {
  const cutoffMs = Date.parse(normalizeTimestamp(cutoffAt, "cutoffAt"));
  return rows.filter((row) => Date.parse(row.availableAt) <= cutoffMs);
}

/**
 * A tick can freeze the pre-result and post-result rating states with the same
 * externally supplied timestamp. In that intentional boundary tie, the state
 * containing more immutable rating events is semantically later. Never let a
 * content-address sort order choose between them accidentally.
 */
function latestRatingState(
  rows: readonly FrozenRatingStateSnapshot[]
): FrozenRatingStateSnapshot | null {
  return rows
    .slice()
    .sort(
      (a, b) =>
        a.availableAt.localeCompare(b.availableAt) ||
        a.asOf.localeCompare(b.asOf) ||
        a.ratingEvents.length - b.ratingEvents.length ||
        a.ratingStateId.localeCompare(b.ratingStateId)
    )
    .at(-1) ?? null;
}

/** Production fails closed without an independently inspectable 40-hex SHA. */
export function applicationCommitSha(): string {
  const configured = String(
    process.env.APPLICATION_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.GIT_COMMIT_SHA ??
      ""
  )
    .trim()
    .toLowerCase();
  if (COMMIT_SHA.test(configured)) return configured;
  if (process.env.VERCEL === "1" || process.env.NODE_ENV === "production") {
    throw new Error(
      "APPLICATION_COMMIT_SHA (or VERCEL_GIT_COMMIT_SHA) must be an exact 40-hex commit in production"
    );
  }
  try {
    const local = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    if (COMMIT_SHA.test(local)) return local;
  } catch {
    // The explicit failure below is the evidence boundary.
  }
  throw new Error("Unable to resolve an exact 40-hex application commit SHA");
}

function normalizedPublishedAt(value: string | null | undefined, availableAt: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(Date.parse(value)).toISOString();
  return Date.parse(normalized) <= Date.parse(availableAt) ? normalized : null;
}

function sourceReference(input: {
  sourceType: string;
  sourceId: string;
  sourceVersion?: string | null;
  availableAt: string;
  publishedAt?: string | null;
  payload: unknown;
}): SourceObservationReference {
  const availableAt = normalizeTimestamp(input.availableAt, "source.availableAt");
  const payloadHash = canonicalSha256(input.payload);
  return buildSourceObservationReference({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion ?? null,
    observationId: `${input.sourceType}:${input.sourceId}:${payloadHash}`,
    publishedAt: normalizedPublishedAt(input.publishedAt, availableAt),
    availableAt,
    retrievedAt: availableAt,
    payload: input.payload,
  });
}

function fixtureEvidencePayload(fixture: Fixture) {
  return {
    fixtureId: fixture.id,
    competition: fixture.competition,
    season: fixture.season,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: fixture.kickoffUtc ?? fixture.kickoff ?? null,
    kickoffLocal: fixture.kickoffLocal ?? null,
    kickoffCertainty: fixture.kickoffCertainty ?? null,
    scheduledDate: fixture.scheduledDate ?? fixture.date,
    status: canonicalizeFixtureStatus(fixture.status),
    venue: fixture.venue,
    venueName: fixture.venueName ?? null,
    matchday: fixture.matchday ?? null,
    sourceFixtureId: fixture.sourceFixtureId ?? null,
  };
}

function matchingObservation(
  fixture: Fixture,
  observations: readonly SourceObservation[]
): SourceObservation | null {
  const kickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  return observations
    .filter(
      (row) =>
        row.fixtureId === fixture.id &&
        row.normalized.homeSlug === fixture.homeSlug &&
        row.normalized.awaySlug === fixture.awaySlug &&
        (row.normalized.kickoffUtc ?? kickoff) === kickoff &&
        canonicalizeFixtureStatus(row.normalized.status) ===
          canonicalizeFixtureStatus(fixture.status)
    )
    .sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt))
    .at(-1) ?? null;
}

function captureFixtureRevision(
  fixture: Fixture,
  observations: readonly SourceObservation[],
  capturedAt: string
): FixtureRevisionRecord | null {
  const kickoffAt = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  if (!kickoffAt) return null;
  const store = fixtureStore();
  const priorRows = store.list().filter((row) => row.fixtureId === fixture.id);
  const observed = matchingObservation(fixture, observations);
  const evidencePayload = fixtureEvidencePayload(fixture);
  const sourceId = observed?.source ?? fixture.source ?? "prospective-current-fixture";
  // The prospective tape's first observation time is this capture, not a
  // timestamp copied later from today's mutable fixture document.
  const recordedAt = observed?.retrievedAt ?? capturedAt;
  const source = sourceReference({
    sourceType: "fixture",
    sourceId,
    sourceVersion:
      observed?.sourceFixtureId ?? fixture.sourceFixtureId ?? fixture.sourceId ?? null,
    availableAt: recordedAt,
    publishedAt: observed?.sourceUpdatedAt ?? fixture.sourceUpdatedAt ?? null,
    payload: evidencePayload,
  });
  const same = priorRows.find(
    (row) =>
      row.sourceObservation.sourceId === source.sourceId &&
      row.sourceObservation.payloadHash === source.payloadHash &&
      row.kickoffAt === new Date(Date.parse(kickoffAt)).toISOString() &&
      row.status === canonicalizeFixtureStatus(fixture.status)
  );
  if (same) return same;
  const prior = latestByAvailableAt(priorRows);
  const record = buildFixtureRevision({
    season: fixture.season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt,
    kickoffCertainty: fixture.kickoffCertainty ?? null,
    status: canonicalizeFixtureStatus(fixture.status),
    venue: String(fixture.venue),
    sourceObservation: source,
    supersedesFixtureRevisionId: prior?.fixtureRevisionId ?? null,
  });
  return store.insert(record).record;
}

function captureResultRevisions(
  fixtures: readonly Fixture[],
  observations: readonly SourceObservation[],
  capturedAt: string
): number {
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const store = resultStore();
  let inserted = 0;
  for (const observation of observations) {
    if (!observation.fixtureId) continue;
    const fixture = fixturesById.get(observation.fixtureId);
    if (!fixture) continue;
    const normalized = observation.normalized;
    if (normalized.status === "SCHEDULED" && normalized.homeGoals === null) continue;
    const payload = {
      fixtureId: fixture.id,
      season: fixture.season,
      status: normalized.status,
      homeScore: normalized.homeGoals,
      awayScore: normalized.awayGoals,
    };
    const source = sourceReference({
      sourceType: "result",
      sourceId: observation.source,
      sourceVersion: observation.sourceFixtureId,
      availableAt: observation.retrievedAt,
      publishedAt: observation.sourceUpdatedAt,
      payload,
    });
    const priorRows = store
      .list()
      .filter(
        (row) =>
          row.fixtureId === fixture.id &&
          row.sourceObservation.sourceId === observation.source
      );
    const same = priorRows.find(
      (row) => row.sourceObservation.payloadHash === source.payloadHash
    );
    if (same) continue;
    const prior = latestByAvailableAt(priorRows);
    const record = buildResultRevision({
      season: fixture.season,
      fixtureId: fixture.id,
      status: normalized.status,
      homeScore: normalized.homeGoals,
      awayScore: normalized.awayGoals,
      sourceObservation: source,
      supersedesResultRevisionId: prior?.resultRevisionId ?? null,
    });
    const write = store.insert(record);
    if (write.status === "inserted") inserted += 1;
    if (
      prior?.status === "FINISHED" &&
      record.status === "FINISHED" &&
      (prior.homeScore !== record.homeScore || prior.awayScore !== record.awayScore)
    ) {
      correctionStore().insert(
        buildResultCorrection({
          fixtureId: fixture.id,
          previousResultRevisionId: prior.resultRevisionId,
          correctedResultRevisionId: record.resultRevisionId,
          detectedAt: capturedAt,
          availableAt: capturedAt,
        })
      );
    }
  }
  return inserted;
}

function captureMembership(capturedAt: string): SeasonMembershipSnapshot {
  const season = liveCompetitionSeason();
  if (!season || season.clubIds.length !== season.expectedClubCount) {
    throw new Error("Cannot capture PIT membership without a complete verified season field");
  }
  const payload = {
    competition: season.competition,
    season: season.season,
    teamSlugs: [...season.clubIds].sort(),
    expectedClubCount: season.expectedClubCount,
    source: season.source,
    dataVersion: season.dataVersion,
    verificationStatus: season.verificationStatus,
  };
  const source = sourceReference({
    sourceType: "season-membership",
    sourceId: season.source,
    sourceVersion: season.dataVersion,
    availableAt: capturedAt,
    publishedAt: season.retrievedAt,
    payload,
  });
  const store = membershipStore();
  const same = store.list().find(
    (row) =>
      row.membershipPayloadHash === canonicalSha256({
        competition: "premier-league",
        season: season.season,
        teamSlugs: [...season.clubIds].sort(),
      }) && row.sourceObservations.some((ref) => ref.payloadHash === source.payloadHash)
  );
  if (same) return same;
  return store.insert(
    buildSeasonMembershipSnapshot({
      season: season.season,
      teamSlugs: season.clubIds,
      sourceObservations: [source],
    })
  ).record;
}

function trainingCutoffIso(to: string): string {
  const candidate = to.length === 10 ? `${to}T23:59:59.999Z` : to;
  return normalizeTimestamp(candidate, "model training cutoff");
}

function captureModelBundle(capturedAt: string): ImmutableModelBundle {
  const params = loadProductionParams();
  if (params.modelVersion !== PRODUCTION_MODEL_VERSION) {
    throw new Error("Production parameter payload has the wrong model version");
  }
  const sha = applicationCommitSha();
  const payloadHash = canonicalSha256(params);
  const store = bundleStore();
  const same = store.list().find(
    (row) =>
      row.modelVersion === params.modelVersion &&
      row.codeCommitSha === sha &&
      row.parameterHash === payloadHash &&
      row.featureSchemaVersion === PRODUCTION_FEATURE_SCHEMA_VERSION &&
      row.featureCodeVersion === PRODUCTION_FEATURE_CODE_VERSION
  );
  if (same) return same;
  return store.insert(
    buildImmutableModelBundle({
      modelId: PRODUCTION_MODEL_ID,
      modelVersion: params.modelVersion,
      trainingCutoff: trainingCutoffIso(params.trainingWindow.to),
      parameterPayload: params,
      featureSchemaVersion: PRODUCTION_FEATURE_SCHEMA_VERSION,
      featureCodeVersion: PRODUCTION_FEATURE_CODE_VERSION,
      createdAt: capturedAt,
      availableAt: capturedAt,
      codeCommitSha: sha,
    })
  ).record;
}

function ratingEventResultRevision(event: { fixtureId: string; appliedAt: string }): string | null {
  return resultStore()
    .list()
    .filter(
      (row) =>
        row.fixtureId === event.fixtureId &&
        row.status === "FINISHED" &&
        Date.parse(row.availableAt) <= Date.parse(event.appliedAt)
    )
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
    .at(-1)?.resultRevisionId ?? null;
}

function captureRatingState(
  capturedAt: string,
  membership: SeasonMembershipSnapshot
): FrozenRatingStateSnapshot {
  const state = liveRatingsAsOf(capturedAt);
  if (state.season !== membership.season) {
    throw new Error("Resolved rating state does not match the captured membership season");
  }
  const events = liveRatingEventsAsOf(capturedAt).map((event) =>
    buildRatingEventReference({
      ratingEventId: event.eventId,
      fixtureId: event.fixtureId,
      fixtureKickoff: event.kickoffUtc,
      appliedAt: event.appliedAt,
      availableAt: event.appliedAt,
      payload: event,
      resultRevisionId: ratingEventResultRevision(event),
    })
  );
  const store = ratingStore();
  const candidate = buildFrozenRatingState({
    season: membership.season,
    asOf: capturedAt,
    availableAt: capturedAt,
    modelVersion: PRODUCTION_MODEL_VERSION,
    formulaVersion: RATING_FORMULA_VERSION,
    seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
    ratingEvents: events,
    state: {
      season: membership.season,
      // The legacy rating engine retains relegated clubs in its working map.
      // They are not semantic inputs to a current-season fixture, so freeze
      // the exact current membership projection consumed by the predictor.
      clubSlugs: membership.teamSlugs,
      ratings: Object.fromEntries(
        membership.teamSlugs.map((slug) => [slug, state.ratings[slug] ?? 1500])
      ),
      matchesPlayedSeason: Object.fromEntries(
        membership.teamSlugs.map((slug) => [
          slug,
          state.matchesPlayedSeason[slug] ?? 0,
        ])
      ),
    },
  });
  const eventIds = canonicalJson(candidate.ratingEvents.map((event) => event.ratingEventId));
  const same = store.list().find(
    (row) =>
      row.ratingStateHash === candidate.ratingStateHash &&
      row.seasonMembershipSnapshotId === membership.seasonMembershipSnapshotId &&
      row.modelVersion === PRODUCTION_MODEL_VERSION &&
      canonicalJson(row.ratingEvents.map((event) => event.ratingEventId)) === eventIds
  );
  return same ?? store.insert(candidate).record;
}

export interface ProspectiveCaptureSummary {
  capturedAt: string;
  fixturesConsidered: number;
  fixtureRecordsInserted: number;
  resultRecordsInserted: number;
  seasonMembershipSnapshotId: string;
  ratingStateId: string;
  ratingStateHash: string;
  modelBundleId: string;
  modelBundleHash: string;
  applicationCommitSha: string;
}

/** Called before job planning on every tick. Unchanged semantic content is a no-op. */
export function captureProspectiveProductionEvidence(input: {
  fixtures: readonly Fixture[];
  observations: readonly SourceObservation[];
  capturedAt: string;
}): ProspectiveCaptureSummary {
  const capturedAt = normalizeTimestamp(input.capturedAt, "capturedAt");
  const fixtureStoreBefore = fixtureStore().size;
  for (const fixture of input.fixtures) {
    captureFixtureRevision(fixture, input.observations, capturedAt);
  }
  const fixtureStoreAfter = fixtureStore().size;
  const resultRecordsInserted = captureResultRevisions(
    input.fixtures,
    input.observations,
    capturedAt
  );
  const membership = captureMembership(capturedAt);
  const modelBundle = captureModelBundle(capturedAt);
  const ratingState = captureRatingState(capturedAt, membership);
  return {
    capturedAt,
    fixturesConsidered: input.fixtures.length,
    fixtureRecordsInserted: fixtureStoreAfter - fixtureStoreBefore,
    resultRecordsInserted,
    seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
    ratingStateId: ratingState.ratingStateId,
    ratingStateHash: ratingState.ratingStateHash,
    modelBundleId: modelBundle.modelBundleId,
    modelBundleHash: modelBundle.modelBundleHash,
    applicationCommitSha: modelBundle.codeCommitSha,
  };
}

function resolveReferenceSet(input: {
  fixtureId: string;
  cutoffAt: string;
  modelVersion?: string;
}): ManifestReferenceSet {
  const cutoffAt = normalizeTimestamp(input.cutoffAt, "cutoffAt");
  const modelVersion = input.modelVersion ?? PRODUCTION_MODEL_VERSION;
  const commitSha = applicationCommitSha();
  const fixtureRevision = latestByAvailableAt(
    atOrBefore(
      fixtureStore().list().filter((row) => row.fixtureId === input.fixtureId),
      cutoffAt
    )
  );
  if (!fixtureRevision) {
    throw new Error(`No immutable fixture revision is available at cutoff for ${input.fixtureId}`);
  }
  const seasonMembership = latestByAvailableAt(
    atOrBefore(
      membershipStore()
        .list()
        .filter(
          (row) =>
            row.season === fixtureRevision.season &&
            row.teamSlugs.includes(fixtureRevision.homeSlug) &&
            row.teamSlugs.includes(fixtureRevision.awaySlug)
        ),
      cutoffAt
    )
  );
  if (!seasonMembership) {
    throw new Error(`No immutable season-membership snapshot is available at cutoff`);
  }
  const modelBundle = latestByAvailableAt(
    atOrBefore(
      bundleStore()
        .list()
        .filter(
          (row) =>
            row.modelVersion === modelVersion && row.codeCommitSha === commitSha
        ),
      cutoffAt
    )
  );
  if (!modelBundle) {
    throw new Error(
      `No immutable model bundle for commit ${commitSha} is available at cutoff`
    );
  }
  const ratingState = latestRatingState(
    atOrBefore(
      ratingStore()
        .list()
        .filter(
          (row) =>
            row.season === fixtureRevision.season &&
            row.modelVersion === modelVersion &&
            row.seasonMembershipSnapshotId ===
              seasonMembership.seasonMembershipSnapshotId &&
            row.state.clubSlugs.includes(fixtureRevision.homeSlug) &&
            row.state.clubSlugs.includes(fixtureRevision.awaySlug)
        ),
      cutoffAt
    )
  );
  if (!ratingState) {
    throw new Error(`No immutable rating-state snapshot is available at cutoff`);
  }
  return { fixtureRevision, seasonMembership, ratingState, modelBundle };
}

export interface ResolvedProspectiveForecastInput {
  manifest: ForecastInputManifest;
  references: ManifestReferenceSet;
  sealedInput: SealedPremierLeaguePredictionInput;
}

function exactReferencesForManifest(
  manifest: ForecastInputManifest
): ManifestReferenceSet | null {
  const fixtureRevision = fixtureStore().get(manifest.fixtureRevisionId);
  const seasonMembership = membershipStore().get(
    manifest.seasonMembershipSnapshotId
  );
  const ratingState = ratingStore().get(manifest.ratingStateId);
  const modelBundle = bundleStore().get(manifest.modelBundleId);
  return fixtureRevision && seasonMembership && ratingState && modelBundle
    ? { fixtureRevision, seasonMembership, ratingState, modelBundle }
    : null;
}

/** Resolve, validate and persist the manifest before a production snapshot is written. */
export function resolveProspectiveForecastInput(input: {
  fixtureId: string;
  stage: TimedStage;
  cutoffAt: string;
  generatedAt: string;
}): ResolvedProspectiveForecastInput {
  let references = resolveReferenceSet(input);
  const existing = manifestStore()
    .list()
    .find(
      (row) =>
        row.fixtureId === input.fixtureId &&
        row.forecastStage === input.stage &&
        row.cutoffAt === normalizeTimestamp(input.cutoffAt) &&
        row.modelVersion === references.modelBundle.modelVersion &&
        row.applicationCommitSha === references.modelBundle.codeCommitSha
    );
  if (existing) {
    const exact = exactReferencesForManifest(existing);
    if (!exact) {
      throw new Error(`Existing manifest ${existing.manifestId} lost an immutable reference`);
    }
    assertForecastInputManifestReferences(existing, exact);
    references = exact;
    const sealedInput: SealedPremierLeaguePredictionInput = {
      fixture: {
        competition: "premier-league",
        season: existing.season,
        fixtureId: existing.fixtureId,
        homeSlug: exact.fixtureRevision.homeSlug,
        awaySlug: exact.fixtureRevision.awaySlug,
        homeTeam: exact.fixtureRevision.homeSlug,
        awayTeam: exact.fixtureRevision.awaySlug,
        venue: "home",
      },
      stage: input.stage,
      cutoffAt: existing.cutoffAt,
      generatedAt: existing.generatedAt,
      kickoffAtAsKnown: existing.kickoffAtAsKnown,
      modelVersion: existing.modelVersion,
      ratingState: exact.ratingState,
      modelBundle: exact.modelBundle,
    };
    return { manifest: existing, references: exact, sealedInput };
  }
  const manifest = buildForecastInputManifest({
    fixtureId: input.fixtureId,
    season: references.fixtureRevision.season,
    forecastStage: input.stage,
    cutoffAt: input.cutoffAt,
    generatedAt: input.generatedAt,
    kickoffAtAsKnown: references.fixtureRevision.kickoffAt,
    applicationCommitSha: references.modelBundle.codeCommitSha,
    ...references,
  });
  assertForecastInputManifestReferences(manifest, references);
  // Child first. If later prediction persistence fails, this is only a harmless
  // content-addressed orphan; a forecast without its manifest cannot appear.
  manifestStore().insert(manifest);
  const sealedInput: SealedPremierLeaguePredictionInput = {
    fixture: {
      competition: "premier-league",
      season: references.fixtureRevision.season,
      fixtureId: references.fixtureRevision.fixtureId,
      homeSlug: references.fixtureRevision.homeSlug,
      awaySlug: references.fixtureRevision.awaySlug,
      // Display strings do not enter the probability math. Slugs are frozen in
      // the fixture revision, so replay never consults today's club registry.
      homeTeam: references.fixtureRevision.homeSlug,
      awayTeam: references.fixtureRevision.awaySlug,
      venue: "home",
    },
    stage: input.stage,
    cutoffAt: manifest.cutoffAt,
    generatedAt: manifest.generatedAt,
    kickoffAtAsKnown: manifest.kickoffAtAsKnown,
    modelVersion: manifest.modelVersion,
    ratingState: references.ratingState,
    modelBundle: references.modelBundle,
  };
  return { manifest, references, sealedInput };
}

export interface ProspectiveForecastPreflight {
  ready: boolean;
  fixtureId: string;
  stage: TimedStage;
  cutoffAt: string;
  reasons: string[];
  fixtureRevisionId: string | null;
  seasonMembershipSnapshotId: string | null;
  ratingStateHash: string | null;
  modelBundleId: string | null;
  applicationCommitSha: string | null;
}

/** Resolve-only readiness check; never mints a manifest or forecast. */
export function preflightProspectiveForecast(input: {
  fixtureId: string;
  stage: TimedStage;
  cutoffAt: string;
}): ProspectiveForecastPreflight {
  try {
    const references = resolveReferenceSet(input);
    if (Date.parse(references.fixtureRevision.kickoffAt) <= Date.parse(input.cutoffAt)) {
      throw new Error("Frozen kickoff is not after the planned cutoff");
    }
    return {
      ready: true,
      fixtureId: input.fixtureId,
      stage: input.stage,
      cutoffAt: normalizeTimestamp(input.cutoffAt),
      reasons: [],
      fixtureRevisionId: references.fixtureRevision.fixtureRevisionId,
      seasonMembershipSnapshotId:
        references.seasonMembership.seasonMembershipSnapshotId,
      ratingStateHash: references.ratingState.ratingStateHash,
      modelBundleId: references.modelBundle.modelBundleId,
      applicationCommitSha: references.modelBundle.codeCommitSha,
    };
  } catch (error) {
    return {
      ready: false,
      fixtureId: input.fixtureId,
      stage: input.stage,
      cutoffAt: input.cutoffAt,
      reasons: [error instanceof Error ? error.message : String(error)],
      fixtureRevisionId: null,
      seasonMembershipSnapshotId: null,
      ratingStateHash: null,
      modelBundleId: null,
      applicationCommitSha: null,
    };
  }
}

/** Store-free replay. It cannot write to the production track by construction. */
export function replayForecastInputManifest(
  manifest: ForecastInputManifest,
  references: ManifestReferenceSet
): {
  track: "HISTORICAL_REPLAY";
  manifestId: string;
  replayHash: string;
  result: SealedPremierLeaguePredictionResult;
} {
  assertForecastInputManifestReferences(manifest, references);
  const result = predictPremierLeagueFromFrozenInputs({
    fixture: {
      competition: "premier-league",
      season: manifest.season,
      fixtureId: manifest.fixtureId,
      homeSlug: references.fixtureRevision.homeSlug,
      awaySlug: references.fixtureRevision.awaySlug,
      homeTeam: references.fixtureRevision.homeSlug,
      awayTeam: references.fixtureRevision.awaySlug,
      venue: "home",
    },
    stage: manifest.forecastStage as TimedStage,
    cutoffAt: manifest.cutoffAt,
    generatedAt: manifest.generatedAt,
    kickoffAtAsKnown: manifest.kickoffAtAsKnown,
    modelVersion: manifest.modelVersion,
    ratingState: references.ratingState,
    modelBundle: references.modelBundle,
  });
  return {
    track: "HISTORICAL_REPLAY",
    manifestId: manifest.manifestId,
    replayHash: result.artifact.replayHash,
    result,
  };
}

export function listProspectiveResultRevisions(): ResultRevisionRecord[] {
  return resultStore().list();
}
