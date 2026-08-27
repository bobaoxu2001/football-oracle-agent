/** Phase 4A4 isolated ops-backup/provenance recovery gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import {
  buildFixtureRevision,
  buildFrozenRatingState,
  buildResultCorrection,
  buildResultRevision,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
} from "@/lib/competitions/premier-league/provenance/manifest";
import { assembleMatchContext } from "@/lib/competitions/premier-league/context";
import { canonicalJson } from "@/lib/competitions/premier-league/provenance/canonical";
import type {
  MongoContextSnapshotDocument,
  MongoProvenanceRecordDocument,
} from "@/lib/competitions/premier-league/ops/durable-store";
import type { ProvenanceRecord } from "@/lib/competitions/premier-league/provenance/types";
import {
  BACKUP_SCHEMA,
  PROVENANCE_COLLECTION,
  assertNotTape,
  buildProvenanceBackupSection,
  exactContextDocumentsForRestore,
  provenanceManifest,
  requireProvenanceBackupSection,
  requireProvenanceDocuments,
  requireResolvedProvenanceGraph,
  restoreImmutableContextDocuments,
  restoreImmutableProvenanceDocuments,
} from "./export-ops-bundle";

const INSERTED_AT = "2026-08-27T10:00:00.000Z";

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function source(id: string, availableAt: string, payload: unknown) {
  return buildSourceObservationReference({
    sourceType: "phase4a4-backup-test",
    sourceId: id,
    sourceVersion: "v1",
    observationId: `observation-${id}`,
    publishedAt: availableAt,
    retrievedAt: availableAt,
    availableAt,
    payload,
  });
}

const fixture = buildFixtureRevision({
  season: "2026-27",
  fixtureId: "backup-arsenal-chelsea",
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  kickoffAt: "2026-08-28T19:00:00.000Z",
  kickoffCertainty: "CONFIRMED",
  status: "SCHEDULED",
  venue: "Backup Test Stadium",
  sourceObservation: source(
    "fixture",
    "2026-08-27T09:00:00.000Z",
    { kickoffAt: "2026-08-28T19:00:00.000Z" }
  ),
});

const result = buildResultRevision({
  season: "2026-27",
  fixtureId: "backup-finished-fixture",
  status: "FINISHED",
  homeScore: 2,
  awayScore: 1,
  sourceObservation: source(
    "result",
    "2026-08-20T20:00:00.000Z",
    { status: "FINISHED", homeScore: 2, awayScore: 1 }
  ),
});

const membership = buildSeasonMembershipSnapshot({
  season: "2026-27",
  teamSlugs: ["arsenal", "chelsea"],
  sourceObservations: [
    source("membership", "2026-08-01T00:00:00.000Z", {
      teamSlugs: ["arsenal", "chelsea"],
    }),
  ],
  verificationStatus: "VERIFIED",
  verifiedAt: "2026-08-01T00:00:00.000Z",
  verifiedAgainst: ["independent-membership-audit"],
  verificationArtifact: "phase4a4-membership-audit",
});

function documents(records: readonly ProvenanceRecord[]): MongoProvenanceRecordDocument[] {
  return records
    .map((record) => ({
      _id:
        record.recordKind === "FIXTURE_REVISION"
          ? record.fixtureRevisionId
          : record.recordKind === "RESULT_REVISION"
            ? record.resultRevisionId
            : record.recordKind === "SEASON_MEMBERSHIP"
              ? record.seasonMembershipSnapshotId
              : (() => {
                  throw new Error(`unsupported test record ${record.recordKind}`);
                })(),
      record,
      insertedAt: INSERTED_AT,
    }))
    .sort((a, b) => a._id.localeCompare(b._id));
}

class FakeImmutableCollection {
  readonly rows = new Map<string, MongoProvenanceRecordDocument>();
  readonly writes: AnyBulkWriteOperation<MongoProvenanceRecordDocument>[][] = [];

  constructor(initial: readonly MongoProvenanceRecordDocument[] = []) {
    for (const document of initial) this.rows.set(document._id, clone(document));
  }

  async bulkWrite(
    operations: AnyBulkWriteOperation<MongoProvenanceRecordDocument>[]
  ): Promise<Record<string, never>> {
    this.writes.push(clone(operations));
    for (const operation of operations) {
      if (!("updateOne" in operation)) throw new Error("test accepts updateOne only");
      const { filter, update, upsert } = operation.updateOne;
      assert.equal(upsert, true);
      assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
      const id = String(filter._id);
      if (!this.rows.has(id)) {
        const inserted = (update as {
          $setOnInsert: Omit<MongoProvenanceRecordDocument, "_id">;
        }).$setOnInsert;
        this.rows.set(id, clone({ _id: id, ...inserted }));
      }
    }
    return {};
  }

  find(filter: { _id: { $in: readonly string[] } }) {
    const selected = filter._id.$in
      .map((id) => this.rows.get(id))
      .filter((document): document is MongoProvenanceRecordDocument => Boolean(document));
    return {
      sort: () => ({
        toArray: async () => selected.slice().sort((a, b) => a._id.localeCompare(b._id)).map(clone),
      }),
    };
  }
}

class FakeImmutableContextCollection {
  readonly rows = new Map<string, MongoContextSnapshotDocument>();
  readonly writes: AnyBulkWriteOperation<MongoContextSnapshotDocument>[][] = [];

  constructor(initial: readonly MongoContextSnapshotDocument[] = []) {
    for (const document of initial) this.rows.set(document._id, clone(document));
  }

  async bulkWrite(
    operations: AnyBulkWriteOperation<MongoContextSnapshotDocument>[]
  ): Promise<Record<string, never>> {
    this.writes.push(clone(operations));
    for (const operation of operations) {
      if (!("updateOne" in operation)) throw new Error("test accepts updateOne only");
      const { filter, update, upsert } = operation.updateOne;
      assert.equal(upsert, true);
      assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
      const id = String(filter._id);
      if (!this.rows.has(id)) {
        const inserted = (update as {
          $setOnInsert: Omit<MongoContextSnapshotDocument, "_id">;
        }).$setOnInsert;
        this.rows.set(id, clone({ _id: id, ...inserted }));
      }
    }
    return {};
  }

  find(filter: { _id: { $in: readonly string[] } }) {
    const selected = filter._id.$in
      .map((id) => this.rows.get(id))
      .filter((document): document is MongoContextSnapshotDocument => Boolean(document));
    return {
      sort: () => ({
        toArray: async () => selected.slice().sort((a, b) => a._id.localeCompare(b._id)).map(clone),
      }),
    };
  }
}

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main(): Promise<void> {
  console.log("\nPhase 4A4 ops backup / immutable provenance restore");
  const backupDocuments = documents([fixture, result]);

  await check("Q1 backup schema and dedicated collection are v3", () => {
    assert.equal(BACKUP_SCHEMA, "football-oracle-ops-backup-v3");
    assert.equal(PROVENANCE_COLLECTION, "pl_provenance_records");
  });

  await check("Q2 exact documents are sorted and content-address validated", () => {
    assert.deepEqual(
      requireProvenanceDocuments(backupDocuments, "test backup"),
      backupDocuments
    );
    assert.throws(
      () => requireProvenanceDocuments(backupDocuments.slice().reverse(), "unsorted backup"),
      /sorted by _id/
    );
  });

  await check("Q3 duplicate provenance ids fail closed", () => {
    assert.throws(
      () => requireProvenanceDocuments(
        [backupDocuments[0], backupDocuments[0]],
        "duplicate backup"
      ),
      /duplicate _id/
    );
  });

  await check("Q4 tampered content address fails closed", () => {
    const tampered = clone(backupDocuments);
    const fixtureDocument = tampered.find(
      (document) => document.record.recordKind === "FIXTURE_REVISION"
    );
    assert.ok(fixtureDocument);
    (fixtureDocument.record as { status: string }).status = "POSTPONED";
    assert.throws(
      () => requireProvenanceDocuments(tampered, "tampered backup"),
      /integrity|mismatch/i
    );
  });

  await check("Q5 manifest count, per-kind counts and hash are deterministic", () => {
    const first = provenanceManifest(backupDocuments);
    const second = provenanceManifest(clone(backupDocuments));
    assert.deepEqual(first, second);
    assert.equal(first.count, 2);
    assert.equal(first.countsByKind.FIXTURE_REVISION, 1);
    assert.equal(first.countsByKind.RESULT_REVISION, 1);
    assert.equal(first.countsByKind.FORECAST_INPUT_MANIFEST, 0);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
  });

  await check("Q5a provenance survives a serialized backup round-trip", async () => {
    const section = buildProvenanceBackupSection(backupDocuments);
    const serialized = JSON.stringify(section);
    const recovered = requireProvenanceBackupSection(
      JSON.parse(serialized) as unknown,
      "serialized backup"
    );
    const fake = new FakeImmutableCollection();
    await restoreImmutableProvenanceDocuments(
      fake as unknown as Collection<MongoProvenanceRecordDocument>,
      recovered.provenanceDocuments
    );
    assert.deepEqual(
      [...fake.rows.values()].sort((a, b) => a._id.localeCompare(b._id)),
      backupDocuments
    );
  });

  await check("Q5b checksum mismatch fails before any restore write", () => {
    const section = clone(buildProvenanceBackupSection(backupDocuments));
    section.provenanceSha256 = "0".repeat(64);
    const fake = new FakeImmutableCollection();
    assert.throws(
      () => requireProvenanceBackupSection(section, "corrupt backup"),
      /count\/per-kind\/checksum mismatch/
    );
    assert.equal(fake.writes.length, 0);
  });

  await check("Q6 unresolved supersession edges fail closed", () => {
    const corrected = buildResultRevision({
      season: result.season,
      fixtureId: result.fixtureId,
      status: "FINISHED",
      homeScore: 3,
      awayScore: 1,
      sourceObservation: source(
        "corrected-result",
        "2026-08-21T20:00:00.000Z",
        { status: "FINISHED", homeScore: 3, awayScore: 1 }
      ),
      supersedesResultRevisionId: result.resultRevisionId,
    });
    assert.throws(
      () => requireResolvedProvenanceGraph([corrected]),
      /missing provenance record/
    );
    requireResolvedProvenanceGraph([result, corrected]);
  });

  await check("Q7 first restore inserts exact immutable documents", async () => {
    const fake = new FakeImmutableCollection();
    const count = await restoreImmutableProvenanceDocuments(
      fake as unknown as Collection<MongoProvenanceRecordDocument>,
      backupDocuments
    );
    assert.equal(count, 2);
    assert.equal(fake.rows.size, 2);
    assert.deepEqual(
      [...fake.rows.values()].sort((a, b) => a._id.localeCompare(b._id)),
      backupDocuments
    );
  });

  await check("Q8 retry is idempotent and uses only $setOnInsert", async () => {
    const fake = new FakeImmutableCollection(backupDocuments);
    await restoreImmutableProvenanceDocuments(
      fake as unknown as Collection<MongoProvenanceRecordDocument>,
      backupDocuments
    );
    await restoreImmutableProvenanceDocuments(
      fake as unknown as Collection<MongoProvenanceRecordDocument>,
      backupDocuments
    );
    assert.equal(fake.rows.size, 2);
    assert.equal(fake.writes.length, 2);
    for (const batch of fake.writes) {
      for (const operation of batch) {
        assert.ok("updateOne" in operation);
        if ("updateOne" in operation) {
          assert.deepEqual(Object.keys(operation.updateOne.update), ["$setOnInsert"]);
        }
      }
    }
  });

  await check("Q9 restore preserves unrelated newer provenance", async () => {
    const extra = documents([membership]);
    const fake = new FakeImmutableCollection(extra);
    await restoreImmutableProvenanceDocuments(
      fake as unknown as Collection<MongoProvenanceRecordDocument>,
      backupDocuments
    );
    assert.equal(fake.rows.size, 3);
    assert.deepEqual(fake.rows.get(extra[0]._id), extra[0]);
  });

  await check("Q10 same-id conflict is never overwritten", async () => {
    const conflicting = clone(backupDocuments);
    conflicting[0].insertedAt = "2026-08-27T10:00:01.000Z";
    const fake = new FakeImmutableCollection(conflicting);
    await assert.rejects(
      restoreImmutableProvenanceDocuments(
        fake as unknown as Collection<MongoProvenanceRecordDocument>,
        backupDocuments
      ),
      /read-back mismatch/
    );
    assert.equal(fake.rows.get(conflicting[0]._id)?.insertedAt, conflicting[0].insertedAt);
  });

  await check("Q11 empty provenance backup is valid and deterministic", () => {
    assert.deepEqual(requireProvenanceDocuments([], "empty backup"), []);
    const summary = provenanceManifest([]);
    assert.equal(summary.count, 0);
    assert.equal(summary.sha256, createEmptySha256());
  });

  await check("Q12 test path has no production database dependency", () => {
    assert.equal(typeof (new FakeImmutableCollection()).find, "function");
    assert.doesNotMatch(
      restoreImmutableProvenanceDocuments.toString(),
      /getMongoDb|MONGODB_URI/
    );
    const restoreSource = fs.readFileSync("scripts/export-ops-bundle.ts", "utf8");
    assert.doesNotMatch(restoreSource, /contexts\.deleteMany/);
    assert.match(restoreSource, /restoreDeadline = Date\.now\(\) \+ 60_000/);
  });

  await check("Q13 semantically incompatible correction edges fail closed", () => {
    const crossSupersession = buildResultRevision({
      season: result.season,
      fixtureId: "backup-other-finished-fixture",
      status: "FINISHED",
      homeScore: 3,
      awayScore: 1,
      sourceObservation: source(
        "cross-fixture-result",
        "2026-08-21T20:00:00.000Z",
        { status: "FINISHED", homeScore: 3, awayScore: 1 }
      ),
      supersedesResultRevisionId: result.resultRevisionId,
    });
    assert.throws(
      () => requireResolvedProvenanceGraph([result, crossSupersession]),
      /incompatible result supersession/
    );
    const crossFixture = buildResultRevision({
      season: result.season,
      fixtureId: "backup-other-finished-fixture",
      status: "FINISHED",
      homeScore: 3,
      awayScore: 1,
      sourceObservation: source(
        "cross-fixture-correction",
        "2026-08-21T20:00:00.000Z",
        { status: "FINISHED", homeScore: 3, awayScore: 1 }
      ),
    });
    const invalidCorrection = buildResultCorrection({
      fixtureId: crossFixture.fixtureId,
      previousResultRevisionId: result.resultRevisionId,
      correctedResultRevisionId: crossFixture.resultRevisionId,
      detectedAt: "2026-08-21T20:00:00.000Z",
      availableAt: "2026-08-21T20:00:00.000Z",
    });
    assert.throws(
      () => requireResolvedProvenanceGraph([result, crossFixture, invalidCorrection]),
      /incompatible result-correction lineage/
    );
  });

  const context = assembleMatchContext({
    season: "2026-27",
    fixtureId: fixture.fixtureId,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: fixture.kickoffAt,
    cutoffAt: "2026-08-27T09:00:00.000Z",
    generatedAt: "2026-08-27T09:00:01.000Z",
    forecastSnapshotKey: "phase4a4-backup-context",
    evidence: [],
  }).snapshot;
  const contextDocument: MongoContextSnapshotDocument = {
    _id: context.contextId,
    snapshot: context,
    insertedAt: INSERTED_AT,
  };

  await check("Q14 context restore is insert-only, idempotent, and preserves newer rows", async () => {
    const newer = assembleMatchContext({
      season: "2026-27",
      fixtureId: fixture.fixtureId,
      homeSlug: fixture.homeSlug,
      awaySlug: fixture.awaySlug,
      kickoffAt: fixture.kickoffAt,
      cutoffAt: "2026-08-27T10:00:00.000Z",
      generatedAt: "2026-08-27T10:00:01.000Z",
      forecastSnapshotKey: "phase4a4-newer-context",
      evidence: [],
    }).snapshot;
    const newerDocument = {
      _id: newer.contextId,
      snapshot: newer,
      insertedAt: "2026-08-27T10:00:02.000Z",
    };
    const fake = new FakeImmutableContextCollection([newerDocument]);
    await restoreImmutableContextDocuments(
      fake as unknown as Collection<MongoContextSnapshotDocument>,
      [contextDocument]
    );
    await restoreImmutableContextDocuments(
      fake as unknown as Collection<MongoContextSnapshotDocument>,
      [contextDocument]
    );
    assert.equal(fake.rows.size, 2);
    assert.deepEqual(fake.rows.get(newer.contextId), newerDocument);
    assert.ok(fake.writes.flat().every((operation) =>
      "updateOne" in operation && Object.keys(operation.updateOne.update).length === 1
    ));
  });

  await check("Q15 context same-id conflict is never overwritten", async () => {
    const conflicting = clone(contextDocument);
    conflicting.insertedAt = "2026-08-27T10:00:03.000Z";
    const fake = new FakeImmutableContextCollection([conflicting]);
    await assert.rejects(
      restoreImmutableContextDocuments(
        fake as unknown as Collection<MongoContextSnapshotDocument>,
        [contextDocument]
      ),
      /read-back mismatch/
    );
    assert.equal(fake.rows.get(context.contextId)?.insertedAt, conflicting.insertedAt);
  });

  await check("Q16 checksummed context section must contain the exact legacy union", () => {
    const omitted = assembleMatchContext({
      season: "2026-27",
      fixtureId: fixture.fixtureId,
      homeSlug: fixture.homeSlug,
      awaySlug: fixture.awaySlug,
      kickoffAt: fixture.kickoffAt,
      cutoffAt: "2026-08-27T11:00:00.000Z",
      generatedAt: "2026-08-27T11:00:01.000Z",
      forecastSnapshotKey: "phase4a4-omitted-context",
      evidence: [],
    }).snapshot;
    assert.throws(
      () => exactContextDocumentsForRestore({
        backupDocuments: [contextDocument],
        legacyJsonl: `${JSON.stringify(omitted)}\n`,
        fallbackInsertedAt: INSERTED_AT,
      }),
      /exact bundle\/collection union/
    );
  });

  await check("Q17 rating state membership identity is season-compatible", () => {
    const wrongMembership = buildSeasonMembershipSnapshot({
      season: "2025-26",
      teamSlugs: ["arsenal", "chelsea"],
      sourceObservations: [
        source("wrong-season-membership", "2026-08-01T00:00:00.000Z", {
          teamSlugs: ["arsenal", "chelsea"],
        }),
      ],
      verificationStatus: "VERIFIED",
      verifiedAt: "2026-08-01T00:00:00.000Z",
      verifiedAgainst: ["independent-membership-audit"],
      verificationArtifact: "phase4a4-membership-audit",
    });
    const state = buildFrozenRatingState({
      season: "2026-27",
      asOf: "2026-08-27T09:00:00.000Z",
      availableAt: "2026-08-27T09:00:00.000Z",
      modelVersion: "pl-live-v0.2.0",
      formulaVersion: "elo-pl-live-v0.2.0",
      seasonMembershipSnapshotId: wrongMembership.seasonMembershipSnapshotId,
      ratingEvents: [],
      state: {
        season: "2026-27",
        clubSlugs: ["arsenal", "chelsea"],
        ratings: { arsenal: 1500, chelsea: 1500 },
        matchesPlayedSeason: { arsenal: 0, chelsea: 0 },
      },
      ratingResultLineageStatus: "VERIFIED",
      featureCodeVersion: "pl-sealed-predictor-v1+elo-pl-live-v0.2.0",
      codeCommitSha: "a".repeat(40),
    });
    assert.throws(
      () => requireResolvedProvenanceGraph([wrongMembership, state]),
      /incompatible season membership/
    );
  });

  await check("Q18 canonical tape protection resolves symlink targets", () => {
    const tape = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
    assert.throws(() => assertNotTape(tape), /Refusing to write/);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "foa-backup-symlink-"));
    const link = path.join(temp, "backup.json");
    fs.symlinkSync(tape, link);
    try {
      assert.throws(() => assertNotTape(link), /Refusing to write/);
    } finally {
      fs.unlinkSync(link);
      fs.rmdirSync(temp);
    }
  });

  console.log(`\nPhase 4A4 ops backup: ${passed}/20 gates passed.`);
}

function createEmptySha256(): string {
  // SHA-256 of the empty deterministic document stream.
  return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
