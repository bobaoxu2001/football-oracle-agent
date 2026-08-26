/** Phase 4A.2 canonical production freshness regression gates. */
import assert from "node:assert/strict";
import {
  buildProductionFreshnessReport,
  evaluateFixtureForecastFreshness,
  evaluateFixtureSyncFreshness,
  evaluateMarketObserverFreshness,
  evaluateSchedulerFreshness,
  type ForecastFreshnessSnapshotInput,
} from "@/lib/competitions/premier-league/ops/production-freshness";
import { effectiveSnapshotLatestIncludedInputAt } from "@/lib/snapshots/types";

const FIXTURE_ID = "phase4a2-freshness-fixture";
const KICKOFF = "2026-09-10T12:00:00.000Z";
const MODEL_VERSION = "pl-live-v0.2.0";

const BASELINE: ForecastFreshnessSnapshotInput = {
  snapshotId: "baseline",
  fixtureId: FIXTURE_ID,
  modelRole: "production",
  modelVersion: MODEL_VERSION,
  evaluationClass: "LIVE_OOS",
  predictionStage: "EARLY",
  kickoffUtc: KICKOFF,
  cutoffAt: "2026-08-20T00:00:00.000Z",
  generatedAt: "2026-08-20T00:01:00.000Z",
};

const T7D: ForecastFreshnessSnapshotInput = {
  ...BASELINE,
  snapshotId: "t7d",
  predictionStage: "T7D",
  cutoffAt: "2026-09-03T12:00:00.000Z",
  generatedAt: "2026-09-03T12:05:00.000Z",
  latestIncludedInputAt: "2026-09-03T10:00:00.000Z",
};

const T24H: ForecastFreshnessSnapshotInput = {
  ...BASELINE,
  snapshotId: "t24h",
  predictionStage: "T24H",
  cutoffAt: "2026-09-09T12:00:00.000Z",
  generatedAt: "2026-09-09T12:05:00.000Z",
  latestIncludedInputAt: "2026-09-09T11:45:00.000Z",
};

function fixtureFreshness(
  evaluatedAt: string,
  snapshots: readonly ForecastFreshnessSnapshotInput[]
) {
  return evaluateFixtureForecastFreshness({
    fixtureId: FIXTURE_ID,
    kickoffUtc: KICKOFF,
    evaluatedAt,
    expectedModelVersion: MODEL_VERSION,
    snapshots,
  });
}

