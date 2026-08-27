import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFixtureRevision,
  buildForecastInputManifest,
  buildFrozenRatingState,
  buildImmutableModelBundle,
  buildVerifiedRatingEventReference,
  buildResultCorrection,
  buildResultRevision,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
  provenanceRecordId,
  type ProvenanceRecord,
} from "@/lib/competitions/premier-league/provenance";
import {
  insertProvenanceRecords,
  listAllProvenanceRecords,
  mergeProvenanceRecordsJsonl,
  parseProvenanceRecordsJsonl,
  replaceProvenanceRecordsFromJsonl,
  serializeProvenanceRecordsJsonl,
  type ProvenanceFilePathMap,
} from "@/lib/competitions/premier-league/provenance/durable";
import { ImmutableRecordCollisionError } from "@/lib/competitions/premier-league/provenance/store";
import {
  applyBundleToDisk,
  buildImmutableProvenanceMongoUpserts,
  captureBundleFromDisk,
  decodeMongoBundleFromStorage,
  mergeMongoProvenanceDocumentsWithLegacy,
  mongoBundleForWrite,
  requireCompleteMongoStoredBundle,
  routeDurablePaths,
  validateDurableBundle,
  type DurableBundle,
  type MongoProvenanceRecordDocument,
} from "@/lib/competitions/premier-league/ops/durable-store";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function pathsIn(directory: string): ProvenanceFilePathMap {
  return {
    FIXTURE_REVISION: path.join(directory, "fixture-revisions.jsonl"),
    RESULT_REVISION: path.join(directory, "result-revisions.jsonl"),
    RESULT_CORRECTION: path.join(directory, "result-corrections.jsonl"),
    SEASON_MEMBERSHIP: path.join(directory, "season-membership.jsonl"),
    RATING_STATE: path.join(directory, "rating-states.jsonl"),
    MODEL_BUNDLE: path.join(directory, "model-bundles.jsonl"),
    FORECAST_INPUT_MANIFEST: path.join(directory, "forecast-input-manifests.jsonl"),
  };
}

function opsBundle(provenanceRecords?: string): DurableBundle {
  return {
    jobs: "",
    sourceObservations: "",
    scheduleRevisions: "",
    resultObservations: "",
    resultVerifications: "",
    ratingEvents: "",
    ratingState: "",
    tickState: "",
    settlementCorrections: "",
    operationalLiveOos: "",
    settlements: "",
    workingSnapshots: "",
    contextSnapshots: "",
    ...(provenanceRecords === undefined ? {} : { provenanceRecords }),
    fixturesOverlay: "",
  };
}

const cutoffAt = "2026-08-27T19:00:00.000Z";
const generatedAt = "2026-08-27T19:01:00.000Z";
const kickoffAt = "2026-08-28T19:00:00.000Z";
const commitSha = "b".repeat(40);

