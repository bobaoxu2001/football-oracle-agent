/** Production-scale scheduler IO/immutability regression gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Fixture } from "@/lib/identity/types";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "foa-scheduler-efficiency-"));
const opsDir = path.join(temp, "ops");
const jobStore = path.join(opsDir, "prediction-jobs.jsonl");
const archiveStore = path.join(opsDir, "live-oos-operational.jsonl");

process.env.PL_OPS_BACKEND = "file";
process.env.PL_OPS_DIR = opsDir;
process.env.PL_JOB_STORE_PATH = jobStore;
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = archiveStore;
process.env.SNAPSHOT_STORE_PATH = path.join(temp, "snapshots.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(temp, "settlements.jsonl");
process.env.PL_PROVENANCE_DIR = path.join(opsDir, "provenance");
process.env.APPLICATION_COMMIT_SHA = "a".repeat(40);

async function main(): Promise<void> {
  const { PREMIER_LEAGUE_CURRENT_SEASON } = await import(
    "@/lib/competitions/premier-league/config"
  );
  const { TIMED_STAGES } = await import(
    "@/lib/competitions/premier-league/ops/types"
  );
  const {
    buildJob,
    executeEligibleJobs,
    MAX_JOB_RETRIES,
    planPredictionJobs,
    refreshJobStatuses,
  } = await import("@/lib/competitions/premier-league/ops/scheduler");
  const { getJob, resetJobCache, updateJobs } = await import(
    "@/lib/competitions/premier-league/ops/job-ledger"
  );
  const { PRODUCTION_MODEL_VERSION } = await import(
    "@/lib/competitions/premier-league/model-tracks"
  );
  const { findScheduledSnapshot, indexScheduledSnapshots } = await import(
    "@/lib/competitions/premier-league/ops/operational-archive"
  );
  const {
    liveOpsTickDegradationReason,
    unresolvedTerminalPredictionJobCount,
  } = await import("@/lib/competitions/premier-league/ops/tick");

const now = "2026-08-20T00:00:00.000Z";
const kickoffUtc = "2026-09-20T15:00:00.000Z";
const fixtures: Fixture[] = Array.from({ length: 380 }, (_, index) => ({
  id: `efficiency-fixture-${String(index + 1).padStart(3, "0")}`,
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  date: kickoffUtc.slice(0, 10),
  scheduledDate: kickoffUtc.slice(0, 10),
  kickoff: kickoffUtc,
  kickoffUtc,
  kickoffLocal: null,
  timezone: "Europe/London",
  kickoffCertainty: "CONFIRMED",
  homeSlug: `home-${index}`,
  awaySlug: `away-${index}`,
  homeGoals: null,
  awayGoals: null,
  status: "SCHEDULED",
  venue: "home",
  source: "scheduler-efficiency-test",
  sourceId: `fixture-source-${index}`,
  retrievedAt: "2026-08-01T00:00:00.000Z",
  verificationStatus: "VERIFIED",
}));

const jobs = fixtures.flatMap((fixture) =>
  TIMED_STAGES.map((stage) =>
    buildJob(fixture, stage, now, PRODUCTION_MODEL_VERSION)
  )
);
fs.mkdirSync(opsDir, { recursive: true });
fs.writeFileSync(jobStore, `${jobs.map((job) => JSON.stringify(job)).join("\n")}\n`, "utf8");

const archiveRows = Array.from({ length: 415 }, (_, index) => ({
  fixtureId: `archived-fixture-${index}`,
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "T7D",
  asOf: "2026-08-01T00:00:00.000Z",
  provenance: { uniqueKey: `archived-snapshot-${index}` },
}));
fs.writeFileSync(
  archiveStore,
  `${archiveRows.map((snapshot) => JSON.stringify(snapshot)).join("\n")}\n`,
  "utf8"
);
resetJobCache();

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const jobHashBefore = sha256(jobStore);
const archiveHashBefore = sha256(archiveStore);
const originalReadFileSync = fs.readFileSync;
let jobReads = 0;
let archiveReads = 0;
(fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function monitoredRead(
  file: fs.PathOrFileDescriptor,
  ...args: unknown[]
) {
  if (String(file) === jobStore) jobReads += 1;
  if (String(file) === archiveStore) archiveReads += 1;
  return (originalReadFileSync as (...input: unknown[]) => unknown)(file, ...args);
} as typeof fs.readFileSync;

const startedAt = performance.now();
try {
  planPredictionJobs({ fixtures, now });
  planPredictionJobs({ fixtures, now });
} finally {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
}
const elapsedMs = performance.now() - startedAt;

assert.equal(jobs.length, 1_900, "fixture must cover all five timed stages");
assert.equal(jobReads, 1, "the task ledger should load once and remain cached");
assert.equal(sha256(jobStore), jobHashBefore, "an unchanged plan must not rewrite the task ledger");
assert.equal(sha256(archiveStore), archiveHashBefore, "planning must never mutate archived snapshots");

const baselineMode = process.argv.includes("--baseline");
if (!baselineMode) {
  assert.ok(
    archiveReads <= 2,
    `two planning passes may read the operational archive at most once each; got ${archiveReads}`
  );
}

const originalWriteFileSync = fs.writeFileSync;
let ledgerRewrites = 0;
(fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = function monitoredWrite(
  file: fs.PathOrFileDescriptor,
  ...args: unknown[]
) {
  if (String(file).startsWith(`${jobStore}.`)) ledgerRewrites += 1;
  return (originalWriteFileSync as (...input: unknown[]) => unknown)(file, ...args);
} as typeof fs.writeFileSync;
try {
  updateJobs([
    { jobId: jobs[0].jobId, patch: { status: "ELIGIBLE", updatedAt: now } },
    { jobId: jobs[1].jobId, patch: { status: "BLOCKED", updatedAt: now } },
  ]);
} finally {
  (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = originalWriteFileSync;
}
assert.equal(ledgerRewrites, 1, "a related transition batch must use one atomic rewrite");
resetJobCache();
assert.equal(getJob(jobs[0].jobId)?.status, "ELIGIBLE");
assert.equal(getJob(jobs[1].jobId)?.status, "BLOCKED");
const afterBatchHash = sha256(jobStore);
assert.throws(
  () =>
    updateJobs([
      { jobId: jobs[0].jobId, patch: { status: "PENDING", updatedAt: now } },
      { jobId: "unknown-job", patch: { status: "FAILED", updatedAt: now } },
    ]),
  /Unknown job unknown-job/
);
assert.equal(sha256(jobStore), afterBatchHash, "an invalid batch must change no durable bytes");
assert.equal(getJob(jobs[0].jobId)?.status, "ELIGIBLE", "an invalid batch must change no cached row");

const originalRenameSync = fs.renameSync;
(fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = function failedRename(
  oldPath: fs.PathLike,
  newPath: fs.PathLike
) {
  if (String(newPath) === jobStore) throw new Error("forced ledger rename failure");
  return originalRenameSync(oldPath, newPath);
};
try {
  assert.throws(
    () => updateJobs([{ jobId: jobs[0].jobId, patch: { status: "PENDING", updatedAt: now } }]),
    /forced ledger rename failure/
  );
} finally {
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = originalRenameSync;
}
assert.equal(sha256(jobStore), afterBatchHash, "a failed atomic rewrite must preserve durable bytes");
assert.equal(
  getJob(jobs[0].jobId)?.status,
  "ELIGIBLE",
  "a failed atomic rewrite must invalidate and reload the warm cache"
);

const lookup = {
  fixtureId: "first-write-fixture",
  stage: "T7D" as const,
  modelVersion: PRODUCTION_MODEL_VERSION,
  plannedAsOf: "2026-09-13T15:00:00.000Z",
};
const firstWrite = {
  fixtureId: lookup.fixtureId,
  modelVersion: lookup.modelVersion,
  predictionStage: lookup.stage,
  asOf: lookup.plannedAsOf,
  provenance: { uniqueKey: "first-write" },
} as import("@/lib/snapshots/types").PredictionSnapshot;
const conflictingLaterRow = {
  ...firstWrite,
  provenance: { uniqueKey: "conflicting-later-row" },
} as import("@/lib/snapshots/types").PredictionSnapshot;
assert.equal(
  findScheduledSnapshot(
    lookup,
    indexScheduledSnapshots([firstWrite, conflictingLaterRow])
  ),
  firstWrite,
  "the indexed lookup must preserve immutable first-row-wins behavior"
);

// A job that exhausts its automatic retry budget must remain an explicit
// operator-action failure on the next tick, even though that tick makes no new
// execution attempt. Once its window closes, the existing FAILED -> MISSED
// transition resolves the terminal-failure health state without a backfill.
const terminalJobStore = path.join(opsDir, "terminal-failure-jobs.jsonl");
process.env.PL_JOB_STORE_PATH = terminalJobStore;
resetJobCache();
const terminalFixture: Fixture = {
  ...fixtures[0],
  id: "terminal-failure-fixture",
  kickoff: "2026-09-20T15:00:00.000Z",
  kickoffUtc: "2026-09-20T15:00:00.000Z",
  retrievedAt: "2026-09-01T00:00:00.000Z",
};
const eligibleAt = "2026-09-13T15:00:00.000Z";
const terminalJob = buildJob(
  terminalFixture,
  "T7D",
  eligibleAt,
  PRODUCTION_MODEL_VERSION
);
assert.equal(terminalJob.status, "ELIGIBLE");
fs.writeFileSync(terminalJobStore, `${JSON.stringify(terminalJob)}\n`, "utf8");
resetJobCache();
for (let attempt = 1; attempt <= MAX_JOB_RETRIES; attempt += 1) {
  const failed = executeEligibleJobs({
    fixtures: [terminalFixture],
    now: eligibleAt,
    freeze: () => {
      throw new Error(`forced terminal failure ${attempt}`);
    },
  });
  assert.equal(failed.attempted, 1);
  assert.equal(failed.failed, 1);
  assert.equal(getJob(terminalJob.jobId)?.retryCount, attempt);
}
const noRetry = executeEligibleJobs({
  fixtures: [terminalFixture],
  now: eligibleAt,
  freeze: () => {
    throw new Error("retry budget must prevent this call");
  },
});
assert.equal(noRetry.attempted, 0);
assert.equal(noRetry.failed, 0);
assert.equal(unresolvedTerminalPredictionJobCount(), 1);
assert.equal(
  liveOpsTickDegradationReason({
    errors: [],
    fixtureConflicts: [],
    resultConflicts: [],
    jobsFailed: noRetry.failed,
    jobsTerminalFailed: unresolvedTerminalPredictionJobCount(),
  }),
  "prediction jobs exhausted retries: 1",
  "a no-attempt follow-up tick must remain degraded while terminal failure is unresolved"
);
refreshJobStatuses("2026-09-13T17:00:00.001Z");
assert.equal(getJob(terminalJob.jobId)?.status, "MISSED");
assert.equal(
  unresolvedTerminalPredictionJobCount(),
  0,
  "the existing no-backfill MISSED transition resolves terminal-failure health"
);

console.log(
  JSON.stringify(
    {
      fixtures: fixtures.length,
      jobs: jobs.length,
      archiveSnapshots: archiveRows.length,
      planningPasses: 2,
      jobReads,
      archiveReads,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      mode: baselineMode ? "baseline" : "regression",
    },
    null,
    2
  )
);
  console.log("scheduler efficiency and immutability gate passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
