import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ImmutableRecordCollisionError,
  assertForecastInputManifestIntegrity,
  assertForecastInputManifestReferences,
  assertPITTemporalInvariant,
  buildFixtureRevision,
  buildForecastInputManifest,
  buildFrozenRatingState,
  buildImmutableModelBundle,
  buildVerifiedRatingEventReference,
  buildResultCorrection,
  buildResultRevision,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
  canonicalJson,
  canonicalSha256,
  classifyForecastLineage,
  fixtureRevisionStore,
  latestFixtureRevisionAtOrBefore,
  type FixtureRevisionRecord,
} from "@/lib/competitions/premier-league/provenance";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const cutoffAt = "2026-08-27T19:00:00.000Z";
const generatedAt = "2026-08-27T19:05:00.000Z";
const kickoffAt = "2026-08-28T19:00:00.000Z";
const commit = "a".repeat(40);

const fixtureSource = buildSourceObservationReference({
  sourceType: "fixture",
  sourceId: "fixture-provider",
  sourceVersion: "v1",
  observationId: "fixture-provider::cp-mci::v1",
  publishedAt: "2026-08-27T18:59:00.000Z",
  retrievedAt: cutoffAt,
  availableAt: cutoffAt,
  payload: { kickoffAt, status: "SCHEDULED" },
});

const fixture = buildFixtureRevision({
  season: "2026-27",
  fixtureId: "pl-2026-27-crystal-palace-manchester-city",
  homeSlug: "crystal-palace",
  awaySlug: "manchester-city",
  kickoffAt,
  status: "SCHEDULED",
  venue: "Selhurst Park",
  sourceObservation: fixtureSource,
});

const membershipSource = buildSourceObservationReference({
  sourceType: "season-membership",
  sourceId: "premier-league-membership",
  observationId: "membership::2026-27::v1",
  retrievedAt: "2026-08-27T18:00:00.000Z",
  availableAt: "2026-08-27T18:00:00.000Z",
  payload: { teams: ["crystal-palace", "manchester-city"] },
});

const membership = buildSeasonMembershipSnapshot({
  season: "2026-27",
  teamSlugs: ["manchester-city", "crystal-palace"],
  sourceObservations: [membershipSource],
  verificationStatus: "VERIFIED",
  verifiedAt: "2026-08-27T18:00:00.000Z",
  verifiedAgainst: ["independent-membership-audit"],
  verificationArtifact: "phase4a3-membership-audit",
});

const ratingFixtureSource = buildSourceObservationReference({
  sourceType: "fixture",
  sourceId: "fixture-provider",
  observationId: "fixture-provider::prior::v1",
  availableAt: "2026-08-21T18:00:00.000Z",
  payload: { status: "FINISHED" },
});
const ratingFixture = buildFixtureRevision({
  season: "2026-27",
  fixtureId: "pl-2026-27-prior-cp-mci",
  homeSlug: "crystal-palace",
  awaySlug: "manchester-city",
  kickoffAt: "2026-08-21T19:00:00.000Z",
  status: "FINISHED",
  venue: "home",
  sourceObservation: ratingFixtureSource,
});
const ratingResultSource = buildSourceObservationReference({
  sourceType: "result",
  sourceId: "result-provider",
  observationId: "result-provider::prior::v1",
  availableAt: "2026-08-21T21:00:00.000Z",
  payload: { status: "FINISHED", homeScore: 1, awayScore: 0 },
});
const ratingResult = buildResultRevision({
  season: "2026-27",
  fixtureId: ratingFixture.fixtureId,
  status: "FINISHED",
  homeScore: 1,
  awayScore: 0,
  sourceObservation: ratingResultSource,
});
const ratingEvent = buildVerifiedRatingEventReference({
  ratingEventId: "rating-apply::pl-2026-27-prior-cp-mci",
  fixtureId: ratingFixture.fixtureId,
  fixtureKickoff: "2026-08-21T19:00:00.000Z",
  appliedAt: "2026-08-21T21:10:00.000Z",
  resultRevisionId: ratingResult.resultRevisionId,
  resultPayloadHash: ratingResult.resultPayloadHash,
  resultAvailableAt: ratingResult.availableAt,
  fixtureRevisionId: ratingFixture.fixtureRevisionId,
  fixturePayloadHash: ratingFixture.fixturePayloadHash,
  ratingUpdateInputs: {
    homeSlug: ratingFixture.homeSlug,
    awaySlug: ratingFixture.awaySlug,
    homeScore: 1,
    awayScore: 0,
    venue: "home",
    preHome: 1505,
    preAway: 1655,
    preHomeMatches: 0,
    preAwayMatches: 0,
    postHome: 1510,
    postAway: 1660,
    postHomeMatches: 1,
    postAwayMatches: 1,
    formulaVersion: "elo-pl-live-v0.2.0",
    modelVersion: "pl-live-v0.2.0",
    verificationEventId: "verified::pl-2026-27-prior-cp-mci",
  },
});