const membershipSource = buildSourceObservationReference({
  sourceType: "season-membership",
  sourceId: "membership-feed",
  observationId: "membership::2026-27::1",
  availableAt: "2026-08-01T09:00:00.000Z",
  retrievedAt: "2026-08-01T09:00:00.000Z",
  payload: { teams: ["arsenal", "chelsea"] },
});
const membership = buildSeasonMembershipSnapshot({
  season: "2026-27",
  teamSlugs: ["chelsea", "arsenal"],
  sourceObservations: [membershipSource],
  verificationStatus: "VERIFIED",
  verifiedAt: "2026-08-01T09:00:00.000Z",
  verifiedAgainst: ["independent-membership-audit"],
  verificationArtifact: "phase4a3-membership-audit",
});
const fixtureSource = buildSourceObservationReference({
  sourceType: "fixture",
  sourceId: "fixture-feed",
  observationId: "fixture::ars-che::1",
  availableAt: "2026-08-27T18:00:00.000Z",
  retrievedAt: "2026-08-27T18:00:00.000Z",
  payload: { kickoffAt, home: "arsenal", away: "chelsea" },
});
const fixture = buildFixtureRevision({
  season: "2026-27",
  fixtureId: "pl-2026-27-arsenal-chelsea",
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  kickoffAt,
  status: "SCHEDULED",
  sourceObservation: fixtureSource,
});
const resultSource = buildSourceObservationReference({
  sourceType: "result",
  sourceId: "result-feed",
  observationId: "result::old-fixture::1",
  availableAt: "2026-08-21T22:00:00.000Z",
  retrievedAt: "2026-08-21T22:00:00.000Z",
  payload: { homeScore: 1, awayScore: 0, status: "FINISHED" },
});
const result = buildResultRevision({
  season: "2026-27",
  fixtureId: "pl-2026-27-old-fixture",
  status: "FINISHED",
  homeScore: 1,
  awayScore: 0,
  sourceObservation: resultSource,
});
const correctedResultSource = buildSourceObservationReference({
  sourceType: "result",
  sourceId: "result-feed",
  observationId: "result::old-fixture::2",
  availableAt: "2026-08-22T08:00:00.000Z",
  retrievedAt: "2026-08-22T08:00:00.000Z",
  payload: { homeScore: 1, awayScore: 1, status: "FINISHED" },
});
const correctedResult = buildResultRevision({
  season: "2026-27",
  fixtureId: result.fixtureId,
  status: "FINISHED",
  homeScore: 1,
  awayScore: 1,
  sourceObservation: correctedResultSource,
  supersedesResultRevisionId: result.resultRevisionId,
});
const correction = buildResultCorrection({
  fixtureId: result.fixtureId,
  previousResultRevisionId: result.resultRevisionId,
  correctedResultRevisionId: correctedResult.resultRevisionId,
  detectedAt: "2026-08-22T08:00:00.000Z",
  availableAt: "2026-08-22T08:00:00.000Z",
});
const ratingFixtureSource = buildSourceObservationReference({
  sourceType: "fixture",
  sourceId: "fixture-feed",
  observationId: "fixture::old-fixture::1",
  availableAt: "2026-08-21T18:00:00.000Z",
  payload: { status: "FINISHED", kickoffAt: "2026-08-21T19:00:00.000Z" },
});
const ratingFixture = buildFixtureRevision({
  season: "2026-27",
  fixtureId: result.fixtureId,
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  kickoffAt: "2026-08-21T19:00:00.000Z",
  status: "FINISHED",
  venue: "home",
  sourceObservation: ratingFixtureSource,
});
const ratingEvent = buildVerifiedRatingEventReference({
  ratingEventId: "rating::old-fixture::2",
  fixtureId: result.fixtureId,
  fixtureKickoff: "2026-08-21T19:00:00.000Z",
  appliedAt: "2026-08-22T08:01:00.000Z",
  availableAt: "2026-08-22T08:01:00.000Z",
  resultRevisionId: correctedResult.resultRevisionId,
  resultPayloadHash: correctedResult.resultPayloadHash,
  resultAvailableAt: correctedResult.availableAt,
  fixtureRevisionId: ratingFixture.fixtureRevisionId,
  fixturePayloadHash: ratingFixture.fixturePayloadHash,
  ratingUpdateInputs: {
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    homeScore: 1,
    awayScore: 1,
    venue: "home",
    preHome: 1600,
    preAway: 1560,
    preHomeMatches: 0,
    preAwayMatches: 0,
    postHome: 1610,
    postAway: 1550,
    postHomeMatches: 1,
    postAwayMatches: 1,
    formulaVersion: "elo-v1",
    modelVersion: "pl-live-v0.2.0",
    verificationEventId: "verified::old-fixture",
  },
});
const ratingState = buildFrozenRatingState({
  season: "2026-27",
  asOf: cutoffAt,
  availableAt: "2026-08-22T08:01:00.000Z",
  modelVersion: "pl-live-v0.2.0",
  formulaVersion: "elo-v1",
  seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
  ratingEvents: [ratingEvent],
  state: {
    season: "2026-27",
    clubSlugs: ["arsenal", "chelsea"],
    ratings: { arsenal: 1610, chelsea: 1550 },
    matchesPlayedSeason: { arsenal: 1, chelsea: 1 },
  },
  ratingResultLineageStatus: "VERIFIED",
  featureCodeVersion: "sealed-v1",
  codeCommitSha: commitSha,
});
const modelBundle = buildImmutableModelBundle({
  modelId: "premier-league-champion",
  modelVersion: "pl-live-v0.2.0",
  trainingCutoff: "2025-05-31T23:59:59.999Z",
  parameterPayload: { homeAdvantage: 72, kFactor: 20 },
  featureSchemaVersion: "pl-feature-v1",
  featureCodeVersion: "sealed-v1",
  createdAt: "2026-08-01T00:00:00.000Z",
  availableAt: "2026-08-01T00:00:00.000Z",
  codeCommitSha: commitSha,
});
const manifest = buildForecastInputManifest({
  fixtureId: fixture.fixtureId,
  season: fixture.season,
  forecastStage: "T24H",
  cutoffAt,
  generatedAt,
  kickoffAtAsKnown: kickoffAt,
  applicationCommitSha: commitSha,
  fixtureRevision: fixture,
  seasonMembership: membership,
  ratingState,
  modelBundle,
  ratingResultRevisions: [correctedResult],
  ratingFixtureRevisions: [ratingFixture],
});

