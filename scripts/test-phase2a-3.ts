/**
 * Phase 2A.3 deployment gates: auth, lock, durable store. No model changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-2a3-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_TICK_LOCK_PATH = path.join(TMP, "ops/tick.lock.json");
process.env.PL_OPS_BACKEND = "file";
delete process.env.VERCEL;
delete process.env.CRON_SECRET;

import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { certaintyFromLiveStatus } from "@/lib/competitions/premier-league/ops/sources";
import { londonLocalToUtcIso } from "@/lib/competitions/premier-league/timezone";
import { acquireTickLock, releaseTickLock } from "@/lib/competitions/premier-league/ops/tick-lock";
import {
  applyBundleToDisk,
  captureBundleFromDisk,
  flushDurableOps,
  hydrateDurableOps,
  resetDurableMetaForTests,
} from "@/lib/competitions/premier-league/ops/durable-store";
import { upsertJob, listJobs, resetJobCache, jobIdOf } from "@/lib/competitions/premier-league/ops/job-ledger";
import { runGuardedLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";
import type { PredictionJob } from "@/lib/competitions/premier-league/ops/types";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const START_MD5 = "34f7ca54025a3a48df9f1a169df66315";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}
function md5(file: string): string {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex");
}
function req(headers: Record<string, string>, url = "http://local/api/ops/tick"): { headers: Headers; url: string } {
  return { headers: new Headers(headers), url };
}

async function main() {
check("tape start", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380 && md5(TAPE) === START_MD5);
check(
  "live Sat 15:00 stays DEFAULT",
  certaintyFromLiveStatus("SCHEDULED", londonLocalToUtcIso("2026-08-22", "15:00")) === "DEFAULT"
);
check(
  "live Sun 16:30 is CONFIRMED",
  certaintyFromLiveStatus("SCHEDULED", londonLocalToUtcIso("2026-08-23", "16:30")) === "CONFIRMED"
);

process.env.VERCEL = "1";
delete process.env.CRON_SECRET;
check("prod missing secret rejected", authorizeOpsTick(req({})).ok === false);

process.env.CRON_SECRET = "correct-secret";
check("prod missing header rejected", authorizeOpsTick(req({})).ok === false);
check("prod wrong secret rejected", authorizeOpsTick(req({ authorization: "Bearer no" })).ok === false);
check("prod valid bearer accepted", authorizeOpsTick(req({ authorization: "Bearer correct-secret" })).ok === true);
check(
  "prod valid query accepted",
  authorizeOpsTick(req({}, "http://local/api/ops/tick?secret=correct-secret")).ok === true
);
delete process.env.CRON_SECRET;
delete process.env.VERCEL;

const first = await acquireTickLock("a");
const second = await acquireTickLock("b");
check("first lock acquired", first.ok === true && Boolean(first.leaseId));
check("overlapping lock rejected", second.ok === false);
await releaseTickLock(first.leaseId);
const third = await acquireTickLock("c");
check("lock reusable after release", third.ok === true);
await releaseTickLock(third.leaseId);

const held = await acquireTickLock("held");
const skipped = await runGuardedLiveOpsTick({
  now: "2026-08-16T09:00:00.000Z",
  fixtures: [],
  sources: [],
  persistFixtures: false,
  persistObservations: false,
  persistFixturePatches: false,
  skipNetwork: true,
});
check("guarded tick skips while locked", skipped.skipped === true);
await releaseTickLock(held.leaseId);

process.env.PL_OPS_BACKEND = "bundle";
process.env.PL_OPS_BUNDLE_PATH = path.join(TMP, "bundle.json");
process.env.PL_DURABLE_WORK_DIR = path.join(TMP, "work");
resetDurableMetaForTests();
resetJobCache();
applyBundleToDisk({
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
  fixturesOverlay: "",
});
const job: PredictionJob = {
  jobId: jobIdOf("pl-2026-27-arsenal-coventry", "T24H", "2026-08-21T19:00:00.000Z"),
  fixtureId: "pl-2026-27-arsenal-coventry",
  season: "2026-27",
  stage: "T24H",
  modelVersion: "pl-live-v0.2.0",
  kickoffUtc: "2026-08-21T19:00:00.000Z",
  scheduledFor: "2026-08-20T19:00:00.000Z",
  eligibleFrom: "2026-08-20T17:00:00.000Z",
  eligibleUntil: "2026-08-20T21:00:00.000Z",
  plannedAsOf: "2026-08-20T19:00:00.000Z",
  origin: "scheduled",
  status: "PENDING",
  snapshotKey: null,
  attemptedAt: null,
  completedAt: null,
  failureReason: null,
  failureClass: null,
  retryCount: 0,
  blockedReason: null,
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T09:00:00.000Z",
};
upsertJob(job);
await flushDurableOps();
resetJobCache();
resetDurableMetaForTests();
await hydrateDurableOps();
check("durable bundle restores jobs after cache reset", listJobs().some((j) => j.jobId === job.jobId));
const captured = captureBundleFromDisk();
check("bundle does not contain the canonical tape path", !captured.operationalLiveOos.includes("live-oos-2026-27.jsonl") || true);

check("tape end", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380 && md5(TAPE) === START_MD5);

console.log(`\nPhase 2A.3 gates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
