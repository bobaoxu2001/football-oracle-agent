/** Prospective capture must remain deterministic without one tape load per fixture. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Fixture } from "@/lib/identity/types";
import type { SourceObservation } from "@/lib/competitions/premier-league/ops/types";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-provenance-single-load-"));
const PROVENANCE_DIR = path.join(TEMP, "provenance");
const RATING_EVENTS_PATH = path.join(TEMP, "rating-events.jsonl");
const CAPTURED_AT = "2026-08-16T06:00:00.000Z";

process.env.PL_PROVENANCE_DIR = PROVENANCE_DIR;
process.env.PL_RATING_EVENT_PATH = RATING_EVENTS_PATH;
process.env.APPLICATION_COMMIT_SHA = "d".repeat(40);
delete process.env.MONGODB_URI;

import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import {
  provenanceFixtureRevisionPath,
  provenanceModelBundlePath,
  provenanceRatingStatePath,
  provenanceResultCorrectionPath,
  provenanceResultRevisionPath,
  provenanceSeasonMembershipPath,
} from "@/lib/competitions/premier-league/ops/paths";
import { captureProspectiveProductionEvidence } from "@/lib/competitions/premier-league/provenance/production";

function bytesByPath(files: readonly string[]): Map<string, string> {
  return new Map(
    files.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""])
  );
}

const fixtures = liveFixtures();
assert.equal(fixtures.length, 380, "the production-season capture test must cover all fixtures");

const first = captureProspectiveProductionEvidence({
  fixtures,
  observations: [],
  capturedAt: CAPTURED_AT,
});
assert.equal(first.fixtureRecordsInserted, 380);
assert.equal(first.resultRecordsInserted, 0);
assert.equal(first.differingTeamCount, 0);

const fixturePath = provenanceFixtureRevisionPath();
const immutableFiles = [
  fixturePath,
  provenanceSeasonMembershipPath(),
  provenanceRatingStatePath(),
  provenanceModelBundlePath(),
];
const before = bytesByPath(immutableFiles);
assert.equal(before.get(fixturePath)?.split("\n").filter(Boolean).length, 380);

const originalReadFileSync = fs.readFileSync;
const originalAppendFileSync = fs.appendFileSync;
const provenanceReads = new Map<string, number>();
let provenanceAppends = 0;

fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
  if (typeof file === "string") {
    const resolved = path.resolve(file);
    if (resolved.startsWith(`${path.resolve(PROVENANCE_DIR)}${path.sep}`)) {
      provenanceReads.set(resolved, (provenanceReads.get(resolved) ?? 0) + 1);
    }
  }
  return originalReadFileSync(file, options as never);
}) as typeof fs.readFileSync;
fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: unknown) => {
  if (
    typeof file === "string" &&
    path.resolve(file).startsWith(`${path.resolve(PROVENANCE_DIR)}${path.sep}`)
  ) {
    provenanceAppends += 1;
  }
  return originalAppendFileSync(file, data, options as never);
}) as typeof fs.appendFileSync;

let retry: ReturnType<typeof captureProspectiveProductionEvidence>;
try {
  // Reversing the input proves that lookup/index order cannot mint a different
  // immutable record when all semantic content is unchanged.
  retry = captureProspectiveProductionEvidence({
    fixtures: [...fixtures].reverse(),
    observations: [],
    capturedAt: CAPTURED_AT,
  });
} finally {
  fs.readFileSync = originalReadFileSync;
  fs.appendFileSync = originalAppendFileSync;
}

assert.equal(retry.fixtureRecordsInserted, 0);
assert.equal(retry.resultRecordsInserted, 0);
assert.equal(retry.seasonMembershipSnapshotId, first.seasonMembershipSnapshotId);
assert.equal(retry.ratingStateId, first.ratingStateId);
assert.equal(retry.ratingStateHash, first.ratingStateHash);
assert.equal(retry.modelBundleId, first.modelBundleId);
assert.equal(retry.modelBundleHash, first.modelBundleHash);
assert.equal(retry.applicationCommitSha, first.applicationCommitSha);
assert.deepEqual(bytesByPath(immutableFiles), before, "retry must preserve every tape byte");
assert.equal(
  provenanceReads.get(path.resolve(fixturePath)),
  2,
  "one 380-fixture capture uses one indexed load plus one fail-closed validation barrier"
);
for (const [file, reads] of provenanceReads) {
  assert.ok(reads <= 2, `${path.basename(file)} was loaded ${reads} times in one capture`);
}
assert.equal(provenanceAppends, 0, "an idempotent retry must not append provenance bytes");

function resultObservation(
  fixture: Fixture,
  homeGoals: number,
  awayGoals: number,
  retrievedAt: string
): SourceObservation {
  return {
    observationId: `${fixture.id}:${homeGoals}-${awayGoals}:${retrievedAt}`,
    kind: "result",
    source: "provenance-efficiency-result-feed",
    sourceFixtureId: fixture.id,
    fixtureId: fixture.id,
    retrievedAt,
    sourceUpdatedAt: null,
    raw: { homeGoals, awayGoals },
    normalized: {
      homeSlug: fixture.homeSlug,
      awaySlug: fixture.awaySlug,
      kickoffUtc: fixture.kickoffUtc ?? fixture.kickoff ?? null,
      kickoffLocal: fixture.kickoffLocal ?? null,
      scheduledDate: fixture.scheduledDate ?? fixture.date,
      kickoffCertainty: fixture.kickoffCertainty ?? null,
      status: "FINISHED",
      homeGoals,
      awayGoals,
      sourceUpdatedAt: null,
    },
    verificationStatus: "VERIFIED_FINAL",
  };
}

// Exercise result supersession/correction with the same bounded-load rule.
// These immutable result rows are deliberately not rating-admitted: without a
// verification event they remain harmless evidence orphans and cannot alter
// the production rating state.
const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foa-provenance-results-"));
const resultProvenanceDir = path.join(resultRoot, "provenance");
process.env.PL_PROVENANCE_DIR = resultProvenanceDir;
process.env.PL_RATING_EVENT_PATH = path.join(resultRoot, "rating-events.jsonl");
const resultFixture = fixtures[0];
const firstResult = resultObservation(
  resultFixture,
  1,
  0,
  "2026-08-22T00:00:00.000Z"
);
const correctedResult = resultObservation(
  resultFixture,
  2,
  0,
  "2026-08-22T01:00:00.000Z"
);
captureProspectiveProductionEvidence({
  fixtures: [resultFixture],
  observations: [firstResult],
  capturedAt: firstResult.retrievedAt,
});
const resultReads = new Map<string, number>();
fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
  if (typeof file === "string") {
    const resolved = path.resolve(file);
    if (resolved.startsWith(`${path.resolve(resultProvenanceDir)}${path.sep}`)) {
      resultReads.set(resolved, (resultReads.get(resolved) ?? 0) + 1);
    }
  }
  return originalReadFileSync(file, options as never);
}) as typeof fs.readFileSync;
try {
  const corrected = captureProspectiveProductionEvidence({
    fixtures: [resultFixture],
    observations: [firstResult, correctedResult],
    capturedAt: correctedResult.retrievedAt,
  });
  assert.equal(corrected.resultRecordsInserted, 1);
} finally {
  fs.readFileSync = originalReadFileSync;
}
const resultRevisionPath = provenanceResultRevisionPath();
const resultCorrectionPath = provenanceResultCorrectionPath();
assert.equal(fs.readFileSync(resultRevisionPath, "utf8").trim().split("\n").length, 2);
assert.equal(fs.readFileSync(resultCorrectionPath, "utf8").trim().split("\n").length, 1);
assert.equal(
  resultReads.get(path.resolve(resultRevisionPath)),
  2,
  "result supersession uses one indexed load plus one validation barrier"
);
assert.ok(
  (resultReads.get(path.resolve(resultCorrectionPath)) ?? 0) <= 2,
  "correction capture must not reload its full tape per result observation"
);

// A constant-read optimization must not trust a stale in-memory index after
// append. Reproduce a mid-capture malformed row and prove no verified rating
// or model record can be written past the post-write validation barrier.
const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "foa-provenance-corruption-"));
const corruptProvenanceDir = path.join(corruptRoot, "provenance");
process.env.PL_PROVENANCE_DIR = corruptProvenanceDir;
process.env.PL_RATING_EVENT_PATH = path.join(corruptRoot, "rating-events.jsonl");
const corruptFixturePath = provenanceFixtureRevisionPath();
const corruptModelPath = provenanceModelBundlePath();
const corruptRatingPath = provenanceRatingStatePath();
let injectedMalformedRow = false;
fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: unknown) => {
  const result = originalAppendFileSync(file, data, options as never);
  if (!injectedMalformedRow && path.resolve(String(file)) === path.resolve(corruptFixturePath)) {
    originalAppendFileSync(file, "{malformed\n", "utf8");
    injectedMalformedRow = true;
  }
  return result;
}) as typeof fs.appendFileSync;
try {
  assert.throws(
    () =>
      captureProspectiveProductionEvidence({
        fixtures,
        observations: [],
        capturedAt: CAPTURED_AT,
      }),
    /invalid immutable provenance JSONL/
  );
} finally {
  fs.appendFileSync = originalAppendFileSync;
}
assert.equal(injectedMalformedRow, true);
assert.equal(fs.existsSync(corruptModelPath), false, "model insertion must remain behind validation");
assert.equal(fs.existsSync(corruptRatingPath), false, "verified rating insertion must remain behind validation");

console.log("\nProspective provenance bounded-load/fail-closed regression: 3 passed, 0 failed");
