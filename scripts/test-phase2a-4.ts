/**
 * Phase 2A.4 gates: composite settlement surface + exactly-once across
 * frozen tape + operational snapshots. Isolated storage only.
 * Must not rewrite the committed LIVE_OOS tape or production Mongo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-2a4-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TMP, "ops/live-oos-operational.jsonl");
process.env.PL_RATING_EVENT_PATH = path.join(TMP, "ops/rating-events.jsonl");
process.env.PL_RATING_STATE_PATH = path.join(TMP, "ops/rating-state.json");
process.env.PL_TICK_LOCK_PATH = path.join(TMP, "ops/tick.lock.json");
process.env.PL_OPS_BACKEND = "file";
process.env.OPS_SCHEDULER_HOST = "github-actions";
delete process.env.VERCEL;
delete process.env.CRON_SECRET;

import type { Fixture } from "@/lib/identity/types";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import {
  canSettle,
  clearSettlementsForTests,
  loadSettlements,
  persistSettlement,
  settleFixture,
} from "@/lib/competitions/premier-league/settlement";
import {
  createSnapshot,
  listSnapshots,
  loadCommittedLiveOos,
  resetSnapshotCache,
  type CreateSnapshotInput,
  type PredictionSnapshot,
} from "@/lib/snapshots/store";
import { canonicalSnapshotIdentity } from "@/lib/snapshots/types";
import {
  listLiveSnapshots,
  liveSnapshotIdentity,
  liveSnapshotUniverse,
} from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { archiveOperationalLiveOos, loadOperationalLiveOos } from "@/lib/competitions/premier-league/ops/operational-archive";
import { fixtureLiveView, livePerformanceReport } from "@/lib/competitions/premier-league/live-ledger";
import {
  applyVerifiedRatingUpdate,
  clearRatingEventsForTests,
  listRatingEvents,
  resetRatingEventCache,
} from "@/lib/competitions/premier-league/ops/rating-events";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { acquireTickLock, releaseTickLock } from "@/lib/competitions/premier-league/ops/tick-lock";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { windowFor } from "@/lib/competitions/premier-league/ops/stage-windows";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const START_MD5 = "34f7ca54025a3a48df9f1a169df66315";
const START_SHA = "a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da";
const FIXTURE_ID = "pl-2026-27-arsenal-coventry";
const KICKOFF = "2026-08-21T19:00:00.000Z";

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
function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function tapeLines(): number {
  return fs.readFileSync(TAPE, "utf8").trim().split("\n").length;
}
function tapeIntact(label: string): void {
  check(`${label}: tape lines`, tapeLines() === 380);
  check(`${label}: tape md5`, md5(TAPE) === START_MD5);
  check(`${label}: tape sha256`, sha256(TAPE) === START_SHA);
}
function req(headers: Record<string, string>, url = "http://local/api/ops/tick") {
  return { headers: new Headers(headers), url };
}

function mint(partial: Partial<CreateSnapshotInput> & Pick<CreateSnapshotInput, "predictionStage" | "asOf">): PredictionSnapshot {
  return createSnapshot({
    fixtureId: FIXTURE_ID,
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    modelVersion: PRODUCTION_MODEL_VERSION,
    evaluationClass: "LIVE_OOS",
    homeSlug: "arsenal",
    awaySlug: "coventry",
    homeTeam: "Arsenal",
    awayTeam: "Coventry City",
    kickoff: KICKOFF,
    home: 0.55,
    draw: 0.25,
    away: 0.2,
    homeExpectedGoals: 1.6,
    awayExpectedGoals: 1.0,
    scorelineDistribution: { "1-0": 0.12 },
    provenanceNotes: "isolated 2A.4 operational stage",
    ...partial,
  });
}

function finishedFixture(): Fixture {
  return {
    id: FIXTURE_ID,
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    date: "2026-08-21",
    kickoffUtc: KICKOFF,
    kickoff: KICKOFF,
    homeSlug: "arsenal",
    awaySlug: "coventry",
    homeTeam: "Arsenal",
    awayTeam: "Coventry City",
    status: "FINISHED",
    homeGoals: 2,
    awayGoals: 1,
    resultSource: "isolated-test",
    kickoffCertainty: "CONFIRMED",
    source: "isolated-test",
    venue: "home",
  } as Fixture;
}

async function main() {
  tapeIntact("start");

  const committed = loadCommittedLiveOos();
  const early = committed.find((s) => s.fixtureId === FIXTURE_ID);
  check("tape has Arsenal–Coventry frozen base", Boolean(early));
  check("frozen base is EARLY LIVE_OOS", early?.predictionStage === "EARLY" && early?.evaluationClass === "LIVE_OOS");
  const earlyBytes = JSON.stringify({
    home: early!.homeProbability,
    draw: early!.drawProbability,
    away: early!.awayProbability,
    key: early!.provenance.uniqueKey,
    asOf: early!.asOf,
    model: early!.modelVersion,
  });

  resetSnapshotCache();
  const working = listSnapshots();
  const universe = liveSnapshotUniverse(PREMIER_LEAGUE_CURRENT_SEASON);
  check("production-like listSnapshots excludes tape", !working.some((s) => s.provenance.uniqueKey === early!.provenance.uniqueKey));
  check("composite count is 380", universe.total === 380, String(universe.total));
  check("composite committed is 380", universe.committed === 380);
  check("composite operational is 0", universe.operational === 0);
  check("working store empty", working.length === 0);
  const live = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  check("live report still 380 / settled 0", live.nPredictions === 380 && live.nSettled === 0);
  check("live stages PRESEASON 365", live.stages.PRESEASON === 365);
  check("live stages EARLY 15", live.stages.EARLY === 15);
  check("live timed stages still 0", live.stages.T24H === 0 && live.stages.FINAL_PREKICK === 0);

  const overlap = archiveOperationalLiveOos([early!]);
  check("archiving a tape row is a no-op or isolated copy", overlap.appended === 1 || overlap.appended === 0);
  resetSnapshotCache();
  const afterCopy = liveSnapshotUniverse(PREMIER_LEAGUE_CURRENT_SEASON);
  check("dedup keeps composite at 380", afterCopy.total === 380, String(afterCopy.total));
  check("copied tape row is not extra operational", afterCopy.operational === 0);

  const preseason = mint({
    predictionStage: "PRESEASON",
    asOf: "2026-06-19T00:00:00.000Z",
    home: 0.62,
    draw: 0.22,
    away: 0.16,
  });
  const t24 = mint({ predictionStage: "T24H", asOf: windowFor("T24H", KICKOFF).plannedAsOf, home: 0.64, draw: 0.21, away: 0.15 });
  const t2h = mint({ predictionStage: "T2H", asOf: windowFor("T2H", KICKOFF).plannedAsOf, home: 0.66, draw: 0.2, away: 0.14 });
  const t60 = mint({ predictionStage: "T60M", asOf: windowFor("T60M", KICKOFF).plannedAsOf, home: 0.67, draw: 0.2, away: 0.13 });
  const final = mint({
    predictionStage: "FINAL_PREKICK",
    asOf: windowFor("FINAL_PREKICK", KICKOFF).plannedAsOf,
    home: 0.68,
    draw: 0.19,
    away: 0.13,
  });
  archiveOperationalLiveOos([preseason, t24, t2h, t60, final]);

  const keys = [early!, preseason, t24, t2h, t60, final].map((s) => liveSnapshotIdentity(s));
  check("six distinct canonical identities", new Set(keys).size === 6);
  check("identity matches snapshotUniqueKey helper", keys[0] === canonicalSnapshotIdentity(early!));

  const forFixture = listLiveSnapshots({
    fixtureId: FIXTURE_ID,
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    evaluationClass: "LIVE_OOS",
  });
  check("fixture universe is 6", forFixture.length === 6, String(forFixture.length));
  const stages = new Set(forFixture.map((s) => String(s.predictionStage)));
  check(
    "all six genuine stages present",
    ["PRESEASON", "EARLY", "T24H", "T2H", "T60M", "FINAL_PREKICK"].every((st) => stages.has(st))
  );

  const mixed = liveSnapshotUniverse(PREMIER_LEAGUE_CURRENT_SEASON);
  check("season composite = 380 frozen + 5 operational", mixed.total === 385, String(mixed.total));
  check("operational timed+preseason = 5", mixed.operational === 5, String(mixed.operational));

  const fx = finishedFixture();
  check("verified finished is settleable", canSettle(fx) === true);
  const first = settleFixture(fx, "2026-08-21T21:00:00.000Z", {
    evaluationClass: "LIVE_OOS",
    verificationId: "isolated::arsenal-coventry",
  });
  check("first VERIFIED_FINAL writes 6 settlements", first.length === 6, String(first.length));
  check(
    "every snapshot identity received a settlement",
    first.every((r) => keys.includes(r.snapshotUniqueKey)) && new Set(first.map((r) => r.snapshotUniqueKey)).size === 6
  );
  check("frozen EARLY settled", first.some((r) => r.predictionStage === "EARLY"));
  check("operational timed stages settled", ["T24H", "T2H", "T60M", "FINAL_PREKICK"].every((st) => first.some((r) => r.predictionStage === st)));
  check("synthetic PRESEASON settled", first.some((r) => r.predictionStage === "PRESEASON"));

  const replay = settleFixture(fx, "2026-08-21T21:05:00.000Z", { evaluationClass: "LIVE_OOS" });
  check("replay returns same 6 identities", replay.length === 6);
  check(
    "replay is exactly-once (first-write timestamps kept)",
    replay.every((r) => r.settledAt === "2026-08-21T21:00:00.000Z")
  );
  const onDisk = loadSettlements().filter((r) => r.fixtureId === FIXTURE_ID);
  check("settlement file has 6 lines after replay", onDisk.length === 6, String(onDisk.length));

  const again = persistSettlement({ ...first[0], brier: 99 });
  check("persistSettlement first-write-wins", again.brier === first[0].brier && again.brier !== 99);

  resetSnapshotCache();
  resetRatingEventCache();
  const afterRestart = settleFixture(fx, "2026-08-21T22:00:00.000Z", { evaluationClass: "LIVE_OOS" });
  check("restart still 6 settlements", afterRestart.length === 6);
  check("restart created no extras", loadSettlements().filter((r) => r.fixtureId === FIXTURE_ID).length === 6);
  const rereadEarly = loadCommittedLiveOos().find((s) => s.fixtureId === FIXTURE_ID)!;
  check(
    "base EARLY probabilities immutable",
    JSON.stringify({
      home: rereadEarly.homeProbability,
      draw: rereadEarly.drawProbability,
      away: rereadEarly.awayProbability,
      key: rereadEarly.provenance.uniqueKey,
      asOf: rereadEarly.asOf,
      model: rereadEarly.modelVersion,
    }) === earlyBytes
  );
  check("working store still does not contain the tape row", !listSnapshots().some((s) => s.provenance.uniqueKey === early!.provenance.uniqueKey));

  const report = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const byStage = Object.fromEntries(report.byStage.map((r) => [r.stage, r.nSettled]));
  check("live performance sees PRESEASON settlement", byStage.PRESEASON === 1);
  check("live performance sees EARLY settlement", byStage.EARLY === 1);
  check("live performance sees T24H settlement", byStage.T24H === 1);
  check("live performance sees T2H settlement", byStage.T2H === 1);
  check("live performance sees T60M settlement", byStage.T60M === 1);
  check("live performance sees FINAL_PREKICK settlement", byStage.FINAL_PREKICK === 1);
  check("headline settled is 6 (isolated store)", report.nSettled === 6);
  check("headline metrics stay null below N=20", report.brier === null && report.rps === null);

  const view = fixtureLiveView(FIXTURE_ID);
  check("fixture view has 6 snapshots", view.snapshots.length === 6);
  check(
    "fixture view reports every stage",
    ["PRESEASON", "EARLY", "T24H", "T2H", "T60M", "FINAL_PREKICK"].every((st) => view.byStage[st].snapshot && view.byStage[st].settlement)
  );

  clearRatingEventsForTests();
  const applied1 = applyVerifiedRatingUpdate({ fixture: fx, appliedAt: "2026-08-21T21:00:00.000Z" });
  const applied2 = applyVerifiedRatingUpdate({ fixture: fx, appliedAt: "2026-08-21T21:10:00.000Z" });
  resetRatingEventCache();
  const applied3 = applyVerifiedRatingUpdate({ fixture: fx, appliedAt: "2026-08-21T21:20:00.000Z" });
  check("rating applies once", applied1.applied === true);
  check("rating replay skipped", applied2.applied === false && applied3.applied === false);
  check("exactly one rating event after restart", listRatingEvents().filter((e) => e.fixtureId === FIXTURE_ID).length === 1);

  process.env.VERCEL = "1";
  process.env.CRON_SECRET = "correct-secret";
  check("missing secret rejected", authorizeOpsTick(req({})).ok === false);
  check("wrong secret rejected", authorizeOpsTick(req({ authorization: "Bearer no" })).ok === false);
  check("correct secret accepted", authorizeOpsTick(req({ authorization: "Bearer correct-secret" })).ok === true);
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL;

  const firstLock = await acquireTickLock("2a4-a");
  const secondLock = await acquireTickLock("2a4-b");
  check("first lease acquired", firstLock.ok === true);
  check("overlapping lease rejected", secondLock.ok === false);
  await releaseTickLock(firstLock.leaseId);

  const health = buildHealthReport();
  check("cancelled jobs are not counted as active", health.scheduler.activeJobs === health.scheduler.jobs.PENDING + health.scheduler.jobs.ELIGIBLE + health.scheduler.jobs.RUNNING);
  check("scheduler host exposed", health.scheduler.host === "github-actions");

  clearSettlementsForTests();
  clearRatingEventsForTests();
  resetSnapshotCache();
  for (const file of [
    process.env.SNAPSHOT_STORE_PATH,
    process.env.PL_OPERATIONAL_LIVE_OOS_PATH,
    process.env.SETTLEMENT_STORE_PATH,
  ]) {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  }
  check("test state removed", !fs.existsSync(process.env.SETTLEMENT_STORE_PATH!));
  const cleaned = liveSnapshotUniverse(PREMIER_LEAGUE_CURRENT_SEASON);
  check("after cleanup composite returns to 380 / 0", cleaned.total === 380 && cleaned.operational === 0);

  tapeIntact("end");

  console.log(`\nPhase 2A.4 gates: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
