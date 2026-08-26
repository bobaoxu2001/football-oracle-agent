/** Phase 4A rolling-stage temporal, immutability, and selection gates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-phase4a-rolling-"));
process.env.PL_OPS_BACKEND = "file";
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TMP, "ops/live-oos-operational.jsonl");

import type { Fixture } from "@/lib/identity/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { createSnapshot, listSnapshots } from "@/lib/snapshots/store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import {
  PRODUCTION_MODEL_VERSION,
} from "@/lib/competitions/premier-league/model-tracks";
import { SHADOW_MODEL_VERSION } from "@/lib/competitions/premier-league/shadow/track";
import { canScheduleTimedPrediction } from "@/lib/competitions/premier-league/kickoff-certainty";
import { clearLiveOpsForTests } from "@/lib/competitions/premier-league/ops/reset";
import {
  applyVerifiedRatingUpdate,
  ratingEventsAsOf,
} from "@/lib/competitions/premier-league/ops/rating-events";
import {
  clearJobsForTests,
  getJob,
  jobIdOf,
  listJobs,
  updateJob,
} from "@/lib/competitions/premier-league/ops/job-ledger";
import {
  executeEligibleJobs,
  freezeScheduledStage,
  planPredictionJobs,
  refreshJobStatuses,
} from "@/lib/competitions/premier-league/ops/scheduler";
import {
  STAGE_WINDOWS,
  windowFor,
  windowsDoNotOverlap,
} from "@/lib/competitions/premier-league/ops/stage-windows";
import {
  buildMatchForecast,
  forecastTimeline,
  productionSnapshotsForMatch,
  selectProductionSnapshot,
} from "@/lib/match-forecast/service";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const TAPE_SHA = "a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da";

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixture(input: {
  id: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc: string;
  retrievedAt: string;
  certainty?: Fixture["kickoffCertainty"];
  status?: Fixture["status"];
  homeGoals?: number | null;
  awayGoals?: number | null;
}): Fixture {
  return {
    id: input.id,
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    date: input.kickoffUtc.slice(0, 10),
    scheduledDate: input.kickoffUtc.slice(0, 10),
    kickoff: input.kickoffUtc,
    kickoffUtc: input.kickoffUtc,
    kickoffLocal: null,
    timezone: "Europe/London",
    kickoffCertainty: input.certainty ?? "DEFAULT",
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    homeGoals: input.homeGoals ?? null,
    awayGoals: input.awayGoals ?? null,
    status: input.status ?? "SCHEDULED",
    venue: "home",
    source: "phase4a-test",
    retrievedAt: input.retrievedAt,
    verificationStatus: "VERIFIED",
  };
}

function cloneSnapshot(
  source: PredictionSnapshot,
  input: Partial<PredictionSnapshot> & Pick<PredictionSnapshot, "fixtureId" | "asOf" | "kickoff" | "predictionStage">
): PredictionSnapshot {
  const modelVersion = input.modelVersion ?? source.modelVersion;
  const key = [
    "premier-league",
    PREMIER_LEAGUE_CURRENT_SEASON,
    input.fixtureId,
    modelVersion,
    input.predictionStage,
    input.asOf,
  ].join("::");
  return {
    ...source,
    ...input,
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    modelVersion,
    createdAt: input.createdAt ?? input.asOf,
    dataCutoff: input.asOf,
    sourceState: {
      ...source.sourceState,
      // These are synthetic pre-Phase-4B selection rows. Never carry a
      // context reference across fixture/cutoff identity changes.
      contextSnapshotId: null,
      contextSchemaVersion: null,
      contextSnapshotCutoffAt: null,
      contextSnapshotGeneratedAt: null,
      contextTemporalRule: null,
      contextLineupStatus: "NONE",
      contextLineupAvailableAt: null,
      contextEvidenceCount: 0,
      contextModelUsedEvidenceCount: 0,
      contextInformationalEvidenceCount: 0,
      contextUsedInForecastEvidenceIds: [],
      ...(input.sourceState ?? {}),
    },
    provenance: { store: "memory", uniqueKey: key, notes: "Phase 4A selection fixture" },
  };
}

function main(): void {
  assert.equal(sha256(TAPE), TAPE_SHA);
  assert.equal(fs.readFileSync(TAPE, "utf8").trim().split("\n").length, 380);
  clearLiveOpsForTests();

  assert.equal(windowsDoNotOverlap(), true);
  assert.equal(STAGE_WINDOWS.T7D.eligibleFromOffsetMs, STAGE_WINDOWS.T7D.targetOffsetMs);
  assert.equal(STAGE_WINDOWS.T24H.eligibleFromOffsetMs, STAGE_WINDOWS.T24H.targetOffsetMs);
  assert.equal(STAGE_WINDOWS.T2H.eligibleFromOffsetMs, STAGE_WINDOWS.T2H.targetOffsetMs);
  assert.equal(STAGE_WINDOWS.T60M.eligibleFromOffsetMs, STAGE_WINDOWS.T60M.targetOffsetMs);
  assert.equal(
    STAGE_WINDOWS.FINAL_PREKICK.eligibleFromOffsetMs,
    STAGE_WINDOWS.FINAL_PREKICK.targetOffsetMs
  );

  const rolling = fixture({
    id: "phase4a-rolling-default",
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoffUtc: "2026-08-29T19:00:00.000Z",
    retrievedAt: "2026-08-16T05:32:02.136Z",
  });
  const t7 = windowFor("T7D", rolling.kickoffUtc!);
  assert.equal(Date.parse(rolling.kickoffUtc!) - Date.parse(t7.plannedAsOf), 7 * 24 * 3_600_000);
  assert.equal(canScheduleTimedPrediction(rolling, "T7D"), true);
  assert.equal(canScheduleTimedPrediction(rolling, "T24H"), false);

  const known = fixture({
    id: "phase4a-known-result",
    homeSlug: "arsenal",
    awaySlug: "coventry",
    kickoffUtc: "2026-08-21T19:00:00.000Z",
    retrievedAt: "2026-08-16T05:32:02.136Z",
    certainty: "CONFIRMED",
    status: "FINISHED",
    homeGoals: 2,
    awayGoals: 0,
  });
  const appliedKnown = applyVerifiedRatingUpdate({
    fixture: known,
    appliedAt: "2026-08-21T21:30:00.000Z",
  }).event;
  const lateKnown = fixture({
    id: "phase4a-late-known-result",
    homeSlug: "bournemouth",
    awaySlug: "brentford",
    kickoffUtc: "2026-08-21T20:00:00.000Z",
    retrievedAt: "2026-08-16T05:32:02.136Z",
    certainty: "CONFIRMED",
    status: "FINISHED",
    homeGoals: 1,
    awayGoals: 1,
  });
  const appliedLate = applyVerifiedRatingUpdate({
    fixture: lateKnown,
    appliedAt: "2026-08-23T09:00:00.000Z",
  }).event;
  const futureResult = fixture({
    id: "phase4a-future-result",
    homeSlug: "brighton",
    awaySlug: "everton",
    kickoffUtc: "2026-08-23T14:00:00.000Z",
    retrievedAt: "2026-08-16T05:32:02.136Z",
    certainty: "CONFIRMED",
    status: "FINISHED",
    homeGoals: 3,
    awayGoals: 0,
  });
  const appliedFuture = applyVerifiedRatingUpdate({
    fixture: futureResult,
    appliedAt: "2026-08-23T16:00:00.000Z",
  }).event;
  assert.deepEqual(
    ratingEventsAsOf(t7.plannedAsOf).map((event) => event.eventId),
    [appliedKnown.eventId]
  );

  planPredictionJobs({ fixtures: [rolling], now: "2026-08-20T00:00:00.000Z" });
  const initialJobs = listJobs().filter((job) => job.fixtureId === rolling.id);
  assert.equal(initialJobs.length, 5);
  assert.equal(initialJobs.find((job) => job.stage === "T7D")?.status, "PENDING");
  assert.equal(
    initialJobs.filter((job) => job.stage !== "T7D").every((job) => job.status === "BLOCKED"),
    true
  );
  const firstCreatedAt = getJob(jobIdOf(rolling.id, "T7D", rolling.kickoffUtc!))!.createdAt;
  planPredictionJobs({ fixtures: [rolling], now: "2026-08-21T00:00:00.000Z" });
  assert.equal(
    getJob(jobIdOf(rolling.id, "T7D", rolling.kickoffUtc!))!.createdAt,
    firstCreatedAt
  );

  planPredictionJobs({ fixtures: [rolling], now: t7.plannedAsOf });
  refreshJobStatuses(t7.plannedAsOf);
  const t7Job = getJob(jobIdOf(rolling.id, "T7D", rolling.kickoffUtc!))!;
  assert.equal(t7Job.status, "ELIGIBLE");
  assert.equal(t7Job.cutoffFixtureRetrievedAt, rolling.retrievedAt);
  assert.equal(t7Job.cutoffKickoffCertainty, "DEFAULT");
  const firstRun = executeEligibleJobs({ fixtures: [rolling], now: t7.plannedAsOf });
  assert.deepEqual(firstRun, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  const frozen = listSnapshots().find(
    (snapshot) => snapshot.fixtureId === rolling.id && snapshot.predictionStage === "T7D"
  )!;
  assert.ok(frozen);
  assert.equal(frozen.asOf, t7.plannedAsOf);
  assert.equal(frozen.sourceState.computedAt, t7.plannedAsOf);
  assert.equal(frozen.sourceState.fixtureRetrievedAt, rolling.retrievedAt);
  assert.equal(frozen.sourceState.kickoffCertaintyAtFreeze, "DEFAULT");
  assert.deepEqual(frozen.sourceState.ratingEventIds, [appliedKnown.eventId]);
  assert.equal(frozen.sourceState.ratingEventsUsed, 1);
  assert.equal(
    (frozen.sourceState.ratingEventIds as string[]).includes(appliedLate.eventId),
    false
  );
  assert.equal(
    (frozen.sourceState.ratingEventIds as string[]).includes(appliedFuture.eventId),
    false
  );
  assert.ok(Date.parse(String(frozen.sourceState.computedAt)) >= Date.parse(frozen.asOf));
  assert.ok(Date.parse(String(frozen.sourceState.computedAt)) < Date.parse(rolling.kickoffUtc!));

  const snapshotsBeforeRetry = fs.readFileSync(process.env.SNAPSHOT_STORE_PATH!, "utf8");
  const retryAt = new Date(Date.parse(t7.plannedAsOf) + 5 * 60_000).toISOString();
  planPredictionJobs({ fixtures: [rolling], now: retryAt });
  refreshJobStatuses(retryAt);
  const retry = executeEligibleJobs({ fixtures: [rolling], now: retryAt });
  assert.equal(retry.attempted, 0);
  assert.equal(listSnapshots().filter((snapshot) => snapshot.fixtureId === rolling.id).length, 1);
  assert.equal(fs.readFileSync(process.env.SNAPSHOT_STORE_PATH!, "utf8"), snapshotsBeforeRetry);

  // If the job ledger is lost after the immutable snapshot/archive write, the
  // planner repairs status from that exact identity instead of backfilling.
  clearJobsForTests();
  planPredictionJobs({ fixtures: [rolling], now: retryAt });
  const recoveredJob = getJob(jobIdOf(rolling.id, "T7D", rolling.kickoffUtc!))!;
  assert.equal(recoveredJob.status, "SUCCEEDED");
  assert.equal(recoveredJob.snapshotKey, frozen.provenance.uniqueKey);
  assert.equal(listSnapshots().filter((snapshot) => snapshot.fixtureId === rolling.id).length, 1);

  const immutableBytes = fs.readFileSync(process.env.SNAPSHOT_STORE_PATH!, "utf8");
  const sameKey = createSnapshot({
    fixtureId: frozen.fixtureId,
    competition: frozen.competition,
    season: frozen.season,
    asOf: frozen.asOf,
    kickoff: frozen.kickoff,
    modelVersion: frozen.modelVersion,
    predictionStage: frozen.predictionStage,
    evaluationClass: frozen.evaluationClass,
    homeSlug: frozen.homeSlug,
    awaySlug: frozen.awaySlug,
    home: 0.01,
    draw: 0.01,
    away: 0.98,
    homeExpectedGoals: 0.1,
    awayExpectedGoals: 5,
    scorelineDistribution: {},
  });
  assert.equal(sameKey.homeProbability, frozen.homeProbability);
  assert.equal(fs.readFileSync(process.env.SNAPSHOT_STORE_PATH!, "utf8"), immutableBytes);
  assert.throws(() =>
    freezeScheduledStage(
      rolling,
      "T7D",
      t7.plannedAsOf,
      new Date(Date.parse(t7.plannedAsOf) - 1).toISOString()
    )
  );

  const lateFirst = fixture({
    id: "phase4a-first-seen-late",
    homeSlug: "liverpool",
    awaySlug: "leeds",
    kickoffUtc: "2026-09-05T19:00:00.000Z",
    retrievedAt: "2026-08-16T05:32:02.136Z",
  });
  const lateFirstWindow = windowFor("T7D", lateFirst.kickoffUtc!);
  const lateFirstNow = new Date(Date.parse(lateFirstWindow.plannedAsOf) + 5 * 60_000).toISOString();
  planPredictionJobs({ fixtures: [lateFirst], now: lateFirstNow });
  const missedT7 = getJob(jobIdOf(lateFirst.id, "T7D", lateFirst.kickoffUtc!))!;
  assert.equal(missedT7.status, "MISSED");
  assert.match(missedT7.failureReason ?? "", /cutoff passed before job was planned/);
  assert.equal(listSnapshots().some((snapshot) => snapshot.fixtureId === lateFirst.id), false);

  const graceFixture = fixture({
    id: "phase4a-grace-evidence",
    homeSlug: "tottenham",
    awaySlug: "fulham",
    kickoffUtc: "2026-09-12T19:00:00.000Z",
    retrievedAt: "2026-08-20T00:00:00.000Z",
  });
  const graceWindow = windowFor("T7D", graceFixture.kickoffUtc!);
  planPredictionJobs({ fixtures: [graceFixture], now: "2026-09-01T00:00:00.000Z" });
  const refreshedAfterCutoff: Fixture = {
    ...graceFixture,
    kickoffCertainty: "CONFIRMED",
    retrievedAt: new Date(Date.parse(graceWindow.plannedAsOf) + 60_000).toISOString(),
  };
  const graceNow = new Date(Date.parse(graceWindow.plannedAsOf) + 5 * 60_000).toISOString();
  planPredictionJobs({ fixtures: [refreshedAfterCutoff], now: graceNow });
  refreshJobStatuses(graceNow);
  const graceJob = getJob(jobIdOf(graceFixture.id, "T7D", graceFixture.kickoffUtc!))!;
  assert.equal(graceJob.status, "ELIGIBLE");
  assert.equal(graceJob.cutoffFixtureRetrievedAt, graceFixture.retrievedAt);
  assert.equal(graceJob.cutoffKickoffCertainty, "DEFAULT");
  assert.equal(executeEligibleJobs({ fixtures: [refreshedAfterCutoff], now: graceNow }).succeeded, 1);
  const graceSnapshot = listSnapshots().find((snapshot) => snapshot.fixtureId === graceFixture.id)!;
  assert.equal(graceSnapshot.sourceState.fixtureRetrievedAt, graceFixture.retrievedAt);
  assert.equal(graceSnapshot.sourceState.kickoffCertaintyAtFreeze, "DEFAULT");

  const lateConfirmation = fixture({
    id: "phase4a-late-confirmation",
    homeSlug: "newcastle",
    awaySlug: "sunderland",
    kickoffUtc: "2026-09-20T19:00:00.000Z",
    retrievedAt: "2026-08-20T00:00:00.000Z",
  });
  planPredictionJobs({ fixtures: [lateConfirmation], now: "2026-09-10T00:00:00.000Z" });
  const t24 = windowFor("T24H", lateConfirmation.kickoffUtc!);
  const confirmedTooLate: Fixture = {
    ...lateConfirmation,
    kickoffCertainty: "CONFIRMED",
    retrievedAt: new Date(Date.parse(t24.plannedAsOf) + 60_000).toISOString(),
  };
  const t24LateNow = new Date(Date.parse(t24.plannedAsOf) + 5 * 60_000).toISOString();
  planPredictionJobs({ fixtures: [confirmedTooLate], now: t24LateNow });
  const missedT24 = getJob(
    jobIdOf(lateConfirmation.id, "T24H", lateConfirmation.kickoffUtc!)
  )!;
  assert.equal(missedT24.status, "MISSED");
  assert.match(missedT24.failureReason ?? "", /no cutoff-admissible fixture evidence/);

  // A legacy cancellation at the same kickoff must not remain terminal after
  // fixture certainty becomes CONFIRMED. Replanning is idempotent and does not
  // create a second job identity.
  const sameKickoffConfirmation = fixture({
    id: "phase4a-same-kickoff-confirmation",
    homeSlug: "chelsea",
    awaySlug: "west-ham",
    kickoffUtc: "2026-10-10T15:00:00.000Z",
    retrievedAt: "2026-09-25T00:00:00.000Z",
  });
  planPredictionJobs({
    fixtures: [sameKickoffConfirmation],
    now: "2026-09-30T00:00:00.000Z",
  });
  const sameKickoffT24Id = jobIdOf(
    sameKickoffConfirmation.id,
    "T24H",
    sameKickoffConfirmation.kickoffUtc!
  );
  updateJob(sameKickoffT24Id, {
    status: "CANCELLED",
    blockedReason: "legacy cancellation while kickoff certainty was DEFAULT",
    updatedAt: "2026-09-30T00:01:00.000Z",
  });
  const confirmedSameKickoff: Fixture = {
    ...sameKickoffConfirmation,
    kickoffCertainty: "CONFIRMED",
    retrievedAt: "2026-10-07T00:00:00.000Z",
  };
  planPredictionJobs({
    fixtures: [confirmedSameKickoff],
    now: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(getJob(sameKickoffT24Id)?.status, "PENDING");
  assert.equal(getJob(sameKickoffT24Id)?.blockedReason, null);
  planPredictionJobs({
    fixtures: [confirmedSameKickoff],
    now: "2026-10-08T00:05:00.000Z",
  });
  assert.equal(
    listJobs().filter((job) => job.jobId === sameKickoffT24Id).length,
    1
  );

  const selectionFixture = fixture({
    id: "phase4a-rescheduled-selection",
    homeSlug: rolling.homeSlug,
    awaySlug: rolling.awaySlug,
    kickoffUtc: "2026-10-01T19:00:00.000Z",
    retrievedAt: "2026-09-19T00:00:00.000Z",
    certainty: "CONFIRMED",
  });
  const currentSnapshot = cloneSnapshot(frozen, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "PRESEASON",
    asOf: "2026-09-20T12:00:00.000Z",
    sourceState: { computedAt: "2026-09-20T12:00:00.000Z" },
  });
  const obsoleteNewer = cloneSnapshot(frozen, {
    fixtureId: selectionFixture.id,
    kickoff: "2026-10-03T19:00:00.000Z",
    predictionStage: "T7D",
    asOf: "2026-09-26T19:00:00.000Z",
    sourceState: { computedAt: "2026-09-26T19:05:00.000Z" },
  });
  const shadow = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T24H",
    asOf: "2026-09-30T19:00:00.000Z",
    modelVersion: SHADOW_MODEL_VERSION,
  });
  const reconstruction = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T24H",
    asOf: "2026-09-30T18:00:00.000Z",
    evaluationClass: "RETROSPECTIVE",
  });
  const generatedAfterKickoff = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T24H",
    asOf: "2026-09-30T19:00:00.000Z",
    sourceState: { computedAt: "2026-10-01T19:01:00.000Z" },
  });
  const futureAtRender = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T24H",
    asOf: "2026-09-30T19:00:00.000Z",
    sourceState: { computedAt: "2026-09-30T19:05:00.000Z", origin: "scheduled" },
  });
  const malformedLaterTimed = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T24H",
    // One minute before the canonical T24H cutoff: auditable history, but not
    // a valid T24H snapshot and therefore never eligible for current selection.
    asOf: "2026-09-30T18:59:00.000Z",
    sourceState: { computedAt: "2026-09-30T19:01:00.000Z", origin: "scheduled" },
  });
  const postCutoffInputLater = cloneSnapshot(obsoleteNewer, {
    fixtureId: selectionFixture.id,
    kickoff: selectionFixture.kickoffUtc!,
    predictionStage: "T2H",
    asOf: "2026-10-01T17:00:00.000Z",
    sourceState: {
      computedAt: "2026-10-01T17:05:00.000Z",
      origin: "scheduled",
      latestRatingEventAppliedAt: "2026-10-01T17:01:00.000Z",
    },
  });
  assert.equal(
    selectProductionSnapshot(
      selectionFixture,
      [currentSnapshot, malformedLaterTimed, postCutoffInputLater],
      new Date("2026-10-01T17:30:00.000Z")
    ).provenance.uniqueKey,
    currentSnapshot.provenance.uniqueKey,
    "a malformed timed row or post-cutoff input must not displace the latest valid production snapshot"
  );
  const candidates = [
    obsoleteNewer,
    shadow,
    generatedAfterKickoff,
    futureAtRender,
    reconstruction,
    currentSnapshot,
  ];
  assert.equal(
    selectProductionSnapshot(
      selectionFixture,
      candidates,
      new Date("2026-09-27T00:00:00.000Z")
    ).provenance.uniqueKey,
    currentSnapshot.provenance.uniqueKey
  );
  assert.equal(productionSnapshotsForMatch(selectionFixture.id, candidates).length, 4);
  const timeline = forecastTimeline(
    selectionFixture,
    candidates,
    new Date("2026-09-27T00:00:00.000Z")
  );
  assert.equal(timeline.length, 2);
  assert.equal(timeline.some((point) => point.forecastId === futureAtRender.provenance.uniqueKey), false);
  assert.equal(timeline.some((point) => point.validForCurrentKickoff === false), true);
  assert.equal(
    timeline.find((point) => point.forecastId === obsoleteNewer.provenance.uniqueKey)?.kickoffAtFreeze,
    obsoleteNewer.kickoff
  );
  const currentForecast = buildMatchForecast(selectionFixture, currentSnapshot);
  assert.equal(currentForecast.generatedAt, currentForecast.provenance.generatedAt);
  assert.ok(Date.parse(currentForecast.generatedAt) >= Date.parse(currentForecast.cutoffAt));
  assert.ok(Date.parse(currentForecast.generatedAt) < Date.parse(currentForecast.kickoffUtc));

  assert.equal(sha256(TAPE), TAPE_SHA);
  assert.equal(fs.readFileSync(TAPE, "utf8").trim().split("\n").length, 380);
  console.log("Phase 4A rolling gates: passed");
}

main();