function main(): void {
  assert.equal(
    effectiveSnapshotLatestIncludedInputAt({
      sourceState: {
        ratingStateAsOf: "2026-09-01T00:00:00.000Z",
        latestEvidenceKickoff: "2026-08-31T19:00:00.000Z",
      },
    }),
    null,
    "policy cutoffs and event times must not masquerade as input availability"
  );
  assert.equal(
    effectiveSnapshotLatestIncludedInputAt({
      sourceState: {
        latestRatingEventAppliedAt: "2026-08-30T20:00:00.000Z",
        fixtureRetrievedAt: "2026-08-31T10:00:00.000Z",
        latestEvidenceObservedAt: "2026-08-31T09:00:00.000Z",
      },
    }),
    "2026-08-31T10:00:00.000Z"
  );

  // Age is diagnostic only. A baseline remains current until T7D opens.
  const oldBaseline = fixtureFreshness("2026-09-01T12:00:00.000Z", [BASELINE]);
  assert.equal(oldBaseline.status, "CURRENT_BASELINE");
  assert.equal(oldBaseline.meetsStagePolicy, true);
  assert.equal(oldBaseline.latestRequiredStage, null);
  assert.equal(oldBaseline.nextStage, "T7D");
  assert.ok((oldBaseline.cutoffAgeHours ?? 0) > 72);
  assert.ok((oldBaseline.selectedSnapshot?.cutoffAgeHours ?? 0) > 72);

  // A successful T7D stays current until T24H opens, even after >72 hours.
  const oldT7d = fixtureFreshness("2026-09-07T12:00:00.000Z", [BASELINE, T7D]);
  assert.equal(oldT7d.status, "CURRENT_STAGE");
  assert.equal(oldT7d.selectedStage, "T7D");
  assert.equal(oldT7d.latestRequiredStage, "T7D");
  assert.equal(oldT7d.cutoffAgeHours, 96);
  assert.equal(oldT7d.selectedSnapshot?.cutoffAgeHours, 96);
  assert.equal(oldT7d.meetsStagePolicy, true);

  // A legacy EARLY forecast remains the selectable evidence while T7D is due
  // and after T7D is visibly missed; stage freshness is reported separately.
  const legacyDuringT7d = fixtureFreshness("2026-09-03T12:30:00.000Z", [
    BASELINE,
  ]);
  assert.equal(legacyDuringT7d.status, "UPDATE_DUE");
  assert.equal(legacyDuringT7d.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(legacyDuringT7d.selectedStage, "EARLY");
  assert.equal(legacyDuringT7d.activeDueStage, "T7D");

  const legacyAfterT7d = fixtureFreshness("2026-09-03T14:00:00.001Z", [
    BASELINE,
  ]);
  assert.equal(legacyAfterT7d.status, "MISSED_STAGE");
  assert.equal(legacyAfterT7d.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(legacyAfterT7d.selectedStage, "EARLY");
  assert.deepEqual(legacyAfterT7d.missedStages, ["T7D"]);
  assert.equal(legacyAfterT7d.meetsStagePolicy, false);

  // A missing snapshot is due while its deterministic window is open.
  const updateDue = fixtureFreshness("2026-09-09T12:30:00.000Z", [BASELINE, T7D]);
  assert.equal(updateDue.status, "UPDATE_DUE");
  assert.equal(updateDue.activeDueStage, "T24H");
  assert.equal(updateDue.latestRequiredStage, "T24H");
  assert.equal(updateDue.meetsStagePolicy, false);
  assert.equal(
    updateDue.stages.find((stage) => stage.stage === "T24H")?.state,
    "DUE"
  );

  // Once the window closes, the absent stage remains visibly missed.
  const missed = fixtureFreshness("2026-09-09T14:00:00.001Z", [BASELINE, T7D]);
  assert.equal(missed.status, "MISSED_STAGE");
  assert.deepEqual(missed.missedStages, ["T24H"]);
  assert.equal(missed.activeDueStage, null);

  // A later successful stage restores current status without erasing history.
  const recovered = fixtureFreshness("2026-09-09T14:00:00.001Z", [BASELINE, T24H]);
  assert.equal(recovered.status, "CURRENT_STAGE");
  assert.equal(recovered.selectedStage, "T24H");
  assert.deepEqual(recovered.missedStages, ["T7D"]);
  assert.equal(recovered.meetsStagePolicy, true);

  // Invalid current-production timestamps fail closed.
  const malformed = fixtureFreshness("2026-09-01T12:00:00.000Z", [
    { ...BASELINE, snapshotId: "malformed", cutoffAt: "not-a-timestamp" },
  ]);
  assert.equal(malformed.status, "INVALID");
  assert.equal(malformed.selectedSnapshot, null);
  assert.ok(malformed.invalidSnapshots[0]?.issues.includes("SNAPSHOT_CUTOFF_INVALID"));

  const malformedTimed = fixtureFreshness("2026-09-07T12:00:00.000Z", [
    BASELINE,
    { ...T7D, snapshotId: "malformed-t7d", cutoffAt: "not-a-timestamp" },
  ]);
  assert.equal(malformedTimed.status, "INVALID");
  assert.equal(malformedTimed.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(malformedTimed.selectedStage, "EARLY");
  assert.ok(
    malformedTimed.invalidSnapshots.find(
      (snapshot) => snapshot.snapshotId === "malformed-t7d"
    )?.issues.includes("SNAPSHOT_CUTOFF_INVALID")
  );
  assert.equal(
    malformedTimed.stages.find((stage) => stage.stage === "T7D")?.state,
    "MISSED"
  );

  const futureGenerated = fixtureFreshness("2026-09-03T12:01:00.000Z", [
    BASELINE,
    T7D,
  ]);
  assert.equal(futureGenerated.status, "INVALID");
  assert.equal(futureGenerated.selectedSnapshot?.snapshotId, "baseline");
  assert.ok(
    futureGenerated.invalidSnapshots[0]?.issues.includes(
      "SNAPSHOT_GENERATED_AT_IN_FUTURE"
    )
  );

  const inputAfterCutoff = fixtureFreshness("2026-09-07T12:00:00.000Z", [
    BASELINE,
    {
      ...T7D,
      snapshotId: "future-input",
      latestIncludedInputAt: "2026-09-03T12:00:00.001Z",
    },
  ]);
  assert.equal(inputAfterCutoff.status, "INVALID");
  assert.equal(inputAfterCutoff.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(inputAfterCutoff.latestIncludedInputAt, null);
  assert.equal(inputAfterCutoff.selectedStage, "EARLY");
  assert.ok(
    inputAfterCutoff.invalidSnapshots.find(
      (snapshot) => snapshot.snapshotId === "future-input"
    )?.issues.includes("LATEST_INCLUDED_INPUT_AFTER_CUTOFF")
  );

  // An obsolete kickoff is isolated before validation and cannot win selection.
  const obsoleteKickoff = fixtureFreshness("2026-09-01T12:00:00.000Z", [
    BASELINE,
    {
      ...T7D,
      snapshotId: "obsolete-kickoff",
      kickoffUtc: "2026-09-11T12:00:00.000Z",
      cutoffAt: "not-a-timestamp",
    },
  ]);
  assert.equal(obsoleteKickoff.status, "CURRENT_BASELINE");
  assert.equal(obsoleteKickoff.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(obsoleteKickoff.ignoredSnapshots.obsoleteKickoff, 1);
  assert.equal(obsoleteKickoff.invalidSnapshots.length, 0);

  // Shadow and reconstruction rows never satisfy the production stage.
  const isolatedTracks = fixtureFreshness("2026-09-09T12:30:00.000Z", [
    BASELINE,
    { ...T24H, snapshotId: "shadow-t24h", modelRole: "shadow" },
    {
      ...T24H,
      snapshotId: "reconstruction-t24h",
      modelRole: "reconstruction",
    },
  ]);
  assert.equal(isolatedTracks.status, "UPDATE_DUE");
  assert.equal(isolatedTracks.selectedSnapshot?.snapshotId, "baseline");
  assert.equal(isolatedTracks.ignoredSnapshots.nonProductionRole, 2);

  // latestIncludedInputAt remains unavailable unless it was actually recorded.
  assert.equal(oldBaseline.selectedSnapshot?.latestIncludedInputAt, null);
  assert.equal(oldBaseline.latestIncludedInputAt, null);
  assert.equal(oldBaseline.latestIncludedInputStatus, "UNAVAILABLE");
  assert.equal(
    oldBaseline.selectedSnapshot?.latestIncludedInputStatus,
    "UNAVAILABLE"
  );
  const recordedInput = fixtureFreshness("2026-09-01T12:00:00.000Z", [
    {
      ...BASELINE,
      snapshotId: "recorded-input",
      latestIncludedInputAt: "2026-08-19T22:00:00.000Z",
    },
  ]);
  assert.equal(
    recordedInput.selectedSnapshot?.latestIncludedInputAt,
    "2026-08-19T22:00:00.000Z"
  );
  assert.equal(recordedInput.latestIncludedInputAt, "2026-08-19T22:00:00.000Z");
  assert.notEqual(
    recordedInput.selectedSnapshot?.latestIncludedInputAt,
    recordedInput.selectedSnapshot?.cutoffAt
  );

  const observerNow = "2026-09-01T12:00:00.000Z";
  const schedulerFresh = evaluateSchedulerFreshness({
    evaluatedAt: observerNow,
    lastAttemptAt: "2026-09-01T11:55:00.000Z",
    lastSuccessAt: "2026-09-01T11:55:00.000Z",
    cadenceMs: 5 * 60_000,
  });
  assert.equal(schedulerFresh.scope, "scheduler");
  assert.equal(schedulerFresh.status, "FRESH");
  const schedulerStale = evaluateSchedulerFreshness({
    evaluatedAt: observerNow,
    lastAttemptAt: "2026-09-01T11:40:00.000Z",
    lastSuccessAt: "2026-09-01T11:40:00.000Z",
    cadenceMs: 5 * 60_000,
  });
  assert.equal(schedulerStale.status, "STALE");
  assert.ok(schedulerStale.reasonCodes.includes("LAST_ATTEMPT_STALE"));
  assert.equal(
    evaluateSchedulerFreshness({
      evaluatedAt: observerNow,
      lastAttemptAt: null,
      lastSuccessAt: null,
      cadenceMs: 5 * 60_000,
    }).status,
    "NEVER"
  );
  assert.equal(
    evaluateSchedulerFreshness({
      evaluatedAt: observerNow,
      lastAttemptAt: "2026-09-01T11:55:00.000Z",
      lastSuccessAt: "2026-09-01T11:55:00.000Z",
      cadenceMs: 5 * 60_000,
      lastError: "tick failed",
    }).status,
    "ERROR"
  );

  const nearMatchSync = evaluateFixtureSyncFreshness({
    evaluatedAt: observerNow,
    lastAttemptAt: "2026-09-01T05:00:00.000Z",
    lastSuccessAt: "2026-09-01T05:00:00.000Z",
    cadenceMs: 5 * 60_000,
    nearMatch: true,
  });
  const farMatchSync = evaluateFixtureSyncFreshness({
    evaluatedAt: observerNow,
    lastAttemptAt: "2026-09-01T05:00:00.000Z",
    lastSuccessAt: "2026-09-01T05:00:00.000Z",
    cadenceMs: 5 * 60_000,
    nearMatch: false,
  });
  assert.equal(nearMatchSync.scope, "fixtureSync");
  assert.equal(nearMatchSync.status, "STALE");
  assert.equal(nearMatchSync.staleAfterMs, 6 * 3_600_000);
  assert.equal(farMatchSync.status, "FRESH");
  assert.equal(farMatchSync.staleAfterMs, 36 * 3_600_000);

  // Market observer state is injected and explicitly non-causal.
  const market = evaluateMarketObserverFreshness({
    evaluatedAt: observerNow,
    configured: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    staleAfterMs: 12 * 3_600_000,
    cadenceMs: 6 * 3_600_000,
  });
  assert.equal(market.status, "UNCONFIGURED");
  assert.deepEqual(market.reasonCodes, ["MARKET_OBSERVER_UNCONFIGURED"]);
  assert.equal(market.affectsProductionForecast, false);

  // The canonical report applies one evaluation instant to every scope.
  const report = buildProductionFreshnessReport({
    evaluatedAt: observerNow,
    sourceRevision: "test-revision",
    fixtures: [
      {
        fixtureId: FIXTURE_ID,
        kickoffUtc: KICKOFF,
        expectedModelVersion: MODEL_VERSION,
        snapshots: [BASELINE],
      },
    ],
    scheduler: {
      lastAttemptAt: "2026-09-01T11:55:00.000Z",
      lastSuccessAt: "2026-09-01T11:55:00.000Z",
      cadenceMs: 5 * 60_000,
    },
    fixtureSync: {
      lastAttemptAt: "2026-09-01T11:55:00.000Z",
      lastSuccessAt: "2026-09-01T11:55:00.000Z",
      cadenceMs: 5 * 60_000,
      nearMatch: false,
    },
    marketObserver: {
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      staleAfterMs: 12 * 3_600_000,
      cadenceMs: 6 * 3_600_000,
    },
  });
  assert.equal(report.evaluatedAt, observerNow);
  assert.equal(report.scheduler.evaluatedAt, observerNow);
  assert.equal(report.fixtureSync.evaluatedAt, observerNow);
  assert.equal(report.fixtures[0]?.evaluatedAt, observerNow);
  assert.equal(report.forecastCoverage.status, "CURRENT");
  assert.equal(report.marketObserver.affectsProductionForecast, false);

  console.log("Phase 4A.2 production freshness gates passed.");
}

main();
