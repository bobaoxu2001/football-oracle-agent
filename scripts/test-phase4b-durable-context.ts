/** Phase 4B durable match-context migration and append-only hydration gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleMatchContext, assertMatchContextIntegrity } from "@/lib/competitions/premier-league/context";
import {
  applyBundleToDisk,
  buildImmutableContextMongoUpserts,
  mergeContextSnapshotJsonl,
  mergeMongoContextDocumentsWithLegacy,
  type DurableBundle,
} from "@/lib/competitions/premier-league/ops/durable-store";
import { contextSnapshotPath } from "@/lib/competitions/premier-league/ops/paths";

const FIXTURE = "premier-league-2026-27-arsenal-chelsea-durable-test";
const KICKOFF = "2026-09-12T20:00:00.000Z";

function snapshot(cutoffAt: string, generatedAt: string, forecastSnapshotKey: string) {
  return assembleMatchContext({
    season: "2026-27",
    fixtureId: FIXTURE,
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoffAt: KICKOFF,
    cutoffAt,
    generatedAt,
    forecastSnapshotKey,
    evidence: [],
  }).snapshot;
}

function bundle(contextSnapshots?: string): DurableBundle {
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
    ...(contextSnapshots === undefined ? {} : { contextSnapshots }),
    fixturesOverlay: "",
  };
}

function parseJsonl(text: string) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReturnType<typeof snapshot>);
}

function main(): void {
  const first = snapshot(
    "2026-09-05T20:00:00.000Z",
    "2026-09-05T20:00:01.000Z",
    "forecast::t7d"
  );
  const firstRetry = snapshot(
    "2026-09-05T20:00:00.000Z",
    "2026-09-05T20:00:02.000Z",
    "forecast::t7d"
  );
  const second = snapshot(
    "2026-09-11T20:00:00.000Z",
    "2026-09-11T20:00:01.000Z",
    "forecast::t24h"
  );
  assert.equal(first.contextId, firstRetry.contextId);
  assert.notEqual(first.generatedAt, firstRetry.generatedAt);

  const firstLine = `${JSON.stringify(first)}\n`;
  const retryLine = `${JSON.stringify(firstRetry)}\n`;
  const secondLine = `${JSON.stringify(second)}\n`;

  // Priority order is deterministic and first-write-wins, even when a retry
  // has the same content address but different non-identity audit time.
  const merged = mergeContextSnapshotJsonl(firstLine, `${retryLine}${secondLine}`);
  const mergedRows = parseJsonl(merged);
  assert.equal(mergedRows.length, 2);
  assert.equal(mergedRows[0].generatedAt, first.generatedAt);
  assert.equal(mergedRows[1].contextId, second.contextId);

  // Mongo migration prefers the separate immutable document, while retaining
  // context IDs that only exist in a pre-Phase-4B bundle.
  const mongoMerged = mergeMongoContextDocumentsWithLegacy(
    [{ _id: firstRetry.contextId, snapshot: firstRetry }],
    `${firstLine}${secondLine}`
  );
  const mongoRows = parseJsonl(mongoMerged);
  assert.equal(mongoRows.length, 2);
  assert.equal(mongoRows[0].generatedAt, firstRetry.generatedAt);
  assert.equal(mongoRows[1].contextId, second.contextId);
  assert.throws(
    () => mergeMongoContextDocumentsWithLegacy(
      [{ _id: "wrong-id", snapshot: first }],
      ""
    ),
    /mismatched _id/
  );

  // Every Mongo write is keyed by contextId, uses only $setOnInsert, and
  // de-duplicates retries before sending operations to the database.
  const operations = buildImmutableContextMongoUpserts(
    `${retryLine}${firstLine}${secondLine}`,
    "2026-08-25T00:00:00.000Z"
  );
  assert.equal(operations.length, 2);
  for (const operation of operations) {
    assert.ok("updateOne" in operation);
    if (!("updateOne" in operation)) continue;
    assert.equal(operation.updateOne.upsert, true);
    const update = operation.updateOne.update as {
      $setOnInsert?: { snapshot: { contextId: string } };
    };
    assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
    assert.equal(
      operation.updateOne.filter._id,
      update.$setOnInsert?.snapshot.contextId
    );
  }

  // Hydrating a legacy/new bundle appends only missing contexts. It never
  // rewrites or deletes a local row that has not yet been flushed.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "foa-phase4b-durable-context-"));
  process.env.PL_OPS_BACKEND = "bundle";
  process.env.PL_DURABLE_WORK_DIR = path.join(tempDir, "durable-work");
  applyBundleToDisk(bundle());
  const contextFile = contextSnapshotPath();
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  fs.writeFileSync(contextFile, firstLine, "utf8");
  const localBytes = fs.readFileSync(contextFile, "utf8");

  applyBundleToDisk(bundle(`${retryLine}${secondLine}`));
  const hydratedBytes = fs.readFileSync(contextFile, "utf8");
  assert.equal(hydratedBytes.startsWith(localBytes), true);
  assert.deepEqual(parseJsonl(hydratedBytes).map((row) => row.contextId), [
    first.contextId,
    second.contextId,
  ]);
  assert.equal(parseJsonl(hydratedBytes)[0].generatedAt, first.generatedAt);

  applyBundleToDisk(bundle(`${firstLine}${secondLine}`));
  assert.equal(fs.readFileSync(contextFile, "utf8"), hydratedBytes);
  applyBundleToDisk(bundle());
  assert.equal(fs.readFileSync(contextFile, "utf8"), hydratedBytes);

  const tampered = structuredClone(second) as { season: string };
  tampered.season = "tampered";
  assert.throws(
    () => applyBundleToDisk(bundle(`${JSON.stringify(tampered)}\n`)),
    /invalid match context/
  );
  assert.equal(fs.readFileSync(contextFile, "utf8"), hydratedBytes);
  for (const row of parseJsonl(hydratedBytes)) assertMatchContextIntegrity(row);

  console.log("Phase 4B durable context tests passed");
}

main();