const ratingState = buildFrozenRatingState({
  season: "2026-27",
  asOf: cutoffAt,
  availableAt: "2026-08-21T21:10:00.000Z",
  modelVersion: "pl-live-v0.2.0",
  formulaVersion: "elo-pl-live-v0.2.0",
  seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
  ratingEvents: [ratingEvent],
  state: {
    season: "2026-27",
    clubSlugs: ["manchester-city", "crystal-palace"],
    ratings: { "manchester-city": 1660, "crystal-palace": 1510 },
    matchesPlayedSeason: { "crystal-palace": 1, "manchester-city": 1 },
  },
  ratingResultLineageStatus: "VERIFIED",
  featureCodeVersion: "sealed-pl-v1",
  codeCommitSha: commit,
});

const model = buildImmutableModelBundle({
  modelId: "premier-league-champion",
  modelVersion: "pl-live-v0.2.0",
  trainingCutoff: "2025-05-31T23:59:59.999Z",
  parameterPayload: { homeAdvantage: 72, dcRho: -0.061, kFactor: 20 },
  featureSchemaVersion: "pl-feature-schema-v1",
  featureCodeVersion: "sealed-pl-v1",
  createdAt: "2026-08-15T00:00:00.000Z",
  availableAt: "2026-08-15T00:00:00.000Z",
  codeCommitSha: commit,
});

const manifest = buildForecastInputManifest({
  fixtureId: fixture.fixtureId,
  season: "2026-27",
  forecastStage: "T24H",
  cutoffAt,
  generatedAt,
  kickoffAtAsKnown: kickoffAt,
  applicationCommitSha: commit,
  fixtureRevision: fixture,
  seasonMembership: membership,
  ratingState,
  modelBundle: model,
  ratingResultRevisions: [ratingResult],
  ratingFixtureRevisions: [ratingFixture],
});

test("canonical JSON and hashes ignore object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: { z: 3, y: 1 } }), canonicalJson({ a: { y: 1, z: 3 }, b: 2 }));
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
});

test("canonical JSON rejects undefined, non-finite numbers, and cycles", () => {
  assert.throws(() => canonicalJson({ missing: undefined }));
  assert.throws(() => canonicalJson({ bad: Number.NaN }));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle));
});

test("source payload hash is deterministic", () => {
  const reordered = buildSourceObservationReference({
    sourceType: "fixture",
    sourceId: "fixture-provider",
    sourceVersion: "v1",
    observationId: "fixture-provider::cp-mci::v1",
    publishedAt: "2026-08-27T18:59:00.000Z",
    retrievedAt: cutoffAt,
    availableAt: cutoffAt,
    payload: { status: "SCHEDULED", kickoffAt },
  });
  assert.equal(reordered.payloadHash, fixtureSource.payloadHash);
});

test("fixture revision is content addressed and deterministic", () => {
  assert.equal(
    buildFixtureRevision({
      season: fixture.season,
      fixtureId: fixture.fixtureId,
      homeSlug: fixture.homeSlug,
      awaySlug: fixture.awaySlug,
      kickoffAt: fixture.kickoffAt,
      status: fixture.status,
      venue: fixture.venue,
      sourceObservation: fixture.sourceObservation,
    }).fixtureRevisionId,
    fixture.fixtureRevisionId
  );
});

test("membership normalizes team and source ordering", () => {
  const again = buildSeasonMembershipSnapshot({
    season: membership.season,
    teamSlugs: ["crystal-palace", "manchester-city"],
    sourceObservations: [membershipSource],
    verificationStatus: membership.verificationStatus,
    verifiedAt: membership.verifiedAt,
    verifiedAgainst: membership.verifiedAgainst,
    verificationArtifact: membership.verificationArtifact,
  });
  assert.equal(again.seasonMembershipSnapshotId, membership.seasonMembershipSnapshotId);
  assert.deepEqual(again.teamSlugs, ["crystal-palace", "manchester-city"]);
});

test("rating state hash covers the exact normalized state", () => {
  const again = buildFrozenRatingState({
    season: "2026-27",
    asOf: cutoffAt,
    availableAt: ratingState.availableAt,
    modelVersion: ratingState.modelVersion,
    formulaVersion: ratingState.formulaVersion,
    seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
    ratingEvents: [ratingEvent],
    state: {
      season: "2026-27",
      clubSlugs: ["crystal-palace", "manchester-city"],
      ratings: { "crystal-palace": 1510, "manchester-city": 1660 },
      matchesPlayedSeason: { "manchester-city": 1, "crystal-palace": 1 },
    },
    ratingResultLineageStatus: "VERIFIED",
    featureCodeVersion: model.featureCodeVersion,
    codeCommitSha: commit,
  });
  assert.equal(again.ratingStateId, ratingState.ratingStateId);
  assert.equal(again.ratingStateHash, ratingState.ratingStateHash);
});

