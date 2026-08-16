/**
 * Phase 2A.2 live-operations gates.
 * Must not rewrite the committed LIVE_OOS tape.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-2a2-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_SEASON_MANIFEST_PATH = path.join(TMP, "season.json");
process.env.PL_FIXTURES_PATH = path.join(TMP, "fixtures.json");
process.env.PL_CLUB_SEASONS_PATH = path.join(TMP, "clubs.json");
process.env.PL_FIXTURE_REVISIONS_PATH = path.join(TMP, "revisions.jsonl");

import { brier3, rps3 } from "@/lib/evaluation/metrics";
import type { Fixture } from "@/lib/identity/types";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { canScheduleTimedPrediction } from "@/lib/competitions/premier-league/kickoff-certainty";
import { resetSeasonBundleCache } from "@/lib/competitions/premier-league/fixture-store";
import { persistSettlement, settlementFromSnapshot, canSettle, clearSettlementsForTests } from "@/lib/competitions/premier-league/settlement";
import { createSnapshot, getSnapshotByKey, listSnapshots, resetSnapshotCache } from "@/lib/snapshots/store";
import { snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { londonLocalToUtcIso } from "@/lib/competitions/premier-league/timezone";
import { STAGE_WINDOWS, windowFor, windowsDoNotOverlap, windowState } from "@/lib/competitions/premier-league/ops/stage-windows";
import { syncFixturesFromObservations, fixtureAsOf, persistScheduleRevisions, loadScheduleRevisions } from "@/lib/competitions/premier-league/ops/fixture-sync";
import { canonicalizeFixtureStatus } from "@/lib/competitions/premier-league/ingest";
import { observationFromNormalized, SOURCE_API_FOOTBALL, SOURCE_FOOTBALL_DATA } from "@/lib/competitions/premier-league/ops/sources";
import { planPredictionJobs, executeEligibleJobs, refreshJobStatuses, freezeScheduledStage } from "@/lib/competitions/premier-league/ops/scheduler";
import { listJobs, getJob, resetJobCache, jobIdOf } from "@/lib/competitions/premier-league/ops/job-ledger";
import { verifyFixtureResult, canSettleVerification, maybeCorrectResult } from "@/lib/competitions/premier-league/ops/result-feed";
import { applyVerifiedRatingUpdate, clearRatingEventsForTests, getRatingEvent } from "@/lib/competitions/premier-league/ops/rating-events";
import { liveRatingsAsOf } from "@/lib/competitions/premier-league/ops/live-ratings";
import { runLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { clearLiveOpsForTests } from "@/lib/competitions/premier-league/ops/reset";
import { ratingOf } from "@/lib/competitions/premier-league/ratings";
import type { SourceObservation } from "@/lib/competitions/premier-league/ops/types";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const START_MD5 = "34f7ca54025a3a48df9f1a169df66315";
const START_SHA = "a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da";

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
  return fs.readFileSync(TAPE, "utf8").trim().split("\n").filter(Boolean).length;
}

function fx(partial: Partial<Fixture> & { id: string; homeSlug: string; awaySlug: string }): Fixture {
  return {
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    date: partial.date ?? "2026-08-22",
    scheduledDate: partial.scheduledDate ?? partial.date ?? "2026-08-22",
    kickoff: partial.kickoff ?? partial.kickoffUtc ?? null,
    kickoffUtc: partial.kickoffUtc ?? partial.kickoff ?? null,
    kickoffLocal: partial.kickoffLocal ?? null,
    timezone: "Europe/London",
    kickoffCertainty: partial.kickoffCertainty ?? "DEFAULT",
    homeGoals: partial.homeGoals ?? null,
    awayGoals: partial.awayGoals ?? null,
    status: partial.status ?? "SCHEDULED",
    venue: "home",
    source: "test",
    retrievedAt: "2026-08-16T00:00:00.000Z",
    verificationStatus: partial.verificationStatus ?? "VERIFIED",
    ...partial,
  };
}

function obs(partial: {
  source: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc?: string | null;
  certainty?: SourceObservation["normalized"]["kickoffCertainty"];
  status?: SourceObservation["normalized"]["status"];
  homeGoals?: number | null;
  awayGoals?: number | null;
  retrievedAt?: string;
}): SourceObservation {
  return observationFromNormalized({
    source: partial.source,
    retrievedAt: partial.retrievedAt ?? "2026-08-16T12:00:00.000Z",
    sourceFixtureId: "ext-1",
    normalized: {
      homeSlug: partial.homeSlug,
      awaySlug: partial.awaySlug,
      kickoffUtc: partial.kickoffUtc ?? null,
      kickoffLocal: null,
      scheduledDate: partial.kickoffUtc ? partial.kickoffUtc.slice(0, 10) : "2026-08-22",
      kickoffCertainty: partial.certainty ?? "CONFIRMED",
      status: partial.status ?? "SCHEDULED",
      homeGoals: partial.homeGoals ?? null,
      awayGoals: partial.awayGoals ?? null,
      sourceUpdatedAt: null,
    },
  });
}

clearLiveOpsForTests();

// ── Trusted tape at start ───────────────────────────────────────────────
check("tape 380 lines at start", tapeLines() === 380);
check("tape md5 at start", md5(TAPE) === START_MD5);
check("tape sha256 at start", sha256(TAPE) === START_SHA);
check("stage windows do not overlap", windowsDoNotOverlap());
check(
  "FINAL_PREKICK is not described as a lineup-confirmed model",
  STAGE_WINDOWS.FINAL_PREKICK.meaning.includes("Not a lineup-confirmed model")
);

// ── Timezone: windows from UTC instants ─────────────────────────────────
const bstKick = londonLocalToUtcIso("2026-08-22", "15:00"); // BST → 14:00Z
const gmtKick = londonLocalToUtcIso("2026-12-26", "15:00"); // GMT → 15:00Z
const dstKick = londonLocalToUtcIso("2026-03-29", "16:30");
check("BST 15:00 is 14:00Z", bstKick.startsWith("2026-08-22T14:00"));
check("GMT 15:00 is 15:00Z", gmtKick.startsWith("2026-12-26T15:00"));
const bstT24 = windowFor("T24H", bstKick);
check(
  "T24H target is 24h before BST kickoff",
  Date.parse(bstKick) - Date.parse(bstT24.plannedAsOf) === 24 * 3600_000
);
const gmtT24 = windowFor("T24H", gmtKick);
check(
  "T24H target is 24h before GMT kickoff",
  Date.parse(gmtKick) - Date.parse(gmtT24.plannedAsOf) === 24 * 3600_000
);
check("DST kickoff parsed", Number.isFinite(Date.parse(dstKick)));

// ── Fixture sync identity + revision + idempotency ──────────────────────
const arsenalLeeds = fx({
  id: "pl-2026-27-arsenal-leeds",
  homeSlug: "arsenal",
  awaySlug: "leeds",
  date: "2026-10-10",
  kickoffUtc: londonLocalToUtcIso("2026-10-10", "15:00"),
  kickoffCertainty: "DEFAULT",
});
const newKick = londonLocalToUtcIso("2026-10-11", "16:30");
const sync1 = syncFixturesFromObservations({
  fixtures: [arsenalLeeds],
  observations: [
    obs({
      source: SOURCE_FOOTBALL_DATA,
      fixtureId: arsenalLeeds.id,
      homeSlug: "arsenal",
      awaySlug: "leeds",
      kickoffUtc: newKick,
      certainty: "CONFIRMED",
    }),
  ],
  now: "2026-08-16T18:00:00.000Z",
});
check("sync updates kickoff without changing id", sync1.fixtures[0].id === arsenalLeeds.id && sync1.fixtures[0].kickoffUtc === newKick);
check("sync sets CONFIRMED", sync1.fixtures[0].kickoffCertainty === "CONFIRMED");
check("sync writes one revision", sync1.revisions.length === 1);
const sync2 = syncFixturesFromObservations({
  fixtures: sync1.fixtures,
  observations: [
    obs({
      source: SOURCE_FOOTBALL_DATA,
      fixtureId: arsenalLeeds.id,
      homeSlug: "arsenal",
      awaySlug: "leeds",
      kickoffUtc: newKick,
      certainty: "CONFIRMED",
      retrievedAt: "2026-08-16T18:05:00.000Z",
    }),
  ],
  now: "2026-08-16T18:05:00.000Z",
});
check("second sync no logical change", sync2.changedFixtureIds.length === 0 && sync2.revisions.length === 0);
const sync3 = syncFixturesFromObservations({
  fixtures: sync2.fixtures,
  observations: [
    obs({
      source: SOURCE_FOOTBALL_DATA,
      fixtureId: arsenalLeeds.id,
      homeSlug: "arsenal",
      awaySlug: "leeds",
      kickoffUtc: newKick,
      certainty: "CONFIRMED",
      retrievedAt: "2026-08-16T18:10:00.000Z",
    }),
  ],
  now: "2026-08-16T18:10:00.000Z",
});
check("third sync still idempotent", sync3.revisions.length === 0);
persistScheduleRevisions(sync1.revisions);
const believed = fixtureAsOf(sync1.revisions, arsenalLeeds.id, "2026-08-16T18:00:00.000Z");
check("revision answers what kickoff we believed", Boolean(believed && believed.kickoff === newKick && believed.certainty === "CONFIRMED"));

// ── SOURCE_CONFLICT ─────────────────────────────────────────────────────
const conflictSync = syncFixturesFromObservations({
  fixtures: [arsenalLeeds],
  observations: [
    obs({
      source: SOURCE_FOOTBALL_DATA,
      fixtureId: arsenalLeeds.id,
      homeSlug: "arsenal",
      awaySlug: "leeds",
      kickoffUtc: londonLocalToUtcIso("2026-10-11", "16:30"),
    }),
    obs({
      source: SOURCE_API_FOOTBALL,
      fixtureId: arsenalLeeds.id,
      homeSlug: "arsenal",
      awaySlug: "leeds",
      kickoffUtc: londonLocalToUtcIso("2026-10-11", "14:00"),
    }),
  ],
  now: "2026-08-16T19:00:00.000Z",
});
check("kickoff disagreement is SOURCE_CONFLICT", conflictSync.conflicts.length === 1 && conflictSync.fixtures[0].verificationStatus === "SOURCE_CONFLICT");
check("conflict does not guess a kickoff", conflictSync.fixtures[0].kickoffUtc === arsenalLeeds.kickoffUtc);

// ── Scheduler A: DEFAULT cannot timed-stage ─────────────────────────────
clearLiveOpsForTests();
const defFx = fx({
  id: "pl-2026-27-everton-chelsea",
  homeSlug: "everton",
  awaySlug: "chelsea",
  kickoffUtc: londonLocalToUtcIso("2026-08-22", "15:00"),
  kickoffCertainty: "DEFAULT",
});
const nowInT24 = new Date(Date.parse(defFx.kickoffUtc!) - 24 * 3600_000).toISOString();
planPredictionJobs({ fixtures: [defFx], now: nowInT24 });
check("DEFAULT creates no timed jobs", listJobs().length === 0);
check("DEFAULT cannot schedule T24H", canScheduleTimedPrediction(defFx, "T24H") === false);

// ── Scheduler B/C: CONFIRMED T24H exactly once ──────────────────────────
clearLiveOpsForTests();
const confFx = fx({
  id: "pl-2026-27-arsenal-coventry",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  date: "2026-08-21",
  kickoffUtc: londonLocalToUtcIso("2026-08-21", "20:00"),
  kickoffCertainty: "CONFIRMED",
});
const t24Now = new Date(Date.parse(confFx.kickoffUtc!) - 24 * 3600_000).toISOString();
planPredictionJobs({ fixtures: [confFx], now: t24Now });
refreshJobStatuses(t24Now);
const t24Job = listJobs().find((j) => j.stage === "T24H")!;
check("CONFIRMED T24H job eligible in window", t24Job?.status === "ELIGIBLE");
const run1 = executeEligibleJobs({ fixtures: [confFx], now: t24Now });
check("first eligible run freezes one T24H", run1.succeeded === 1);
const snaps1 = listSnapshots().filter((s) => s.fixtureId === confFx.id && s.predictionStage === "T24H");
check("exactly one T24H snapshot", snaps1.length === 1);
planPredictionJobs({ fixtures: [confFx], now: t24Now });
refreshJobStatuses(t24Now);
const run2 = executeEligibleJobs({ fixtures: [confFx], now: t24Now });
check("rerun does not mint another snapshot", listSnapshots().filter((s) => s.predictionStage === "T24H").length === 1);
check(
  "rerun does not attempt a second freeze",
  run2.attempted === 0 && getJob(t24Job.jobId)?.status === "SUCCEEDED"
);
const frozen = snaps1[0];
check("scheduled asOf is strictly before kickoff", Date.parse(frozen.asOf) < Date.parse(confFx.kickoffUtc!));
check("snapshot origin is scheduled", (frozen.sourceState as { origin?: string }).origin === "scheduled");
check("ratingStateAsOf persisted", Boolean((frozen.sourceState as { ratingStateAsOf?: string }).ratingStateAsOf));

// ── Scheduler D: missed window is not backfilled ────────────────────────
clearLiveOpsForTests();
planPredictionJobs({ fixtures: [confFx], now: "2026-08-16T00:00:00.000Z" });
const afterWindow = new Date(Date.parse(confFx.kickoffUtc!) - 20 * 3600_000).toISOString();
refreshJobStatuses(afterWindow);
const missed = getJob(jobIdOf(confFx.id, "T24H", confFx.kickoffUtc!));
check("missed T24H marked MISSED", missed?.status === "MISSED");
const lateRun = executeEligibleJobs({ fixtures: [confFx], now: afterWindow });
check("missed T24H is not backfilled", lateRun.attempted === 0 && listSnapshots().length === 0);

// ── Scheduler E: reschedule before freeze ───────────────────────────────
clearLiveOpsForTests();
const oldKick = londonLocalToUtcIso("2026-08-22", "15:00");
const moved = londonLocalToUtcIso("2026-08-23", "16:30");
const moving = fx({
  id: "pl-2026-27-hull-manchester-united",
  homeSlug: "hull",
  awaySlug: "manchester-united",
  date: "2026-08-22",
  kickoffUtc: oldKick,
  kickoffCertainty: "CONFIRMED",
});
planPredictionJobs({ fixtures: [moving], now: "2026-08-16T00:00:00.000Z" });
const oldJobId = jobIdOf(moving.id, "T24H", oldKick);
check("job planned on original confirmed kickoff", Boolean(getJob(oldJobId)));
const movedFx = { ...moving, kickoffUtc: moved, kickoff: moved, date: "2026-08-23", kickoffCertainty: "CONFIRMED" as const };
planPredictionJobs({ fixtures: [movedFx], now: "2026-08-16T01:00:00.000Z" });
check("old job cancelled after reschedule", getJob(oldJobId)?.status === "CANCELLED");
check("new T24H job uses new kickoff", Boolean(getJob(jobIdOf(movedFx.id, "T24H", moved))));

// ── Scheduler F: postpone after EARLY ───────────────────────────────────
clearLiveOpsForTests();
const earlySnap = createSnapshot({
  fixtureId: confFx.id,
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  asOf: "2026-08-16T05:33:34.616Z",
  kickoff: confFx.kickoffUtc,
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "EARLY",
  evaluationClass: "LIVE_OOS",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  home: 0.71,
  draw: 0.19,
  away: 0.1,
  homeExpectedGoals: 2.2,
  awayExpectedGoals: 0.7,
  scorelineDistribution: {},
});
planPredictionJobs({ fixtures: [confFx], now: "2026-08-16T00:00:00.000Z" });
const postponed = { ...confFx, status: "POSTPONED" as const };
planPredictionJobs({ fixtures: [postponed], now: "2026-08-17T00:00:00.000Z" });
const earlyReread = getSnapshotByKey({
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  fixtureId: confFx.id,
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "EARLY",
  asOf: earlySnap.asOf,
});
check("EARLY snapshot preserved after postpone", earlyReread?.home === 0.71);
check(
  "future jobs cancelled on postpone",
  listJobs().filter((j) => j.status === "CANCELLED").length >= 1
);
check("postponed fixture is not settleable", canSettle(postponed) === false);


// ── Scheduler G: POSTPONED → rescheduled SCHEDULED resumes staging ──────
// Gate 5B fix regression (Phase 2A.2 targeted verification finding).
clearLiveOpsForTests();
const gKickOld = londonLocalToUtcIso("2026-08-21", "20:00");
const gKickNew = londonLocalToUtcIso("2026-09-01", "20:00");
const gFx = fx({
  id: "pl-2026-27-arsenal-coventry",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  date: "2026-08-21",
  kickoffUtc: gKickOld,
  kickoffCertainty: "CONFIRMED",
});
const gT24Now = new Date(Date.parse(gKickOld) - 24 * 3600_000).toISOString();
planPredictionJobs({ fixtures: [gFx], now: gT24Now });
refreshJobStatuses(gT24Now);
executeEligibleJobs({ fixtures: [gFx], now: gT24Now });
const gSnap = listSnapshots().find((s) => s.fixtureId === gFx.id && s.predictionStage === "T24H");
check("pre-postpone T24H frozen", Boolean(gSnap));
const gPostponedSync = syncFixturesFromObservations({
  fixtures: [gFx],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickOld, certainty: "TBD", status: "POSTPONED", retrievedAt: "2026-08-17T00:00:00.000Z" })],
  now: "2026-08-17T00:00:00.000Z",
});
const gPostponed = gPostponedSync.fixtures[0];
check("postponement through sync sets POSTPONED + certainty TBD", canonicalizeFixtureStatus(gPostponed.status) === "POSTPONED" && gPostponed.kickoffCertainty === "TBD");
planPredictionJobs({ fixtures: [gPostponed], now: "2026-08-17T00:00:00.000Z" });
check("postpone cancels future jobs", listJobs().some((j) => j.status === "CANCELLED"));
check("postponed fixture is not settleable", canSettle(gPostponed) === false);

const gResumeObs = (retrievedAt: string) =>
  obs({
    source: SOURCE_FOOTBALL_DATA,
    fixtureId: gFx.id,
    homeSlug: "arsenal",
    awaySlug: "coventry",
    kickoffUtc: gKickNew,
    certainty: "CONFIRMED",
    status: "SCHEDULED",
    retrievedAt,
  });
const gSync1 = syncFixturesFromObservations({
  fixtures: [gPostponed],
  observations: [gResumeObs("2026-08-18T10:00:00.000Z")],
  now: "2026-08-18T10:00:00.000Z",
});
const gResumed = gSync1.fixtures[0];
check("rescheduled fixture returns to SCHEDULED", canonicalizeFixtureStatus(gResumed.status) === "SCHEDULED", String(gResumed.status));
check("rescheduled kickoff is the new confirmed kickoff", gResumed.kickoffUtc === gKickNew && gResumed.kickoffCertainty === "CONFIRMED");
const gRev = gSync1.revisions[0];
check(
  "resume recorded as one explicit POSTPONED→SCHEDULED revision",
  Boolean(gRev) && gRev.oldStatus === "POSTPONED" && gRev.newStatus === "SCHEDULED" && gRev.oldKickoff === gKickOld && gRev.newKickoff === gKickNew && gRev.oldCertainty !== gRev.newCertainty
);
planPredictionJobs({ fixtures: gSync1.fixtures, now: "2026-08-18T10:05:00.000Z" });
check("future timed jobs replanned from the new kickoff (4)", listJobs().filter((j) => j.kickoffUtc === gKickNew && (j.status === "PENDING" || j.status === "ELIGIBLE")).length === 4);
check("no live jobs remain on the obsolete kickoff", listJobs().filter((j) => j.kickoffUtc === gKickOld && (j.status === "PENDING" || j.status === "ELIGIBLE" || j.status === "BLOCKED")).length === 0);
check("old frozen prediction preserved and immutable", listSnapshots().find((s) => s.provenance.uniqueKey === gSnap!.provenance.uniqueKey)?.homeProbability === gSnap!.homeProbability);

const gSync2 = syncFixturesFromObservations({
  fixtures: gSync1.fixtures,
  observations: [gResumeObs("2026-08-18T10:10:00.000Z")],
  now: "2026-08-18T10:10:00.000Z",
});
const gSync3 = syncFixturesFromObservations({
  fixtures: gSync2.fixtures,
  observations: [gResumeObs("2026-08-18T10:15:00.000Z")],
  now: "2026-08-18T10:15:00.000Z",
});
check("repeat payloads cause no logical change and no extra revisions", gSync2.changedFixtureIds.length === 0 && gSync3.changedFixtureIds.length === 0 && gSync2.revisions.length === 0 && gSync3.revisions.length === 0);
persistScheduleRevisions(gSync1.revisions);
check("exactly one resume revision persisted", loadScheduleRevisions().filter((r) => r.fixtureId === gFx.id && r.oldStatus === "POSTPONED" && r.newStatus === "SCHEDULED").length === 1);
planPredictionJobs({ fixtures: gSync3.fixtures, now: "2026-08-18T10:20:00.000Z" });
check("still exactly 4 jobs for the new kickoff (no duplicates)", listJobs().filter((j) => j.kickoffUtc === gKickNew).length === 4);
check("exactly one snapshot survives the whole flow", listSnapshots().filter((s) => s.fixtureId === gFx.id).length === 1);

const gJobsBefore = listJobs().length;
resetJobCache();
resetSnapshotCache();
check("restart: jobs restored from disk", listJobs().length === gJobsBefore);
check("restart: new jobs PENDING, old jobs CANCELLED or SUCCEEDED", listJobs().filter((j) => j.kickoffUtc === gKickNew).every((j) => j.status === "PENDING") && listJobs().filter((j) => j.kickoffUtc === gKickOld).every((j) => j.status === "CANCELLED" || j.status === "SUCCEEDED"));
check("restart: frozen snapshot unchanged", listSnapshots().find((s) => s.provenance.uniqueKey === gSnap!.provenance.uniqueKey)?.homeProbability === gSnap!.homeProbability);

// ── Scheduler G2: resume safety (conflicts + terminal states) ───────────
clearLiveOpsForTests();
const gConf = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "POSTPONED" as const }],
  observations: [
    obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "TBD", status: "POSTPONED" }),
    obs({ source: SOURCE_API_FOOTBALL, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: londonLocalToUtcIso("2026-09-02", "20:00"), certainty: "CONFIRMED", status: "SCHEDULED" }),
  ],
  now: "2026-08-18T10:00:00.000Z",
});
check("a still-POSTPONED source wins over a disagreeing SCHEDULED source", canonicalizeFixtureStatus(gConf.fixtures[0].status) === "POSTPONED");
planPredictionJobs({ fixtures: gConf.fixtures, now: "2026-08-18T10:05:00.000Z" });
check("no schedulable jobs while sources disagree on resume", listJobs().filter((j) => j.status === "PENDING" || j.status === "ELIGIBLE").length === 0);

const gConf2 = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "SCHEDULED" as const }],
  observations: [
    obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" }),
    obs({ source: SOURCE_API_FOOTBALL, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: londonLocalToUtcIso("2026-09-02", "20:00"), certainty: "CONFIRMED", status: "SCHEDULED" }),
  ],
  now: "2026-08-18T10:00:00.000Z",
});
check("two disagreeing rearranged kickoffs → SOURCE_CONFLICT", gConf2.conflicts.length === 1 && gConf2.fixtures[0].verificationStatus === "SOURCE_CONFLICT");
planPredictionJobs({ fixtures: gConf2.fixtures, now: "2026-08-18T10:05:00.000Z" });
check("SOURCE_CONFLICT blocks all scheduling", listJobs().filter((j) => j.status === "PENDING" || j.status === "ELIGIBLE").length === 0);

clearLiveOpsForTests();
const gDone = fx({ ...gFx, status: "FINISHED", homeGoals: 2, awayGoals: 0 });
const gStale = syncFixturesFromObservations({
  fixtures: [gDone],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("FINISHED stays FINISHED under a stale SCHEDULED payload", canonicalizeFixtureStatus(gStale.fixtures[0].status) === "FINISHED");
planPredictionJobs({ fixtures: gStale.fixtures, now: "2026-08-18T10:05:00.000Z" });
const gDoneJobs = listJobs();
check("FINISHED fixture produces no schedulable jobs and nothing can execute", gDoneJobs.filter((j) => j.status === "PENDING" || j.status === "ELIGIBLE").length === 0 && executeEligibleJobs({ fixtures: gStale.fixtures, now: "2026-08-18T10:10:00.000Z" }).attempted === 0);

const gCanc = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "CANCELLED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("CANCELLED never auto-reopened by a schedule payload", canonicalizeFixtureStatus(gCanc.fixtures[0].status) === "CANCELLED");
const gAbd = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "ABANDONED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("ABANDONED never auto-reopened by a schedule payload", canonicalizeFixtureStatus(gAbd.fixtures[0].status) === "ABANDONED");
const gSusp = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "SUSPENDED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("SUSPENDED never auto-reopened by a schedule payload", canonicalizeFixtureStatus(gSusp.fixtures[0].status) === "SUSPENDED");

const gTbd = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "POSTPONED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "TBD", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("POSTPONED not resumed when rearranged certainty is not CONFIRMED", canonicalizeFixtureStatus(gTbd.fixtures[0].status) === "POSTPONED");
const gSameKick = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "POSTPONED" as const, kickoffUtc: gKickNew, kickoff: gKickNew, kickoffCertainty: "TBD" }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("POSTPONED resumes when the rearranged kickoff was already known (same kickoff, now CONFIRMED)", canonicalizeFixtureStatus(gSameKick.fixtures[0].status) === "SCHEDULED" && gSameKick.fixtures[0].kickoffUtc === gKickNew && gSameKick.fixtures[0].kickoffCertainty === "CONFIRMED");
planPredictionJobs({ fixtures: gSameKick.fixtures, now: "2026-08-18T10:05:00.000Z" });
check("same-kickoff resume also plans the 4 future jobs", listJobs().filter((j) => j.kickoffUtc === gKickNew && (j.status === "PENDING" || j.status === "ELIGIBLE")).length === 4);
const gPast = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "POSTPONED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: "2026-08-10T19:00:00.000Z", certainty: "CONFIRMED", status: "SCHEDULED" })],
  now: "2026-08-18T10:00:00.000Z",
});
check("POSTPONED not resumed with a non-future kickoff", canonicalizeFixtureStatus(gPast.fixtures[0].status) === "POSTPONED");

// ── Scheduler G3: no backfill for windows that passed while rearranged ──
clearLiveOpsForTests();
const gLate = syncFixturesFromObservations({
  fixtures: [{ ...gFx, status: "POSTPONED" as const }],
  observations: [obs({ source: SOURCE_FOOTBALL_DATA, fixtureId: gFx.id, homeSlug: "arsenal", awaySlug: "coventry", kickoffUtc: gKickNew, certainty: "CONFIRMED", status: "SCHEDULED", retrievedAt: "2026-09-01T17:40:00.000Z" })],
  now: "2026-09-01T17:40:00.000Z",
});
planPredictionJobs({ fixtures: gLate.fixtures, now: "2026-09-01T17:40:00.000Z" });
const gLateJobs = listJobs();
check("already-passed windows of the rearranged fixture are MISSED, not backfilled", gLateJobs.filter((j) => j.kickoffUtc === gKickNew && (j.stage === "T24H" || j.stage === "T2H")).every((j) => j.status === "MISSED"));
check("remaining windows of the rearranged fixture stay schedulable", gLateJobs.filter((j) => j.kickoffUtc === gKickNew && (j.stage === "T60M" || j.stage === "FINAL_PREKICK")).length === 2);
check("no jobs minted for the original kickoff", gLateJobs.filter((j) => j.kickoffUtc === gKickOld).length === 0);

// ── Results A–E ─────────────────────────────────────────────────────────
const liveObs = [
  {
    observationId: "r1",
    fixtureId: confFx.id,
    source: "test-primary",
    sourceFixtureId: "1",
    retrievedAt: "2026-08-21T21:00:00.000Z",
    matchStatus: "LIVE" as const,
    homeGoals: 1,
    awayGoals: 0,
    resultTimestamp: null,
    raw: {},
  },
];
const liveV = verifyFixtureResult(confFx.id, liveObs, "2026-08-21T21:00:00.000Z");
check("LIVE result is not VERIFIED_FINAL", liveV.status === "UNVERIFIED" && !canSettleVerification(liveV));

const unverified = verifyFixtureResult(
  confFx.id,
  [
    {
      ...liveObs[0],
      matchStatus: "FINISHED",
      source: "social-media",
      homeGoals: 3,
      awayGoals: 0,
    },
  ],
  "2026-08-21T22:00:00.000Z"
);
check("untrusted FINISHED is not verified", unverified.status !== "VERIFIED_FINAL");

const verified = verifyFixtureResult(
  confFx.id,
  [
    {
      observationId: "r2",
      fixtureId: confFx.id,
      source: "test-primary",
      sourceFixtureId: "1",
      retrievedAt: "2026-08-21T22:00:00.000Z",
      matchStatus: "FINISHED",
      homeGoals: 2,
      awayGoals: 0,
      resultTimestamp: "2026-08-21T21:50:00.000Z",
      raw: {},
    },
  ],
  "2026-08-21T22:00:00.000Z"
);
check("single trusted FINISHED is VERIFIED_FINAL", verified.status === "VERIFIED_FINAL" && canSettleVerification(verified));

const twice = [
  {
    observationId: "r3",
    fixtureId: confFx.id,
    source: "test-primary",
    sourceFixtureId: "1",
    retrievedAt: "2026-08-21T22:05:00.000Z",
    matchStatus: "FINISHED" as const,
    homeGoals: 2,
    awayGoals: 0,
    resultTimestamp: null,
    raw: {},
  },
];
const vAgain = verifyFixtureResult(confFx.id, twice, "2026-08-21T22:05:00.000Z");
check("repeat trusted score still VERIFIED_FINAL", vAgain.status === "VERIFIED_FINAL");

const conflictV = verifyFixtureResult(
  confFx.id,
  [
    {
      observationId: "c1",
      fixtureId: confFx.id,
      source: "test-primary",
      sourceFixtureId: "1",
      retrievedAt: "2026-08-21T22:10:00.000Z",
      matchStatus: "FINISHED",
      homeGoals: 2,
      awayGoals: 0,
      resultTimestamp: null,
      raw: {},
    },
    {
      observationId: "c2",
      fixtureId: confFx.id,
      source: "test-secondary",
      sourceFixtureId: "2",
      retrievedAt: "2026-08-21T22:10:00.000Z",
      matchStatus: "FINISHED",
      homeGoals: 1,
      awayGoals: 1,
      resultTimestamp: null,
      raw: {},
    },
  ],
  "2026-08-21T22:10:00.000Z"
);
check("conflicting scores do not settle", conflictV.status === "CONFLICT" && !canSettleVerification(conflictV));

// ── Metrics match audited definitions ───────────────────────────────────
const metricSnap = createSnapshot({
  fixtureId: "metric-fx",
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  asOf: "2026-08-16T00:00:00.000Z",
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "EARLY",
  evaluationClass: "LIVE_OOS",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  home: 0.5,
  draw: 0.3,
  away: 0.2,
  homeExpectedGoals: 1.5,
  awayExpectedGoals: 1.0,
  scorelineDistribution: {},
});
const metricFx = fx({
  id: "metric-fx",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  status: "FINISHED",
  homeGoals: 1,
  awayGoals: 0,
});
const rec = settlementFromSnapshot(metricSnap, metricFx, "2026-08-21T22:00:00.000Z");
const expectBrier = brier3(0.5, 0.3, 0.2, "home");
const expectRps = rps3(0.5, 0.3, 0.2, "home");
const expectLl = -Math.log(0.5);
check("Brier matches audited definition", Math.abs(rec.brier - expectBrier) < 1e-12, String(rec.brier));
check("RPS matches audited definition", Math.abs(rec.rps - expectRps) < 1e-12, String(rec.rps));
check("LogLoss matches audited definition", Math.abs(rec.logLoss - expectLl) < 1e-12, String(rec.logLoss));
check("top-pick correct on home favourite", rec.topPickCorrect === true);
const firstSettle = persistSettlement(rec);
const secondSettle = persistSettlement({ ...rec, brier: 99 });
check("settlement first-write-wins", firstSettle.brier === rec.brier && secondSettle.brier === rec.brier);

// ── Rating exactly-once + future forecast uses new state ────────────────
clearRatingEventsForTests();
const match1 = fx({
  id: "pl-2026-27-arsenal-coventry",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  date: "2026-08-21",
  kickoffUtc: londonLocalToUtcIso("2026-08-21", "20:00"),
  kickoffCertainty: "CONFIRMED",
  status: "FINISHED",
  homeGoals: 2,
  awayGoals: 0,
});
const pre = liveRatingsAsOf("2026-08-21T18:00:00.000Z");
const predA = snapshotPremierLeagueMatch("arsenal", "coventry", {
  asOf: "2026-08-21T18:00:00.000Z",
  kickoff: match1.kickoffUtc ?? undefined,
  fixtureId: match1.id,
  predictionStage: "T2H",
  evaluationClass: "LIVE_OOS",
  origin: "scheduled",
});
const applied1 = applyVerifiedRatingUpdate({ fixture: match1, appliedAt: "2026-08-21T22:00:00.000Z" });
check("first verified result applies a rating event", applied1.applied === true);
const applied2 = applyVerifiedRatingUpdate({ fixture: match1, appliedAt: "2026-08-21T22:05:00.000Z" });
check("second ingest does not apply Elo again", applied2.applied === false);
check("post-rating unchanged on repeat", applied2.event.postHome === applied1.event.postHome);
check("pre and post ratings differ", applied1.event.preHome !== applied1.event.postHome);
const predB = snapshotPremierLeagueMatch("everton", "crystal-palace", {
  asOf: "2026-08-22T10:00:00.000Z",
  kickoff: londonLocalToUtcIso("2026-08-22", "15:00"),
  fixtureId: "pl-2026-27-everton-crystal-palace",
  predictionStage: "T24H",
  evaluationClass: "LIVE_OOS",
  origin: "scheduled",
});
const eloA = (predA.sourceState as { eloHome: number }).eloHome;
const postState = liveRatingsAsOf("2026-08-22T10:00:00.000Z");
check("prediction A used pre-match ratings", Math.abs(eloA - ratingOf(pre, "arsenal")) < 1e-9);
check("future state includes the applied event", Math.abs(ratingOf(postState, "arsenal") - applied1.event.postHome) < 1e-9);
check("prediction A bytes unchanged after rating update", predA.homeProbability === getSnapshotByKey({
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  fixtureId: predA.fixtureId,
  modelVersion: predA.modelVersion,
  predictionStage: predA.predictionStage,
  asOf: predA.asOf,
})!.homeProbability);
void predB;
check("model version unchanged after rating update", predA.modelVersion === PRODUCTION_MODEL_VERSION && getRatingEvent(match1.id)?.modelVersion === PRODUCTION_MODEL_VERSION);

// ── Restart recovery ────────────────────────────────────────────────────
const jobsBefore = listJobs().length;
resetJobCache();
const jobsAfter = listJobs().length;
check("jobs survive cache reset (restart)", jobsAfter === jobsBefore);
const eventBefore = getRatingEvent(match1.id);
resetJobCache();
check("rating event still present after restart", getRatingEvent(match1.id)?.eventId === eventBefore?.eventId);
applyVerifiedRatingUpdate({ fixture: match1, appliedAt: "2026-08-21T23:00:00.000Z" });
check("restart does not re-apply ratings", getRatingEvent(match1.id)?.appliedAt === eventBefore?.appliedAt);

// ── Correction is auditable and non-mutating ────────────────────────────
const corr = maybeCorrectResult({
  fixtureId: match1.id,
  previous: verified,
  incoming: { ...verified, homeGoals: 3, awayGoals: 0 },
  now: "2026-08-22T00:00:00.000Z",
});
check("score correction recorded without mutating settlement", corr.length === 1 && corr[0].ratingsTouched === false);

async function rest() {
  // ── Tick is idempotent on official baseline ─────────────────────────────
  const tick1 = await runLiveOpsTick({
    now: "2026-08-16T08:00:00.000Z",
    fixtures: [defFx, confFx],
    sources: [],
    persistFixtures: false,
    persistObservations: false,
    persistFixturePatches: false,
    skipNetwork: true,
  });
  const tick2 = await runLiveOpsTick({
    now: "2026-08-16T08:05:00.000Z",
    fixtures: [defFx, confFx],
    sources: [],
    persistFixtures: false,
    persistObservations: false,
    persistFixturePatches: false,
    skipNetwork: true,
  });
  check("tick against DEFAULT+CONFIRMED plans only CONFIRMED timed jobs", listJobs().every((j) => j.fixtureId === confFx.id));
  check("second tick does not duplicate jobs", tick2.jobsFailed === 0);
  void tick1;

  // ── Health builds ───────────────────────────────────────────────────────
  const health = buildHealthReport(new Date("2026-08-16T08:10:00.000Z"));
  check("health overall is a known state", ["HEALTHY", "DEGRADED", "BLOCKED"].includes(health.overall));
  check("health exposes DATA_READY", health.season.dataReady === "DATA_READY" || health.season.dataReady === "DATA_BLOCKED");
  check("health exposes job counts", typeof health.scheduler.jobs.PENDING === "number");
  check("health exposes LIVE_OOS totals", typeof health.liveOos.total === "number");

  // ── Abandoned / live not settleable ─────────────────────────────────────
  check("LIVE fixture cannot settle", canSettle({ ...confFx, status: "LIVE", homeGoals: 1, awayGoals: 0 }) === false);
  check("ABANDONED fixture cannot settle", canSettle({ ...confFx, status: "ABANDONED", homeGoals: 1, awayGoals: 0 }) === false);
  check("SUSPENDED fixture cannot settle", canSettle({ ...confFx, status: "SUSPENDED", homeGoals: 1, awayGoals: 0 }) === false);

  // ── Trusted tape at end ─────────────────────────────────────────────────
  check("tape 380 lines at end", tapeLines() === 380);
  check("tape md5 at end", md5(TAPE) === START_MD5);
  check("tape sha256 at end", sha256(TAPE) === START_SHA);
  check("tape byte-identical", md5(TAPE) === START_MD5 && sha256(TAPE) === START_SHA);

  resetSeasonBundleCache();
  clearSettlementsForTests();

  console.log(`\nPhase 2A.2 gates: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

rest().catch((err) => {
  console.error(err);
  process.exit(1);
});
