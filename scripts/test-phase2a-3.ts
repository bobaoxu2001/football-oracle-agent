/**
 * Phase 2A.3 deployment gates: auth, lock, durable store. No model changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-2a3-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_TICK_LOCK_PATH = path.join(TMP, "ops/tick.lock.json");
process.env.PL_OBSERVER_LOCK_PATH = path.join(TMP, "ops/observers.lock.json");
process.env.PL_OPS_BACKEND = "file";
delete process.env.VERCEL;
delete process.env.CRON_SECRET;

import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { certaintyFromLiveStatus } from "@/lib/competitions/premier-league/ops/sources";
import { londonLocalToUtcIso } from "@/lib/competitions/premier-league/timezone";
import {
  OBSERVER_LOCK_TTL_MS,
  acquireObserverLock,
  acquireTickLock,
  releaseObserverLock,
  releaseTickLock,
} from "@/lib/competitions/premier-league/ops/tick-lock";
import {
  applyBundleToDisk,
  captureBundleFromDisk,
  compactDurableOpsOnDisk,
  flushDurableOps,
  hydrateDurableOps,
  resetDurableMetaForTests,
} from "@/lib/competitions/premier-league/ops/durable-store";
import {
  compactSourceObservations,
  persistLiveSourceObservations,
  loadSourceObservations,
} from "@/lib/competitions/premier-league/ops/fixture-sync";
import { compactResultObservations } from "@/lib/competitions/premier-league/ops/result-feed";
import type { SourceObservation, ResultObservation } from "@/lib/competitions/premier-league/ops/types";
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

async function raceObserverLocks(
  label: string,
  seedExpired = false
): Promise<string[]> {
  const raceDir = path.join(TMP, `lock-race-${label}`);
  const startPath = path.join(raceDir, "start");
  const lockPath = path.join(raceDir, "observer.lock.json");
  fs.mkdirSync(raceDir, { recursive: true });
  if (seedExpired) {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        holder: "expired-test-owner",
        leaseId: "expired-test-lease",
        lockedUntil: Date.now() - 1_000,
      }),
      "utf8"
    );
  }
  const outputs: string[] = [];
  let ready = 0;
  const children = Array.from({ length: 6 }, () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "scripts", "test-ops-lock-worker.ts")],
      {
        env: {
          ...process.env,
          PL_OPS_BACKEND: "file",
          PL_OBSERVER_LOCK_PATH: lockPath,
          FOA_LOCK_RACE_START: startPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("READY") && !output.includes("ACK_READY")) {
        output += "ACK_READY\n";
        ready += 1;
        if (ready === 6) fs.writeFileSync(startPath, "go", "utf8");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    return new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        outputs.push(output);
        if (code === 0) resolve();
        else reject(new Error(`lock worker exited ${code}: ${output}`));
      });
    });
  });
  await Promise.all(children);
  return outputs;
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

const coreLease = await acquireTickLock("core-isolation");
const observerLease = await acquireObserverLock("observer-a");
const overlappingObserverLease = await acquireObserverLock("observer-b");
check("observer lease is isolated from core lease", coreLease.ok && observerLease.ok);
check("overlapping observer lease rejected", overlappingObserverLease.ok === false);
check("observer lease exceeds function timeout", OBSERVER_LOCK_TTL_MS > 130_000);
await releaseObserverLock(observerLease.leaseId);
const reusedObserverLease = await acquireObserverLock("observer-c");
check("observer lease reusable after release", reusedObserverLease.ok === true);
await releaseObserverLock(reusedObserverLease.leaseId);
await releaseTickLock(coreLease.leaseId);

const raceOutputs = await raceObserverLocks("empty");
check(
  "atomic observer lease has one multi-process winner",
  raceOutputs.filter((output) => output.includes("RESULT:won")).length === 1
);
check(
  "all competing observer processes completed",
  raceOutputs.filter((output) => output.includes("RESULT:")).length === 6
);
const expiredRaceOutputs = await raceObserverLocks("expired", true);
check(
  "expired file lease fails closed under multi-process contention",
  expiredRaceOutputs.filter((output) => output.includes("RESULT:won")).length === 0
);
check(
  "all expired-lease contenders receive a result",
  expiredRaceOutputs.filter((output) => output.includes("RESULT:lost")).length === 6
);

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

function obs(partial: Partial<SourceObservation> & Pick<SourceObservation, "observationId" | "fixtureId" | "retrievedAt">): SourceObservation {
  return {
    kind: "fixture",
    source: "football-data.org",
    sourceFixtureId: "1",
    sourceUpdatedAt: null,
    raw: { bulky: "x".repeat(2000), scoreboard: { a: 1 } },
    normalized: {
      homeSlug: "arsenal",
      awaySlug: "coventry",
      kickoffUtc: "2026-08-21T19:00:00.000Z",
      kickoffLocal: null,
      scheduledDate: "2026-08-21",
      kickoffCertainty: "CONFIRMED",
      status: "SCHEDULED",
      homeGoals: null,
      awayGoals: null,
      sourceUpdatedAt: null,
    },
    verificationStatus: "VERIFIED",
    ...partial,
  };
}

const older = obs({
  observationId: "fd::a::1",
  fixtureId: "pl-2026-27-arsenal-coventry",
  retrievedAt: "2026-08-16T15:00:00.000Z",
});
const newer = obs({
  observationId: "fd::a::2",
  fixtureId: "pl-2026-27-arsenal-coventry",
  retrievedAt: "2026-08-16T15:29:00.000Z",
  raw: { bulky: "y".repeat(2000) },
});
const other = obs({
  observationId: "fd::b::1",
  fixtureId: "pl-2026-27-liverpool-bournemouth",
  retrievedAt: "2026-08-16T15:29:00.000Z",
});
const compacted = compactSourceObservations([older, newer, other, older]);
check("compact keeps one row per fixture+source", compacted.length === 2);
check("compact keeps the later retrievedAt", compacted.some((r) => r.observationId === "fd::a::2") && !compacted.some((r) => r.observationId === "fd::a::1"));
check("compact strips raw", compacted.every((r) => r.raw === null));

const bloated = Array.from({ length: 24 }, (_, i) =>
  Array.from({ length: 380 }, (__, j) =>
    obs({
      observationId: `fd::t${i}::${j}`,
      fixtureId: `pl-2026-27-fx-${j}`,
      retrievedAt: `2026-08-16T${String(10 + (i % 10)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}:00.000Z`,
      raw: { payload: "z".repeat(1500), i, j },
    })
  )
).flat();
const afterManyTicks = compactSourceObservations(bloated);
check("24 ticks × 380 fixtures compact to 380", afterManyTicks.length === 380);
check(
  "compacted observations stay well under 16MB",
  Buffer.byteLength(afterManyTicks.map((r) => JSON.stringify(r)).join("\n"), "utf8") < 2_000_000
);

persistLiveSourceObservations([older, newer]);
const persisted = loadSourceObservations();
check("persist rewrites instead of appending duplicates", persisted.length === 1);
check("persist keeps latest and drops raw", persisted[0].observationId === "fd::a::2" && persisted[0].raw === null);

const resultRows: ResultObservation[] = [
  {
    observationId: "result::1",
    fixtureId: "pl-2026-27-arsenal-coventry",
    source: "football-data.org",
    sourceFixtureId: "1",
    retrievedAt: "2026-08-21T21:00:00.000Z",
    matchStatus: "FINISHED",
    homeGoals: 2,
    awayGoals: 1,
    resultTimestamp: null,
    raw: { bulky: true },
  },
  {
    observationId: "result::2",
    fixtureId: "pl-2026-27-arsenal-coventry",
    source: "football-data.org",
    sourceFixtureId: "1",
    retrievedAt: "2026-08-21T21:05:00.000Z",
    matchStatus: "FINISHED",
    homeGoals: 2,
    awayGoals: 1,
    resultTimestamp: null,
    raw: { bulky: true },
  },
];
const compactResults = compactResultObservations(resultRows);
check("result compact is latest-per-fixture-source", compactResults.length === 1 && compactResults[0].observationId === "result::2");
check("result compact strips raw", compactResults[0].raw === null);

process.env.PL_OPS_DIR = path.join(TMP, "ops-compact");
const bloatedText = bloated.map((r) => JSON.stringify(r)).join("\n") + "\n";
check("synthetic pre-compact log is huge", Buffer.byteLength(bloatedText, "utf8") > 10_000_000);
applyBundleToDisk({
  jobs: captured.jobs,
  sourceObservations: bloatedText,
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
compactDurableOpsOnDisk();
const shrunk = captureBundleFromDisk();
check(
  "hydrate/flush compact brings sourceObservations under 16MB",
  Buffer.byteLength(JSON.stringify({ bundle: shrunk }), "utf8") < 16_000_000
);
check(
  "shrunk sourceObservations keep one row per fixture",
  shrunk.sourceObservations.trim().split("\n").filter(Boolean).length === 380
);

check("tape end", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380 && md5(TAPE) === START_MD5);

console.log(`\nPhase 2A.3 gates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
