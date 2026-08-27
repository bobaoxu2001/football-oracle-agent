/** Phase 4A.3: compact public input-lineage semantics and redaction gates. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "football-oracle-public-lineage-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TEMP, "snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TEMP, "live-oos.jsonl");
delete process.env.MONGODB_URI;

import type { Fixture } from "@/lib/identity/types";
import type {
  ForecastInputManifest,
  ManifestReferenceSet,
} from "@/lib/competitions/premier-league/provenance/types";
import {
  buildFixtureRevision,
  buildForecastInputManifest,
  buildFrozenRatingState,
  buildImmutableModelBundle,
  buildRatingEventReference,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
} from "@/lib/competitions/premier-league/provenance/manifest";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { scorelineGridFromGoals } from "@/lib/prediction-engine/elo";
import { deriveForecastMath } from "@/lib/match-forecast/derive";
import { inputLineageSummary } from "@/lib/match-forecast/input-lineage";
import {
  buildMatchForecast,
  forecastTimeline,
  selectProductionSnapshot,
} from "@/lib/match-forecast/service";
import {
  clearSnapshotsForTests,
  createSnapshot,
  snapshotUniqueKey,
} from "@/lib/snapshots/store";
import type { PredictionSnapshot } from "@/lib/snapshots/types";

const KICKOFF = "2026-10-10T15:00:00.000Z";
const COMMIT = "b".repeat(40);
const PRIVATE_SOURCE = "RAW_SOURCE_SENTINEL";
const PRIVATE_RATING = "RAW_RATING_SENTINEL";
const PRIVATE_PARAMETERS = "PRIVATE_PARAMETER_SENTINEL";
const PRIVATE_RATING_STATE = "PRIVATE_RATING_STATE_SENTINEL";

const fixture: Fixture = {
  id: "phase4a3-public-lineage-fixture",
  competition: "premier-league",
  season: "2026-27",
  date: "2026-10-10",
  scheduledDate: "2026-10-10",
  kickoff: KICKOFF,
  kickoffUtc: KICKOFF,
  kickoffLocal: "2026-10-10T16:00:00+01:00",
  timezone: "Europe/London",
  kickoffCertainty: "CONFIRMED",
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  homeGoals: null,
  awayGoals: null,
  status: "SCHEDULED",
  venue: "home",
  source: "phase4a3-test",
  sourceId: "fixture-source-test",
  retrievedAt: "2026-08-01T00:00:00.000Z",
  verificationStatus: "VERIFIED",
};

let passed = 0;

function check(name: string, test: () => void): void {
  test();
  passed += 1;
  console.log(`✓ ${name}`);
}

function scoreArtifact(lambdaHome = 1.7, lambdaAway = 1.1, rho = -0.061) {
  const cells = scorelineGridFromGoals(lambdaHome, lambdaAway, rho);
  const matrix = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (const cell of cells) matrix[cell.a][cell.b] = cell.p;
  return {
    probabilities: deriveForecastMath(matrix).result,
    scorelineDistribution: Object.fromEntries(
      cells.map((cell) => [`${cell.a}–${cell.b}`, cell.p])
    ),
  };
}

function cloneAt(
  source: PredictionSnapshot,
  asOf: string,
  stage: PredictionSnapshot["predictionStage"],
  origin: "manual" | "scheduled" = "manual"
): PredictionSnapshot {
  return {
    ...source,
    createdAt: asOf,
    asOf,
    dataCutoff: asOf,
    predictionStage: stage,
    sourceState: {
      ...source.sourceState,
      computedAt: asOf,
      origin,
    },
    provenance: {
      ...source.provenance,
      uniqueKey: snapshotUniqueKey({
        competition: source.competition,
        season: source.season,
        fixtureId: source.fixtureId,
        modelVersion: source.modelVersion,
        predictionStage: stage,
        asOf,
      }),
    },
  };
}

function manifestFor(
  snapshot: PredictionSnapshot,
  input: { latestIncludedInputAt?: string; suffix?: string } = {}
): { manifest: ForecastInputManifest; references: ManifestReferenceSet } {
  const suffix = input.suffix ?? String(snapshot.predictionStage).toLowerCase();
  const fixtureSource = buildSourceObservationReference({
    sourceType: "fixture",
    sourceId: PRIVATE_SOURCE,
    sourceVersion: `test-${suffix}`,
    observationId: `private-source-observation:${suffix}`,
    availableAt: "2026-08-01T00:00:00.000Z",
    retrievedAt: "2026-08-01T00:00:00.000Z",
    payload: { fixtureId: snapshot.fixtureId, kickoffAt: KICKOFF, suffix },
  });
  const membershipSource = buildSourceObservationReference({
    sourceType: "season-membership",
    sourceId: "private-membership-source",
    sourceVersion: `test-${suffix}`,
    observationId: `private-membership-observation:${suffix}`,
    availableAt: "2026-06-15T00:00:00.000Z",
    retrievedAt: "2026-06-15T00:00:00.000Z",
    payload: { season: snapshot.season, teams: ["arsenal", "chelsea"] },
  });
  const fixtureRevision = buildFixtureRevision({
    season: snapshot.season,
    fixtureId: snapshot.fixtureId,
    homeSlug: snapshot.homeSlug,
    awaySlug: snapshot.awaySlug,
    kickoffAt: KICKOFF,
    kickoffCertainty: "CONFIRMED",
    status: "SCHEDULED",
    venue: "home",
    sourceObservation: fixtureSource,
  });
  const seasonMembership = buildSeasonMembershipSnapshot({
    season: snapshot.season,
    teamSlugs: ["arsenal", "chelsea"],
    sourceObservations: [membershipSource],
  });
  const ratingEvent = buildRatingEventReference({
    ratingEventId: `${PRIVATE_RATING}:${suffix}`,
    fixtureId: "private-prior-fixture",
    fixtureKickoff: "2026-09-01T15:00:00.000Z",
    appliedAt: "2026-09-01T17:00:00.000Z",
    availableAt: "2026-09-01T17:00:00.000Z",
    payload: { private: PRIVATE_RATING },
  });
  const ratingState = buildFrozenRatingState({
    season: snapshot.season,
    asOf: snapshot.asOf,
    availableAt: new Date(Date.parse(snapshot.asOf) - 120_000).toISOString(),
    modelVersion: PRODUCTION_MODEL_VERSION,
    formulaVersion: PRIVATE_RATING_STATE,
    seasonMembershipSnapshotId: seasonMembership.seasonMembershipSnapshotId,
    ratingEvents: [ratingEvent],
    state: {
      season: snapshot.season,
      clubSlugs: ["arsenal", "chelsea"],
      ratings: { arsenal: 1600, chelsea: 1500 },
      matchesPlayedSeason: { arsenal: 1, chelsea: 1 },
    },
  });
  const modelBundle = buildImmutableModelBundle({
    modelId: "football-oracle-premier-league",
    modelVersion: PRODUCTION_MODEL_VERSION,
    trainingCutoff: "2025-05-31T23:59:59.999Z",
    parameterPayload: { private: PRIVATE_PARAMETERS },
    featureSchemaVersion: "pl-features-v1",
    featureCodeVersion: "pl-feature-code-v1",
    createdAt: "2026-06-01T00:00:00.000Z",
    availableAt: "2026-06-01T00:00:00.000Z",
    codeCommitSha: COMMIT,
  });
  const references = {
    fixtureRevision,
    seasonMembership,
    ratingState,
    modelBundle,
  };
  const valid = buildForecastInputManifest({
    fixtureId: snapshot.fixtureId,
    season: snapshot.season,
    forecastStage: String(snapshot.predictionStage),
    cutoffAt: snapshot.asOf,
    generatedAt: String(snapshot.sourceState.computedAt),
    kickoffAtAsKnown: KICKOFF,
    applicationCommitSha: COMMIT,
    ...references,
  });
  const manifest = input.latestIncludedInputAt
    ? { ...valid, latestIncludedInputAt: input.latestIncludedInputAt }
    : valid;
  return { manifest, references };
}

function withManifest(
  snapshot: PredictionSnapshot,
  lineage: { manifest: ForecastInputManifest; references: ManifestReferenceSet }
): PredictionSnapshot {
  return {
    ...snapshot,
    inputManifestId: lineage.manifest.manifestId,
    inputManifest: lineage.manifest,
    // Deliberately private full records. Public projections must never copy
    // these bytes just because the immutable snapshot retains them.
    inputManifestRecords: lineage.references,
  };
}

function main(): void {
  clearSnapshotsForTests();
  const artifact = scoreArtifact();
  const legacy = createSnapshot({
    fixtureId: fixture.id,
    competition: "premier-league",
    season: fixture.season,
    asOf: "2026-09-01T12:00:00.000Z",
    kickoff: KICKOFF,
    modelVersion: PRODUCTION_MODEL_VERSION,
    predictionStage: "EARLY",
    evaluationClass: "LIVE_OOS",
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    home: artifact.probabilities.homeWin,
    draw: artifact.probabilities.draw,
    away: artifact.probabilities.awayWin,
    homeExpectedGoals: 1.7,
    awayExpectedGoals: 1.1,
    scorelineDistribution: artifact.scorelineDistribution,
    modelParameters: {
      dcRho: -0.061,
      trainingWindow: { from: "2018-08-01", to: "2025-05-31" },
    },
    sourceState: {
      origin: "manual",
      computedAt: "2026-09-01T12:00:00.000Z",
      ratingStateAsOf: "2026-09-01T12:00:00.000Z",
      latestRatingEventAppliedAt: "2026-08-30T18:00:00.000Z",
      fixtureRetrievedAt: "2026-08-01T00:00:00.000Z",
      latestEvidenceObservedAt: "2026-08-31T10:00:00.000Z",
    },
  });

  const legacySummary = inputLineageSummary(legacy);
  check("legacy snapshot is explicitly unavailable", () => {
    assert.equal(legacySummary.status, "LEGACY_UNAVAILABLE");
  });
  check("legacy summary fabricates no manifest fields", () => {
    assert.ok(
      Object.entries(legacySummary)
        .filter(([key]) => key !== "status")
        .every(([, value]) => value === null)
    );
  });
  check("partial legacy source timestamps cannot imply PIT verification", () => {
    assert.equal(legacySummary.latestIncludedInputAt, null);
    assert.equal(legacySummary.manifestId, null);
  });
  check("the legacy row was written only to the isolated temp store", () => {
    const rows = fs.readFileSync(process.env.SNAPSHOT_STORE_PATH!, "utf8")
      .split("\n")
      .filter(Boolean);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0]).fixtureId, fixture.id);
  });

  const invalidBase = cloneAt(legacy, "2026-09-10T12:00:00.000Z", "EARLY");
  const invalid = withManifest(
    invalidBase,
    manifestFor(invalidBase, {
      suffix: "future-input",
      latestIncludedInputAt: "2026-09-10T12:00:00.001Z",
    })
  );
  const invalidSummary = inputLineageSummary(invalid);
  check("present-but-temporally-invalid manifest fails closed", () => {
    assert.equal(invalidSummary.status, "PIT_INVALID");
  });
  check("invalid manifest remains observable and is not relabelled legacy", () => {
    assert.equal(invalidSummary.manifestId, invalid.inputManifestId);
    assert.notEqual(invalidSummary.status, "LEGACY_UNAVAILABLE");
  });

  const verifiedBase = cloneAt(
    legacy,
    "2026-10-09T15:00:00.000Z",
    "T24H",
    "scheduled"
  );
  const verified = withManifest(
    verifiedBase,
    manifestFor(verifiedBase, { suffix: "verified-t24h" })
  );
  const verifiedSummary = inputLineageSummary(verified);
  check("complete verified compact manifest is PIT verified", () => {
    assert.equal(verifiedSummary.status, "PIT_VERIFIED");
  });
  check("verified compact summary preserves the required public identities", () => {
    assert.equal(verifiedSummary.manifestId, verified.inputManifestId);
    assert.equal(verifiedSummary.kickoffAtAsKnown, KICKOFF);
    assert.equal(
      verifiedSummary.modelBundleId,
      verified.inputManifestRecords?.modelBundle.modelBundleId
    );
    assert.equal(verifiedSummary.applicationCommitSha, COMMIT);
  });
  check("verified compact summary exposes only the allowlisted shape", () => {
    assert.deepEqual(Object.keys(verifiedSummary).sort(), [
      "applicationCommitSha",
      "fixtureRevisionId",
      "kickoffAtAsKnown",
      "latestIncludedInputAt",
      "manifestId",
      "manifestPayloadHash",
      "modelBundleHash",
      "modelBundleId",
      "ratingStateHash",
      "seasonMembershipSnapshotId",
      "status",
    ]);
  });
  check("well-shaped self-declared hashes cannot forge PIT verification", () => {
    const forged = {
      ...verified,
      inputManifest: {
        ...verified.inputManifest!,
        manifestPayloadHash: `sha256:${"f".repeat(64)}` as const,
      },
    };
    assert.equal(inputLineageSummary(forged).status, "PIT_INVALID");
  });
  check("a manifest without its exact embedded reference set is not verified", () => {
    const missingReferences = {
      ...verified,
      inputManifestRecords: undefined,
    };
    assert.equal(inputLineageSummary(missingReferences).status, "PIT_INVALID");
  });

  const evaluatedAt = new Date("2026-10-09T15:05:00.000Z");
  const selected = selectProductionSnapshot(
    fixture,
    [verified, legacy],
    evaluatedAt
  );
  const selectedForecast = buildMatchForecast(fixture, selected);
  const selectedTimeline = forecastTimeline(
    fixture,
    [verified, legacy],
    evaluatedAt
  );
  const selectedTimelinePoint = selectedTimeline.find(
    (point) => point.forecastId === selected.provenance.uniqueKey
  );
  check("latest valid production selection chooses the verified T24H row", () => {
    assert.equal(selected.provenance.uniqueKey, verified.provenance.uniqueKey);
  });
  check("selected public forecast uses the centralized lineage summary", () => {
    assert.deepEqual(selectedForecast.provenance.inputLineage, verifiedSummary);
  });
  check("timeline uses the same lineage status and manifest identity", () => {
    assert.ok(selectedTimelinePoint);
    assert.deepEqual(selectedTimelinePoint.inputLineage, verifiedSummary);
  });
  check("legacy timeline point remains explicitly legacy", () => {
    assert.equal(
      selectedTimeline.find((point) => point.forecastId === legacy.provenance.uniqueKey)
        ?.inputLineage.status,
      "LEGACY_UNAVAILABLE"
    );
  });

  const corruptedLatestBase = cloneAt(
    legacy,
    "2026-10-10T13:00:00.000Z",
    "T2H",
    "scheduled"
  );
  const corruptedLatestValid = withManifest(
    corruptedLatestBase,
    manifestFor(corruptedLatestBase, { suffix: "corrupt-latest-t2h" })
  );
  const corruptedLatest = {
    ...corruptedLatestValid,
    inputManifest: {
      ...corruptedLatestValid.inputManifest!,
      manifestPayloadHash: `sha256:${"f".repeat(64)}` as const,
    },
  };
  const afterT2HEvaluation = new Date("2026-10-10T13:05:00.000Z");
  const selectedAroundCorruption = selectProductionSnapshot(
    fixture,
    [legacy, verified, corruptedLatest],
    afterT2HEvaluation
  );
  const corruptedTimelinePoint = forecastTimeline(
    fixture,
    [legacy, verified, corruptedLatest],
    afterT2HEvaluation
  ).find((point) => point.forecastId === corruptedLatest.provenance.uniqueKey);
  check("latest present-but-invalid lineage cannot replace a valid selected forecast", () => {
    assert.equal(selectedAroundCorruption.provenance.uniqueKey, verified.provenance.uniqueKey);
  });
  check("timeline retains but explicitly excludes a corrupt manifested snapshot", () => {
    assert.ok(corruptedTimelinePoint);
    assert.equal(corruptedTimelinePoint.inputLineage.status, "PIT_INVALID");
    assert.equal(corruptedTimelinePoint.validForCurrentKickoff, false);
    assert.ok(
      corruptedTimelinePoint.validityIssues.includes("SNAPSHOT_INPUT_LINEAGE_INVALID")
    );
  });

  const badTimingBase = cloneAt(
    legacy,
    "2026-10-09T14:00:00.000Z",
    "T24H",
    "scheduled"
  );
  const badTiming = withManifest(
    badTimingBase,
    manifestFor(badTimingBase, { suffix: "bad-stage-timing" })
  );
  const timingTimeline = forecastTimeline(
    fixture,
    [legacy, badTiming, verified],
    evaluatedAt
  );
  const badTimingPoint = timingTimeline.find(
    (point) => point.forecastId === badTiming.provenance.uniqueKey
  );
  check("PIT lineage verification is independent of stage timing", () => {
    assert.equal(inputLineageSummary(badTiming).status, "PIT_VERIFIED");
  });
  check("invalid stage timing is exposed separately", () => {
    assert.ok(badTimingPoint);
    assert.equal(badTimingPoint.validForCurrentKickoff, false);
    assert.ok(badTimingPoint.validityIssues.includes("SNAPSHOT_STAGE_CUTOFF_MISMATCH"));
    assert.ok(badTimingPoint.validityIssues.includes("SNAPSHOT_GENERATED_OUTSIDE_STAGE_WINDOW"));
    assert.equal(badTimingPoint.inputLineage.status, "PIT_VERIFIED");
  });

  const publicJson = JSON.stringify({
    forecast: selectedForecast,
    timeline: timingTimeline,
  });
  check("private source, rating, parameter and rating-state payloads are redacted", () => {
    for (const sentinel of [
      PRIVATE_SOURCE,
      PRIVATE_RATING,
      PRIVATE_PARAMETERS,
      PRIVATE_RATING_STATE,
    ]) {
      assert.equal(publicJson.includes(sentinel), false, sentinel);
    }
  });
  check("public JSON contains no raw manifest or private-record structures", () => {
    for (const field of [
      '"inputManifest"',
      '"inputManifestRecords"',
      '"sourceObservations"',
      '"ratingEvents"',
      '"parameterPayload"',
    ]) {
      assert.equal(publicJson.includes(field), false, field);
    }
  });
  check("public JSON retains the compact manifest identity", () => {
    assert.ok(publicJson.includes('"inputLineage"'));
    assert.ok(publicJson.includes(String(verified.inputManifestId)));
    assert.ok(publicJson.includes('"status":"PIT_VERIFIED"'));
  });

  console.log(`\nPhase 4A.3 public lineage: ${passed} passed, 0 failed.`);
}

try {
  main();
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
