/** Phase 4A4 durable-store CPU and successful-tick freshness guardrails. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleMatchContext } from "@/lib/competitions/premier-league/context";
import {
  buildFixtureRevision,
  buildSourceObservationReference,
} from "@/lib/competitions/premier-league/provenance";
import { serializeProvenanceRecordsJsonl } from "@/lib/competitions/premier-league/provenance/durable";
import {
  buildImmutableChildWriteDelta,
  assertMongoContextReadback,
  assertMongoProvenanceReadback,
  decodeMongoBundleFromStorage,
  durableTickFreshness,
  flushDurableOps,
  hydrateDurableOps,
  prepareMongoBundleForWrite,
  resetDurableMetaForTests,
  type DurableBundle,
} from "@/lib/competitions/premier-league/ops/durable-store";

function emptyBundle(): DurableBundle {
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
    provenanceRecords: "",
    fixturesOverlay: "",
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foa-durable-cpu-"));
  const bundlePath = path.join(root, "ops-bundle.json");
  process.env.PL_OPS_BACKEND = "bundle";
  process.env.PL_DURABLE_WORK_DIR = path.join(root, "work");
  process.env.PL_OPS_BUNDLE_PATH = bundlePath;

  const jobs = `${Array.from({ length: 800 }, (_, index) =>
    JSON.stringify({ jobId: `cpu-guard-${index}`, status: "SUCCEEDED" })
  ).join("\n")}\n`;
  fs.writeFileSync(bundlePath, JSON.stringify({ ...emptyBundle(), jobs }), "utf8");
  resetDurableMetaForTests();
  await hydrateDurableOps({ force: true, strict: true });

  // The first flush normalizes any disk-vs-bundle representation difference
  // and establishes the exact verified capture baseline.
  await flushDurableOps();
  const stableBytes = fs.readFileSync(bundlePath, "utf8");
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parseCalls += 1;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    await flushDurableOps();
  } finally {
    JSON.parse = originalParse;
  }
  const noChangeParseCalls = parseCalls;
  assert.equal(parseCalls, 0, "an exact no-change flush must not reparse durable JSON/JSONL");
  assert.equal(
    fs.readFileSync(bundlePath, "utf8"),
    stableBytes,
    "optimized no-change flush must preserve exact serialized bundle bytes"
  );

  const tickPath = path.join(process.env.PL_OPS_DIR!, "tick-state.json");
  fs.writeFileSync(
    tickPath,
    JSON.stringify({
      lastTickAt: "2026-08-31T01:00:00.000Z",
      lastSuccessAt: "2026-08-31T01:00:00.000Z",
      lastError: null,
    }),
    "utf8"
  );
  parseCalls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parseCalls += 1;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    await flushDurableOps();
  } finally {
    JSON.parse = originalParse;
  }
  const oneFieldChangeParseCalls = parseCalls;
  assert.equal(parseCalls, 1, "one changed JSON field must be parsed exactly once");

  const firstStoragePlan = prepareMongoBundleForWrite(
    { ...emptyBundle(), jobs },
    true
  );
  assert.equal(firstStoragePlan.jobsCompressionReused, false);
  assert.ok(firstStoragePlan.compressedJobs);
  const reusedStoragePlan = prepareMongoBundleForWrite(
    { ...emptyBundle(), jobs },
    true,
    firstStoragePlan.compressedJobs
  );
  assert.equal(reusedStoragePlan.jobsCompressionReused, true);
  assert.equal(
    reusedStoragePlan.stored.jobsGzipBase64,
    firstStoragePlan.stored.jobsGzipBase64,
    "unchanged jobs must reuse the already-verified compressed bytes"
  );
  const changedJobs = `${jobs}${JSON.stringify({
    jobId: "cpu-guard-new",
    status: "PENDING",
  })}\n`;
  const changedStoragePlan = prepareMongoBundleForWrite(
    { ...emptyBundle(), jobs: changedJobs },
    true,
    firstStoragePlan.compressedJobs
  );
  assert.equal(changedStoragePlan.jobsCompressionReused, false);
  assert.equal(decodeMongoBundleFromStorage(changedStoragePlan.stored).jobs, changedJobs);

  const context = assembleMatchContext({
    season: "2026-27",
    fixtureId: "pl-2026-27-durable-cpu-context",
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoffAt: "2026-09-01T19:00:00.000Z",
    cutoffAt: "2026-08-31T19:00:00.000Z",
    generatedAt: "2026-08-31T19:00:01.000Z",
    forecastSnapshotKey: "durable-cpu-context",
    evidence: [],
  }).snapshot;
  const contextJsonl = `${JSON.stringify(context)}\n`;
  const fixtureSource = buildSourceObservationReference({
    sourceType: "fixture",
    sourceId: "durable-cpu-test",
    observationId: "durable-cpu-fixture-observation",
    availableAt: "2026-08-31T18:00:00.000Z",
    retrievedAt: "2026-08-31T18:00:00.000Z",
    payload: {
      kickoffAt: "2026-09-01T19:00:00.000Z",
      homeSlug: "arsenal",
      awaySlug: "chelsea",
    },
  });
  const fixtureRevision = buildFixtureRevision({
    season: "2026-27",
    fixtureId: "pl-2026-27-durable-cpu-context",
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoffAt: "2026-09-01T19:00:00.000Z",
    status: "SCHEDULED",
    sourceObservation: fixtureSource,
  });
  const provenanceJsonl = serializeProvenanceRecordsJsonl([fixtureRevision]);
  const insertedAt = "2026-08-31T18:00:01.000Z";
  assert.doesNotThrow(() =>
    assertMongoContextReadback(
      [context],
      [{ _id: context.contextId, snapshot: context, insertedAt }]
    )
  );
  assert.throws(
    () => assertMongoContextReadback([context], []),
    /verification missing/
  );
  const sameIdTampering = {
    ...context,
    // generatedAt is deliberately excluded from contextId, so this remains a
    // structurally valid same-id document but is not the exact expected row.
    generatedAt: "2026-08-31T19:00:02.000Z",
  };
  assert.throws(
    () =>
      assertMongoContextReadback(
        [context],
        [{ _id: context.contextId, snapshot: sameIdTampering, insertedAt }],
        "same-count context tampering"
      ),
    /immutable collision/
  );
  const orphanContext = assembleMatchContext({
    season: "2026-27",
    fixtureId: "pl-2026-27-durable-cpu-orphan",
    homeSlug: "liverpool",
    awaySlug: "everton",
    kickoffAt: "2026-09-01T19:00:00.000Z",
    cutoffAt: "2026-08-31T19:00:00.000Z",
    generatedAt: "2026-08-31T19:00:01.000Z",
    forecastSnapshotKey: "durable-cpu-orphan",
    evidence: [],
  }).snapshot;
  assert.throws(
    () =>
      assertMongoContextReadback(
        [context],
        [{ _id: orphanContext.contextId, snapshot: orphanContext, insertedAt }],
        "same-count context replacement"
      ),
    /unexpected|verification missing/
  );
  assert.doesNotThrow(() =>
    assertMongoProvenanceReadback(
      [fixtureRevision],
      [{ _id: fixtureRevision.fixtureRevisionId, record: fixtureRevision, insertedAt }]
    )
  );
  assert.throws(
    () => assertMongoProvenanceReadback([fixtureRevision], []),
    /verification missing/
  );
  assert.throws(
    () =>
      assertMongoProvenanceReadback(
        [fixtureRevision],
        [{
          _id: fixtureRevision.fixtureRevisionId,
          record: { ...fixtureRevision, kickoffAt: "2026-09-02T19:00:00.000Z" },
          insertedAt,
        }],
        "same-count out-of-band mutation"
      ),
    /integrity|content|hash|mismatch/i
  );
  const withChildren = {
    ...emptyBundle(),
    contextSnapshots: contextJsonl,
    provenanceRecords: provenanceJsonl,
  };
  assert.deepEqual(buildImmutableChildWriteDelta(withChildren, withChildren), {
    contextSnapshots: "",
    provenanceRecords: "",
  });
  assert.deepEqual(buildImmutableChildWriteDelta(withChildren, emptyBundle()), {
    contextSnapshots: contextJsonl,
    provenanceRecords: provenanceJsonl,
  });
  assert.throws(
    () => buildImmutableChildWriteDelta(emptyBundle(), withChildren),
    /removed immutable row/
  );

  function writeTickState(value: Record<string, unknown>): void {
    fs.writeFileSync(
      bundlePath,
      JSON.stringify({ ...emptyBundle(), tickState: JSON.stringify(value) }),
      "utf8"
    );
  }
  const now = new Date("2026-08-31T01:06:00.000Z");
  writeTickState({ lastTickAt: "2026-08-31T01:00:00.000Z" });
  assert.equal(
    (await durableTickFreshness(now)).fresh,
    true,
    "legacy tick states without a success marker retain lastTickAt compatibility"
  );
  writeTickState({
    lastTickAt: "2026-08-31T01:00:00.000Z",
    lastError: "legacy failed attempt",
  });
  assert.equal(
    (await durableTickFreshness(now)).fresh,
    false,
    "a legacy error marker still forces the hosted backup"
  );
  writeTickState({
    lastTickAt: "2026-08-31T01:00:00.000Z",
    lastSuccessAt: "2026-08-31T01:00:00.000Z",
    lastError: null,
  });
  assert.equal((await durableTickFreshness(now)).fresh, true);
  writeTickState({
    lastTickAt: "2026-08-31T01:00:00.000Z",
    lastSuccessAt: "2026-08-31T00:55:00.000Z",
    lastError: null,
  });
  assert.equal(
    (await durableTickFreshness(now)).fresh,
    false,
    "a recent failed attempt cannot hide behind an older successful tick"
  );
  writeTickState({
    lastTickAt: "2026-08-31T01:00:00.000Z",
    lastSuccessAt: "2026-08-31T01:00:00.000Z",
    lastError: "fixture conflict",
  });
  const errored = await durableTickFreshness(now);
  assert.equal(errored.fresh, false);
  assert.equal(errored.successConfirmed, false);
  assert.equal(errored.lastError, "fixture conflict");

  console.log(
    "Phase 4A4 durable CPU/freshness guardrails passed " +
      `(noChangeJsonParse=${noChangeParseCalls}, ` +
      `oneFieldChangeJsonParse=${oneFieldChangeParseCalls}, ` +
      `jobsCompressionReused=${reusedStoragePlan.jobsCompressionReused})`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