const records: ProvenanceRecord[] = [
  fixture,
  ratingFixture,
  result,
  correctedResult,
  correction,
  membership,
  ratingState,
  modelBundle,
  manifest,
];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foa-provenance-durable-"));
try {
  test("all provenance kinds round-trip through canonical mixed JSONL", () => {
    const serialized = serializeProvenanceRecordsJsonl(records.slice().reverse());
    const parsed = parseProvenanceRecordsJsonl(serialized);
    assert.equal(parsed.length, records.length);
    assert.deepEqual(
      parsed.map(provenanceRecordId),
      parseProvenanceRecordsJsonl(serializeProvenanceRecordsJsonl(parsed)).map(
        provenanceRecordId
      )
    );
    assert.equal(new Set(parsed.map((record) => record.recordKind)).size, 7);
  });

  test("strict parser rejects corrupt JSON", () => {
    assert.throws(() => parseProvenanceRecordsJsonl('{"recordKind":'), /invalid JSON/);
  });

  test("merge de-duplicates identical immutable records", () => {
    const source = serializeProvenanceRecordsJsonl(records);
    assert.equal(mergeProvenanceRecordsJsonl(source, source), source);
  });

  test("merge fails on one immutable id with differing content", () => {
    const altered = { ...fixture, status: "POSTPONED" };
    assert.throws(
      () =>
        mergeProvenanceRecordsJsonl(
          serializeProvenanceRecordsJsonl([fixture]),
          `${JSON.stringify(altered)}\n`
        ),
      ImmutableRecordCollisionError
    );
  });

  test("atomic per-kind replacement round-trips every kind", () => {
    const paths = pathsIn(path.join(tempRoot, "replace"));
    const serialized = serializeProvenanceRecordsJsonl(records);
    replaceProvenanceRecordsFromJsonl(serialized, paths);
    assert.equal(serializeProvenanceRecordsJsonl(listAllProvenanceRecords(paths)), serialized);
    for (const filePath of Object.values(paths)) assert.equal(fs.existsSync(filePath), true);
    assert.equal(
      fs.readdirSync(path.dirname(paths.FIXTURE_REVISION)).some((name) => name.endsWith(".tmp")),
      false
    );
  });

  test("invalid replacement is rejected before any tape changes", () => {
    const paths = pathsIn(path.join(tempRoot, "fail-closed"));
    replaceProvenanceRecordsFromJsonl(serializeProvenanceRecordsJsonl(records), paths);
    const before = Object.fromEntries(
      Object.entries(paths).map(([kind, filePath]) => [kind, fs.readFileSync(filePath, "utf8")])
    );
    assert.throws(
      () =>
        replaceProvenanceRecordsFromJsonl(
          `${serializeProvenanceRecordsJsonl([fixture])}{bad-json\n`,
          paths
        ),
      /invalid JSON/
    );
    for (const [kind, filePath] of Object.entries(paths)) {
      assert.equal(fs.readFileSync(filePath, "utf8"), before[kind]);
    }
  });

  test("replacement is exact and empties absent per-kind tapes", () => {
    const paths = pathsIn(path.join(tempRoot, "exact"));
    replaceProvenanceRecordsFromJsonl(serializeProvenanceRecordsJsonl(records), paths);
    replaceProvenanceRecordsFromJsonl(serializeProvenanceRecordsJsonl([fixture]), paths);
    assert.deepEqual(listAllProvenanceRecords(paths).map(provenanceRecordId), [
      fixture.fixtureRevisionId,
    ]);
    assert.equal(fs.readFileSync(paths.MODEL_BUNDLE, "utf8"), "");
  });

  test("routed inserts are idempotent for all record kinds", () => {
    const paths = pathsIn(path.join(tempRoot, "insert"));
    const first = insertProvenanceRecords(records, paths);
    const retry = insertProvenanceRecords(records, paths);
    assert.equal(first.inserted.length, records.length);
    assert.equal(first.duplicates.length, 0);
    assert.equal(retry.inserted.length, 0);
    assert.equal(retry.duplicates.length, records.length);
    assert.equal(listAllProvenanceRecords(paths).length, records.length);
  });

  test("old bundles without provenance remain valid", () => {
    const oldBundle = opsBundle();
    const validated = validateDurableBundle(oldBundle);
    assert.equal(validated.provenanceRecords, "");
    assert.doesNotThrow(() => requireCompleteMongoStoredBundle(oldBundle));
  });

  test("Mongo parent bundle omits dedicated provenance bytes", () => {
    const provenance = serializeProvenanceRecordsJsonl(records);
    const stored = mongoBundleForWrite(opsBundle(provenance), false);
    assert.equal(Object.hasOwn(stored, "provenanceRecords"), false);
    assert.equal(decodeMongoBundleFromStorage(stored).provenanceRecords, "");
  });

  test("Mongo provenance operations are insert-only and content addressed", () => {
    const operations = buildImmutableProvenanceMongoUpserts(
      serializeProvenanceRecordsJsonl(records),
      "2026-08-27T20:00:00.000Z"
    );
    assert.equal(operations.length, records.length);
    for (const [index, operation] of operations.entries()) {
      assert.ok("updateOne" in operation);
      if (!("updateOne" in operation)) continue;
      const expected = parseProvenanceRecordsJsonl(
        serializeProvenanceRecordsJsonl(records)
      )[index];
      assert.deepEqual(operation.updateOne.filter, {
        _id: provenanceRecordId(expected),
      });
      assert.equal(operation.updateOne.upsert, true);
      assert.ok("$setOnInsert" in operation.updateOne.update);
    }
  });

  test("Mongo collection merge validates IDs, integrity, and legacy collisions", () => {
    const insertedAt = "2026-08-27T20:00:00.000Z";
    const documents: MongoProvenanceRecordDocument[] = records.map((record) => ({
      _id: provenanceRecordId(record),
      record,
      insertedAt,
    }));
    const all = serializeProvenanceRecordsJsonl(records);
    assert.equal(
      mergeMongoProvenanceDocumentsWithLegacy(
        documents,
        serializeProvenanceRecordsJsonl([fixture])
      ),
      all
    );
    assert.throws(
      () =>
        mergeMongoProvenanceDocumentsWithLegacy(
          [{ ...documents[0], _id: "wrong-id" }],
          ""
        ),
      /mismatched _id/
    );
    assert.throws(
      () =>
        mergeMongoProvenanceDocumentsWithLegacy(
          documents,
          `${JSON.stringify({ ...fixture, status: "POSTPONED" })}\n`
        ),
      ImmutableRecordCollisionError
    );
  });

  test("durable capture and hydration preserve provenance child-first", () => {
    const work = path.join(tempRoot, "ops-integration");
    process.env.PL_DURABLE_WORK_DIR = work;
    for (const name of [
      "PL_PIT_FIXTURE_REVISION_PATH",
      "PL_PIT_RESULT_REVISION_PATH",
      "PL_PIT_RESULT_CORRECTION_PATH",
      "PL_PIT_MEMBERSHIP_PATH",
      "PL_PIT_RATING_STATE_PATH",
      "PL_PIT_MODEL_BUNDLE_PATH",
      "PL_PIT_MANIFEST_PATH",
    ]) {
      delete process.env[name];
    }
    routeDurablePaths(work);
    assert.equal(process.env.PL_PROVENANCE_DIR, path.join(work, "ops", "provenance"));
    insertProvenanceRecords(records);
    const captured = captureBundleFromDisk();
    assert.equal(captured.provenanceRecords, serializeProvenanceRecordsJsonl(records));
    replaceProvenanceRecordsFromJsonl("");
    assert.equal(listAllProvenanceRecords().length, 0);
    applyBundleToDisk(captured);
    assert.equal(
      serializeProvenanceRecordsJsonl(listAllProvenanceRecords()),
      captured.provenanceRecords
    );
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\nPhase 4A.3 durable provenance adapter: ${passed} passed, 0 failed`);