test("model parameter changes mint a new bundle", () => {
  const changed = buildImmutableModelBundle({
    modelId: model.modelId,
    modelVersion: model.modelVersion,
    trainingCutoff: model.trainingCutoff,
    parameterPayload: { homeAdvantage: 73, dcRho: -0.061, kFactor: 20 },
    featureSchemaVersion: model.featureSchemaVersion,
    featureCodeVersion: model.featureCodeVersion,
    createdAt: model.createdAt,
    availableAt: model.availableAt,
    codeCommitSha: model.codeCommitSha,
  });
  assert.notEqual(changed.modelBundleId, model.modelBundleId);
  assert.notEqual(changed.parameterHash, model.parameterHash);
});

test("cutoff equality is intentionally accepted", () => {
  assert.equal(manifest.latestIncludedInputAt, cutoffAt);
  assert.doesNotThrow(() => assertForecastInputManifestIntegrity(manifest));
});

test("manifest validates exact immutable references", () => {
  assert.doesNotThrow(() =>
    assertForecastInputManifestReferences(manifest, {
      fixtureRevision: fixture,
      seasonMembership: membership,
      ratingState,
      modelBundle: model,
      ratingResultRevisions: [ratingResult],
      ratingFixtureRevisions: [ratingFixture],
    })
  );
});

test("future source input is rejected", () => {
  const future = buildSourceObservationReference({
    sourceType: "result",
    sourceId: "future-source",
    observationId: "future-source::1",
    availableAt: "2026-08-27T19:00:00.001Z",
    payload: { homeScore: 1, awayScore: 0 },
  });
  assert.throws(
    () =>
      buildForecastInputManifest({
        fixtureId: fixture.fixtureId,
        season: "2026-27",
        forecastStage: "T24H",
        cutoffAt,
        generatedAt,
        kickoffAtAsKnown: kickoffAt,
        applicationCommitSha: commit,
        fixtureRevision: fixture,
        seasonMembership: membership,
        ratingState,
        modelBundle: model,
        ratingResultRevisions: [ratingResult],
        ratingFixtureRevisions: [ratingFixture],
        sourceObservations: [future],
      }),
    /after forecast cutoffAt/
  );
});

test("missing availableAt fails closed", () => {
  assert.throws(
    () =>
      buildSourceObservationReference({
        sourceType: "fixture",
        sourceId: "missing-time",
        observationId: "missing-time::1",
        availableAt: null as never,
        payload: {},
      }),
    /availableAt/
  );
});

test("generatedAt cannot precede cutoff or reach kickoff", () => {
  assert.throws(() =>
    assertPITTemporalInvariant({
      inputAvailableAt: [cutoffAt],
      cutoffAt,
      generatedAt: "2026-08-27T18:59:59.999Z",
      kickoffAtAsKnown: kickoffAt,
    })
  );
  assert.throws(() =>
    assertPITTemporalInvariant({
      inputAvailableAt: [cutoffAt],
      cutoffAt,
      generatedAt: kickoffAt,
      kickoffAtAsKnown: kickoffAt,
    })
  );
});

test("later reschedule does not change the old revision or manifest", () => {
  const laterSource = buildSourceObservationReference({
    sourceType: "fixture",
    sourceId: "fixture-provider",
    observationId: "fixture-provider::cp-mci::v2",
    availableAt: "2026-08-27T20:00:00.000Z",
    payload: { kickoffAt: "2026-08-29T19:00:00.000Z", status: "SCHEDULED" },
  });
  const later = buildFixtureRevision({
    season: fixture.season,
    fixtureId: fixture.fixtureId,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: "2026-08-29T19:00:00.000Z",
    status: fixture.status,
    venue: fixture.venue,
    sourceObservation: laterSource,
    supersedesFixtureRevisionId: fixture.fixtureRevisionId,
  });
  assert.equal(
    latestFixtureRevisionAtOrBefore([later, fixture], fixture.fixtureId, cutoffAt)
      ?.fixtureRevisionId,
    fixture.fixtureRevisionId
  );
  assert.equal(manifest.kickoffAtAsKnown, kickoffAt);
});

test("result corrections are separate immutable links", () => {
  const source1 = buildSourceObservationReference({
    sourceType: "result",
    sourceId: "result-provider",
    observationId: "result-provider::match::1",
    availableAt: "2026-08-30T21:00:00.000Z",
    payload: { status: "FINISHED", homeScore: 1, awayScore: 0 },
  });
  const first = buildResultRevision({
    season: "2026-27",
    fixtureId: fixture.fixtureId,
    status: "FINISHED",
    homeScore: 1,
    awayScore: 0,
    sourceObservation: source1,
  });
  const source2 = buildSourceObservationReference({
    sourceType: "result",
    sourceId: "result-provider",
    observationId: "result-provider::match::2",
    availableAt: "2026-08-30T22:00:00.000Z",
    payload: { status: "FINISHED", homeScore: 1, awayScore: 1 },
  });
  const corrected = buildResultRevision({
    season: "2026-27",
    fixtureId: fixture.fixtureId,
    status: "FINISHED",
    homeScore: 1,
    awayScore: 1,
    sourceObservation: source2,
    supersedesResultRevisionId: first.resultRevisionId,
  });
  const link = buildResultCorrection({
    fixtureId: fixture.fixtureId,
    previousResultRevisionId: first.resultRevisionId,
    correctedResultRevisionId: corrected.resultRevisionId,
    detectedAt: source2.availableAt,
    availableAt: source2.availableAt,
  });
  assert.equal(corrected.supersedesResultRevisionId, first.resultRevisionId);
  assert.notEqual(link.previousResultRevisionId, link.correctedResultRevisionId);
});

test("manifest tampering is detected", () => {
  const tampered = structuredClone(manifest);
  (tampered as { latestIncludedInputAt: string }).latestIncludedInputAt = model.availableAt;
  assert.throws(() => assertForecastInputManifestIntegrity(tampered));
});

test("legacy lineage is not silently upgraded", () => {
  assert.equal(classifyForecastLineage({}), "LEGACY_UNAVAILABLE");
  assert.equal(
    classifyForecastLineage({ manifestId: manifest.manifestId, manifestVerified: false }),
    "PIT_INCOMPLETE"
  );
  assert.equal(
    classifyForecastLineage({
      manifestId: manifest.manifestId,
      manifestVerified: true,
      stageTimingValid: true,
    }),
    "PIT_VERIFIED"
  );
});

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "foa-provenance-"));
try {
  test("immutable JSONL insert is idempotent", () => {
    const store = fixtureRevisionStore(path.join(temp, "fixtures.jsonl"));
    assert.equal(store.insert(fixture).status, "inserted");
    assert.equal(store.insert(fixture).status, "duplicate");
    assert.equal(store.size, 1);
    assert.equal(fs.readFileSync(path.join(temp, "fixtures.jsonl"), "utf8").trim().split("\n").length, 1);
  });

  test("same immutable id with different content fails as a collision", () => {
    const store = fixtureRevisionStore(path.join(temp, "fixtures.jsonl"));
    const conflicting = {
      ...structuredClone(fixture),
      status: "POSTPONED",
    } as FixtureRevisionRecord;
    assert.throws(() => store.insert(conflicting), ImmutableRecordCollisionError);
  });

  test("corrupt immutable JSONL fails closed", () => {
    const file = path.join(temp, "corrupt.jsonl");
    fs.writeFileSync(file, `${JSON.stringify(fixture)}\n{broken\n`, "utf8");
    const store = fixtureRevisionStore(file);
    assert.throws(() => store.list(), /invalid immutable provenance JSONL/);
    assert.throws(
      () => store.insert(fixture),
      /invalid immutable provenance JSONL/,
      "the same store instance must retry full validation instead of using a partial cache"
    );
    assert.equal(
      fs.readFileSync(file, "utf8"),
      `${JSON.stringify(fixture)}\n{broken\n`,
      "a retry against corrupt evidence must never append"
    );
  });

  test("append failure forces same-instance disk revalidation before retry", () => {
    const blockedParent = path.join(temp, "append-blocked-parent");
    const file = path.join(blockedParent, "fixtures.jsonl");
    fs.writeFileSync(blockedParent, "not a directory", "utf8");
    const store = fixtureRevisionStore(file);
    assert.throws(() => store.insert(fixture));

    fs.unlinkSync(blockedParent);
    fs.mkdirSync(blockedParent);
    fs.writeFileSync(file, "{partial-append\n", "utf8");
    assert.throws(
      () => store.insert(fixture),
      /invalid immutable provenance JSONL/,
      "retry must inspect possible partial bytes left by the failed append"
    );
    assert.equal(fs.readFileSync(file, "utf8"), "{partial-append\n");
  });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`\nPhase 4A.3 provenance foundation: ${passed} passed, 0 failed`);
