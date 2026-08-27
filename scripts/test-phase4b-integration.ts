/** Phase 4B production-reference, Agent, comparison, and isolation gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foa-phase4b-integration-"));
  const ops = path.join(root, "ops");
  const workingSnapshots = path.join(ops, "working-snapshots.jsonl");
  const operationalArchive = path.join(ops, "live-oos-operational.jsonl");
  const contextStore = path.join(ops, "match-context-snapshots.jsonl");
  process.env.PL_OPS_BACKEND = "file";
  process.env.PL_OPS_DIR = ops;
  process.env.SNAPSHOT_STORE_PATH = workingSnapshots;
  process.env.SETTLEMENT_STORE_PATH = path.join(ops, "settlements.jsonl");
  process.env.PL_OPERATIONAL_LIVE_OOS_PATH = operationalArchive;
  process.env.LIVE_OOS_ARCHIVE_PATH = operationalArchive;
  process.env.PL_CONTEXT_SNAPSHOT_PATH = contextStore;
  process.env.PL_PROVENANCE_DIR = path.join(ops, "provenance");
  process.env.APPLICATION_COMMIT_SHA = "b".repeat(40);
  process.env.MATCH_AGENT_LLM_ENABLED = "0";

  const [
    { liveFixtures },
    scheduler,
    contextOps,
    snapshots,
    snapshotStore,
    archive,
    engine,
    service,
    agent,
    model,
    jobs,
    provenance,
    sealedSnapshot,
  ] =
    await Promise.all([
      import("@/lib/competitions/premier-league/fixture-store"),
      import("@/lib/competitions/premier-league/ops/scheduler"),
      import("@/lib/competitions/premier-league/ops/context-snapshots"),
      import("@/lib/snapshots/types"),
      import("@/lib/snapshots/store"),
      import("@/lib/competitions/premier-league/ops/operational-archive"),
      import("@/lib/prediction-engine/league-engine"),
      import("@/lib/match-forecast/service"),
      import("@/lib/match-forecast/agent"),
      import("@/lib/competitions/premier-league/model-tracks"),
      import("@/lib/competitions/premier-league/ops/job-ledger"),
      import("@/lib/competitions/premier-league/provenance/production"),
      import("@/lib/prediction-engine/sealed-snapshot"),
    ]);

  const fixture = liveFixtures().find((item) => item.id === "pl-2026-27-arsenal-chelsea");
  assert.ok(fixture?.kickoffUtc, "acceptance fixture must exist with a kickoff");
  const kickoff = fixture.kickoffUtc;
  const t7Cutoff = "2026-08-30T15:30:00.000Z";
  const t7Generated = "2026-08-30T15:30:05.000Z";
  provenance.captureProspectiveProductionEvidence({
    fixtures: [fixture],
    observations: [],
    capturedAt: "2026-08-20T00:00:00.000Z",
  });

  const t7 = scheduler.freezeScheduledStage(fixture, "T7D", t7Cutoff, t7Generated);
  const t7ContextId = String(t7.sourceState.contextSnapshotId ?? "");
  assert.match(t7ContextId, /^pl-match-context-v1:sha256:[a-f0-9]{64}$/);
  const t7Context = contextOps.getFrozenMatchContext(t7ContextId);
  assert.ok(t7Context);
  assert.equal(t7Context.cutoffAt, t7.asOf);
  assert.equal(t7Context.kickoffAt, t7.kickoff);
  assert.equal(t7Context.forecastSnapshotKey, t7.provenance.uniqueKey);
  assert.equal(t7Context.evidence.length, 0);
  assert.deepEqual(t7Context.usedInForecastEvidenceIds, []);

  // Repeating the same scheduled stage is byte-idempotent across forecast,
  // context, and operational archive files.
  const contextBytes = fs.readFileSync(contextStore, "utf8");
  const archiveBytes = fs.readFileSync(operationalArchive, "utf8");
  const retry = scheduler.freezeScheduledStage(fixture, "T7D", t7Cutoff, t7Generated);
  assert.equal(retry.provenance.uniqueKey, t7.provenance.uniqueKey);
  assert.equal(fs.readFileSync(contextStore, "utf8"), contextBytes);
  assert.equal(fs.readFileSync(operationalArchive, "utf8"), archiveBytes);

  // A pre-Phase-4B first-write row must fail before a new context is frozen or
  // the incompatible forecast is promoted to the operational archive.
  const collisionFixture = liveFixtures().find(
    (item) => item.id === "pl-2026-27-aston-villa-arsenal"
  );
  assert.ok(collisionFixture?.kickoffUtc);
  const collisionCutoff = new Date(Date.parse(collisionFixture.kickoffUtc) - 7 * 86_400_000).toISOString();
  const collisionGenerated = new Date(Date.parse(collisionCutoff) + 5_000).toISOString();
  const contextBeforeCollision = fs.readFileSync(contextStore, "utf8");
  provenance.captureProspectiveProductionEvidence({
    fixtures: [collisionFixture],
    observations: [],
    capturedAt: "2026-08-20T00:00:00.000Z",
  });
  const contextlessManualFirstWrite = engine.snapshotPremierLeagueMatch(
    collisionFixture.homeSlug,
    collisionFixture.awaySlug,
    {
      asOf: collisionCutoff,
      kickoff: collisionFixture.kickoffUtc,
      fixtureId: collisionFixture.id,
      season: collisionFixture.season,
      predictionStage: "T7D",
      evaluationClass: "LIVE_OOS",
      origin: "manual",
      computedAt: collisionGenerated,
      fixtureDataVersion: collisionFixture.sourceId ?? null,
      kickoffCertaintyAtFreeze: collisionFixture.kickoffCertainty ?? null,
      fixtureRetrievedAt: collisionFixture.retrievedAt ?? null,
    }
  );
  // Manufacture the exact immutable shape of a pre-4A.3 scheduled row. New
  // scheduled writes cannot omit a PIT manifest; this archived clone exists
  // only to prove that the scheduler fails closed on legacy evidence.
  const contextlessFirstWrite = structuredClone(contextlessManualFirstWrite);
  contextlessFirstWrite.sourceState.origin = "scheduled";
  assert.equal(contextlessFirstWrite.sourceState.contextSnapshotId, null);
  archive.archiveOperationalLiveOos([contextlessFirstWrite]);
  const archiveWithLegacyCollision = fs.readFileSync(operationalArchive, "utf8");

  scheduler.planPredictionJobs({ fixtures: [collisionFixture], now: collisionCutoff });
  const collisionJobId = jobs.jobIdOf(
    collisionFixture.id,
    "T7D",
    collisionFixture.kickoffUtc
  );
  const plannedCollision = jobs.getJob(collisionJobId);
  assert.equal(plannedCollision?.status, "FAILED");
  assert.match(plannedCollision?.failureReason ?? "", /not bound to an exact, available context/);
  const collisionExecution = scheduler.executeEligibleJobs({
    fixtures: [collisionFixture],
    now: collisionCutoff,
  });
  assert.deepEqual(collisionExecution, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  assert.equal(jobs.getJob(collisionJobId)?.status, "FAILED");
  assert.equal(jobs.getJob(collisionJobId)?.snapshotKey, null);
  assert.throws(
    () => scheduler.freezeScheduledStage(
      collisionFixture,
      "T7D",
      collisionCutoff,
      collisionGenerated
    ),
    /existing first-write forecast is not bound to an exact, available context snapshot/
  );
  assert.equal(fs.readFileSync(contextStore, "utf8"), contextBeforeCollision);
  assert.equal(fs.readFileSync(operationalArchive, "utf8"), archiveWithLegacyCollision);

  // Even an exact-bound first write must fail closed when it claims the
  // unchanged champion consumed contextual evidence. Recovery paths bypass
  // the league engine, so the centralized binding gate must enforce this too.
  const usedCollisionFixture = liveFixtures().find(
    (item) => item.id === "pl-2026-27-crystal-palace-manchester-city"
  );
  assert.ok(usedCollisionFixture?.kickoffUtc);
  const usedCollisionCutoff = new Date(
    Date.parse(usedCollisionFixture.kickoffUtc) - 7 * 86_400_000
  ).toISOString();
  const usedCollisionGenerated = new Date(
    Date.parse(usedCollisionCutoff) + 5_000
  ).toISOString();
  provenance.captureProspectiveProductionEvidence({
    fixtures: [usedCollisionFixture],
    observations: [],
    capturedAt: "2026-08-20T00:00:00.000Z",
  });
  const usedCollisionResolved = provenance.resolveProspectiveForecastInput({
    fixtureId: usedCollisionFixture.id,
    stage: "T7D",
    cutoffAt: usedCollisionCutoff,
    generatedAt: usedCollisionGenerated,
  });
  const usedCollisionKey = snapshots.snapshotUniqueKey({
    competition: "premier-league",
    season: usedCollisionFixture.season,
    fixtureId: usedCollisionFixture.id,
    modelVersion: model.PRODUCTION_MODEL_VERSION,
    predictionStage: "T7D",
    asOf: usedCollisionCutoff,
  });
  const usedCollisionContext = contextOps.freezeMatchContext({
    season: usedCollisionFixture.season,
    fixtureId: usedCollisionFixture.id,
    homeSlug: usedCollisionFixture.homeSlug,
    awaySlug: usedCollisionFixture.awaySlug,
    kickoffAt: usedCollisionFixture.kickoffUtc,
    cutoffAt: usedCollisionCutoff,
    generatedAt: usedCollisionGenerated,
    forecastSnapshotKey: usedCollisionKey,
    evidence: [
      {
        fixtureId: usedCollisionFixture.id,
        kind: "SQUAD_AVAILABILITY",
        entityId: "test-player",
        teamSlug: usedCollisionFixture.homeSlug,
        observedAt: new Date(Date.parse(usedCollisionCutoff) - 3_000).toISOString(),
        fetchedAt: new Date(Date.parse(usedCollisionCutoff) - 2_000).toISOString(),
        availableAt: new Date(Date.parse(usedCollisionCutoff) - 1_000).toISOString(),
        confidence: 1,
        rawEvidenceHash: `sha256:${"c".repeat(64)}`,
        source: { name: "phase4b-test-provider", recordId: "used-collision" },
        payload: { status: "AVAILABLE" },
        availabilityStatus: "AVAILABLE",
        usedInForecast: true,
      },
    ],
  }).snapshot;
  const usedCollisionSnapshot = snapshotStore.createSnapshot({
    fixtureId: usedCollisionFixture.id,
    competition: "premier-league",
    season: usedCollisionFixture.season,
    asOf: usedCollisionCutoff,
    kickoff: usedCollisionFixture.kickoffUtc,
    modelVersion: model.PRODUCTION_MODEL_VERSION,
    predictionStage: "T7D",
    evaluationClass: "LIVE_OOS",
    homeSlug: usedCollisionFixture.homeSlug,
    awaySlug: usedCollisionFixture.awaySlug,
    home: t7.homeProbability,
    draw: t7.drawProbability,
    away: t7.awayProbability,
    homeExpectedGoals: t7.homeGoalExpectation,
    awayExpectedGoals: t7.awayGoalExpectation,
    scorelineDistribution: t7.scorelineDistribution,
    modelParameters: t7.modelParameters,
    sourceState: {
      ...t7.sourceState,
      computedAt: usedCollisionGenerated,
      origin: "scheduled",
      fixtureDataVersion: usedCollisionFixture.sourceId ?? null,
      kickoffCertaintyAtFreeze: usedCollisionFixture.kickoffCertainty ?? null,
      fixtureRetrievedAt: usedCollisionFixture.retrievedAt ?? null,
      ratingStateAsOf: usedCollisionCutoff,
      contextSnapshotId: usedCollisionContext.contextId,
      contextSchemaVersion: usedCollisionContext.schemaVersion,
      contextSnapshotCutoffAt: usedCollisionContext.cutoffAt,
      contextSnapshotGeneratedAt: usedCollisionContext.generatedAt,
      contextTemporalRule: usedCollisionContext.temporalRule,
      contextLineupStatus: usedCollisionContext.lineup.overall,
      contextLineupAvailableAt: null,
      contextEvidenceCount: 1,
      contextModelUsedEvidenceCount: 1,
      contextInformationalEvidenceCount: 0,
      contextUsedInForecastEvidenceIds: usedCollisionContext.usedInForecastEvidenceIds,
    },
    inputManifestId: usedCollisionResolved.manifest.manifestId,
    inputManifest: usedCollisionResolved.manifest,
    inputManifestRecords: usedCollisionResolved.references,
  });
  archive.archiveOperationalLiveOos([usedCollisionSnapshot]);
  const usedCollisionArchiveBytes = fs.readFileSync(operationalArchive, "utf8");
  const usedCollisionContextBytes = fs.readFileSync(contextStore, "utf8");

  jobs.clearJobsForTests();
  scheduler.planPredictionJobs({
    fixtures: [usedCollisionFixture],
    now: usedCollisionCutoff,
  });
  const usedCollisionJobId = jobs.jobIdOf(
    usedCollisionFixture.id,
    "T7D",
    usedCollisionFixture.kickoffUtc
  );
  assert.equal(jobs.getJob(usedCollisionJobId)?.status, "FAILED");
  assert.match(
    jobs.getJob(usedCollisionJobId)?.failureReason ?? "",
    /not bound to an exact, available context/
  );
  const usedCollisionExecution = scheduler.executeEligibleJobs({
    fixtures: [usedCollisionFixture],
    now: usedCollisionCutoff,
  });
  assert.deepEqual(usedCollisionExecution, {
    attempted: 1,
    succeeded: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(jobs.getJob(usedCollisionJobId)?.status, "FAILED");
  assert.throws(
    () =>
      scheduler.freezeScheduledStage(
        usedCollisionFixture,
        "T7D",
        usedCollisionCutoff,
        usedCollisionGenerated
      ),
    /existing first-write forecast is not bound to an exact, available context snapshot/
  );
  assert.equal(fs.readFileSync(operationalArchive, "utf8"), usedCollisionArchiveBytes);
  assert.equal(fs.readFileSync(contextStore, "utf8"), usedCollisionContextBytes);

  const t24Cutoff = "2026-09-05T15:30:00.000Z";
  const t24Generated = "2026-09-05T15:30:05.000Z";
  const t24Key = snapshots.snapshotUniqueKey({
    competition: "premier-league",
    season: fixture.season,
    fixtureId: fixture.id,
    modelVersion: model.PRODUCTION_MODEL_VERSION,
    predictionStage: "T24H",
    asOf: t24Cutoff,
  });
  const t24Context = contextOps.freezeMatchContext({
    season: fixture.season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: kickoff,
    cutoffAt: t24Cutoff,
    generatedAt: t24Generated,
    forecastSnapshotKey: t24Key,
    evidence: [
      {
        fixtureId: fixture.id,
        kind: "SQUAD_AVAILABILITY",
        entityId: "saka",
        teamSlug: fixture.homeSlug,
        observedAt: "2026-09-05T11:58:00.000Z",
        fetchedAt: "2026-09-05T11:59:00.000Z",
        availableAt: "2026-09-05T12:00:00.000Z",
        confidence: 0.9,
        rawEvidenceHash: `sha256:${"a".repeat(64)}`,
        source: {
          name: "phase4b-test-provider",
          recordId: "saka-availability-1",
          url: "https://provider.example/v1/key/path-secret/lineup?token=query-secret#internal",
        },
        payload: { status: "EXPECTED_AVAILABLE" },
        availabilityStatus: "EXPECTED_AVAILABLE",
        usedInForecast: false,
      },
      {
        fixtureId: fixture.id,
        kind: "TEAM_NEWS",
        entityId: fixture.homeSlug,
        teamSlug: fixture.homeSlug,
        observedAt: "2026-09-05T12:00:00.000Z",
        fetchedAt: "2026-09-05T12:00:30.000Z",
        availableAt: "2026-09-05T12:01:00.000Z",
        confidence: 0.8,
        rawEvidenceHash: `sha256:${"d".repeat(64)}`,
        source: {
          name: "phase4b-private-network-test",
          recordId: "ipv6-private-record",
          url: "http://[fd00::1]/v1/key/ipv6-path-secret/news",
        },
        payload: { summary: "Timestamped team update" },
        usedInForecast: false,
      },
    ],
  }).snapshot;
  const t24Resolved = provenance.resolveProspectiveForecastInput({
    fixtureId: fixture.id,
    stage: "T24H",
    cutoffAt: t24Cutoff,
    generatedAt: t24Generated,
  });
  const t24 = sealedSnapshot.snapshotPremierLeagueFromFrozenInputs({
    resolved: t24Resolved,
    contextSnapshot: t24Context,
  });
  archive.archiveOperationalLiveOos([t24]);
  assert.equal(t24.provenance.uniqueKey, t24Key);
  assert.equal(t24.sourceState.contextSnapshotId, t24Context.contextId);
  assert.equal(t24.sourceState.contextModelUsedEvidenceCount, 0);
  assert.equal(t24.sourceState.contextInformationalEvidenceCount, 2);
  assert.equal(t7Context.evidence.some((item) => item.entityId === "saka"), false);

  // Shadow-bound and obsolete-kickoff contexts must not become the production
  // Match Room's latest context, even when their timestamps are later.
  const shadowContext = contextOps.freezeMatchContext({
    season: fixture.season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: kickoff,
    cutoffAt: "2026-09-05T17:00:00.000Z",
    generatedAt: "2026-09-05T17:00:05.000Z",
    forecastSnapshotKey: snapshots.snapshotUniqueKey({
      competition: "premier-league",
      season: fixture.season,
      fixtureId: fixture.id,
      modelVersion: "pl-shadow-phase4b-context-test",
      predictionStage: "T2H",
      asOf: "2026-09-05T17:00:00.000Z",
    }),
    evidence: [],
  }).snapshot;
  const obsoleteKickoffContext = contextOps.freezeMatchContext({
    season: fixture.season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: "2026-09-07T15:30:00.000Z",
    cutoffAt: "2026-09-05T18:00:00.000Z",
    generatedAt: "2026-09-05T18:00:05.000Z",
    forecastSnapshotKey: null,
    evidence: [],
  }).snapshot;

  // Informational context cannot alter champion math.
  const direct = engine.predictPremierLeagueMatch(fixture.homeSlug, fixture.awaySlug, {
    asOf: t24Cutoff,
    kickoff,
    fixtureId: fixture.id,
    season: fixture.season,
  });
  assert.equal(t24.homeProbability, direct.teamAWinProbability);
  assert.equal(t24.drawProbability, direct.drawProbability);
  assert.equal(t24.awayProbability, direct.teamBWinProbability);
  assert.equal(t24.modelVersion, model.PRODUCTION_MODEL_VERSION);

  // The current champion refuses any context claiming numerical use.
  const usedKey = snapshots.snapshotUniqueKey({
    competition: "premier-league",
    season: fixture.season,
    fixtureId: fixture.id,
    modelVersion: model.PRODUCTION_MODEL_VERSION,
    predictionStage: "T60M",
    asOf: "2026-09-06T14:30:00.000Z",
  });
  const usedContext = (await import("@/lib/competitions/premier-league/context")).assembleMatchContext({
    season: fixture.season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: kickoff,
    cutoffAt: "2026-09-06T14:30:00.000Z",
    generatedAt: "2026-09-06T14:30:05.000Z",
    forecastSnapshotKey: usedKey,
    evidence: [
      {
        fixtureId: fixture.id,
        kind: "SQUAD_AVAILABILITY",
        entityId: "saka",
        teamSlug: fixture.homeSlug,
        observedAt: "2026-09-06T14:20:00.000Z",
        fetchedAt: "2026-09-06T14:21:00.000Z",
        availableAt: "2026-09-06T14:22:00.000Z",
        confidence: 1,
        rawEvidenceHash: `sha256:${"b".repeat(64)}`,
        source: { name: "phase4b-test-provider", recordId: "saka-used-claim" },
        payload: { status: "AVAILABLE" },
        availabilityStatus: "AVAILABLE",
        usedInForecast: true,
      },
    ],
  }).snapshot;
  assert.throws(
    () => engine.snapshotPremierLeagueMatch(fixture.homeSlug, fixture.awaySlug, {
      asOf: usedContext.cutoffAt,
      kickoff,
      fixtureId: fixture.id,
      season: fixture.season,
      predictionStage: "T60M",
      evaluationClass: "LIVE_OOS",
      computedAt: usedContext.generatedAt,
      contextSnapshot: usedContext,
    }),
    /cannot claim contextual evidence was used/
  );

  const intelligence = await service.getMatchIntelligence(
    fixture.id,
    new Date("2026-09-05T19:00:00.000Z")
  );
  assert.equal(intelligence.forecast.provenance.immutableForecastId, t24Key);
  assert.equal(intelligence.context.atForecast.contextId, t24Context.contextId);
  assert.equal(intelligence.context.latest.contextId, t24Context.contextId);
  assert.notEqual(intelligence.context.latest.contextId, shadowContext.contextId);
  assert.notEqual(intelligence.context.latest.contextId, obsoleteKickoffContext.contextId);
  assert.equal(intelligence.context.atForecast.evidenceCounts.usedInForecast, 0);
  assert.equal(intelligence.context.atForecast.evidenceCounts.informationalOnly, 2);
  assert.match(intelligence.context.atForecast.evidence[0].source.recordId, /^ref:sha256:[a-f0-9]{24}$/);
  assert.equal(intelligence.context.atForecast.evidence[0].source.url, null);
  assert.equal(intelligence.context.atForecast.evidence[1].source.url, null);
  assert.equal(JSON.stringify(intelligence).includes("path-secret"), false);
  assert.equal(JSON.stringify(intelligence).includes("query-secret"), false);
  assert.equal(JSON.stringify(intelligence).includes("fd00::1"), false);
  assert.equal(JSON.stringify(intelligence).includes("ipv6-path-secret"), false);
  assert.equal(JSON.stringify(intelligence).includes("saka-availability-1"), false);
  assert.equal(intelligence.contextComparison?.status, "COMPARED");
  assert.equal(intelligence.contextComparison?.fromContextId, t7Context.contextId);
  assert.equal(intelligence.contextComparison?.toContextId, t24Context.contextId);
  assert.ok(intelligence.comparison?.contextChanges.some((item) => item.entityId === "saka"));
  assert.equal(intelligence.comparison?.modelVersionChanged, false);
  assert.equal(intelligence.comparison?.cutoffChanged, true);
  const agentNow = new Date("2026-09-05T19:00:00.000Z");

  const moved = await agent.runMatchAgent(
    fixture.id,
    "Why did your Arsenal probability move?",
    agentNow
  );
  assert.equal(moved.answer.includes(intelligence.comparison!.oldForecastId), true);
  assert.equal(moved.answer.includes(intelligence.comparison!.newForecastId), true);
  assert.equal(moved.answer.includes(t7Context.contextId), true);
  assert.equal(moved.answer.includes(t24Context.contextId), true);
  assert.equal(moved.narration.mode, "deterministic-template");

  process.env.MATCH_AGENT_LLM_ENABLED = "1";
  agent.clearMatchAgentCacheForTests();
  const llmEnabledWhy = await agent.runMatchAgent(
    fixture.id,
    "Why does the production model lean this way?",
    agentNow
  );
  assert.equal(llmEnabledWhy.narration.mode, "deterministic-template");
  assert.equal(llmEnabledWhy.narration.provider, null);
  assert.equal(llmEnabledWhy.narration.numericGroundingValidated, true);
  process.env.MATCH_AGENT_LLM_ENABLED = "0";
  agent.clearMatchAgentCacheForTests();

  const availability = await agent.runMatchAgent(fixture.id, "Is Bukayo Saka expected to play?", agentNow);
  assert.match(availability.answer, /EXPECTED_AVAILABLE/);
  assert.deepEqual(availability.numericEvidence, {});
  const available = await agent.runMatchAgent(fixture.id, "Is Bukayo Saka available?", agentNow);
  assert.match(available.answer, /EXPECTED_AVAILABLE/);
  assert.deepEqual(available.numericEvidence, {});
  const out = await agent.runMatchAgent(fixture.id, "Is Bukayo Saka out?", agentNow);
  assert.match(out.answer, /EXPECTED_AVAILABLE/);
  assert.deepEqual(out.numericEvidence, {});
  const known = await agent.runMatchAgent(
    fixture.id,
    "Was Saka's availability known at this forecast cutoff?",
    agentNow
  );
  assert.match(known.answer, /known to Oracle by this forecast cutoff/i);
  const deictic = await agent.runMatchAgent(
    fixture.id,
    "Was that information known when this forecast was made?",
    agentNow
  );
  assert.match(deictic.answer, /does not identify which evidence item/i);
  const used = await agent.runMatchAgent(fixture.id, "Did the model use Saka's availability?", agentNow);
  assert.match(used.answer, /Context evidence used in this forecast: 0/);
  assert.deepEqual(used.numericEvidence, {});
  const scenario = await agent.runMatchAgent(fixture.id, "What if Saka doesn't start?", agentNow);
  assert.match(scenario.answer, /UNSUPPORTED_SCENARIO/);
  assert.equal(/\d+(?:\.\d+)?%/.test(scenario.answer), false);
  assert.deepEqual(scenario.numericEvidence, {});
  const alternateScenario = await agent.runMatchAgent(
    fixture.id,
    "Suppose Saka does not start; how would the probabilities change?",
    agentNow
  );
  assert.match(alternateScenario.answer, /UNSUPPORTED_SCENARIO/);
  assert.equal(/\d+(?:\.\d+)?%/.test(alternateScenario.answer), false);
  assert.deepEqual(alternateScenario.numericEvidence, {});
  const declarativeScenario = await agent.runMatchAgent(
    fixture.id,
    "Saka does not start; how do the probabilities change?",
    agentNow
  );
  assert.match(declarativeScenario.answer, /UNSUPPORTED_SCENARIO/);
  assert.equal(/\d+(?:\.\d+)?%/.test(declarativeScenario.answer), false);
  assert.deepEqual(declarativeScenario.numericEvidence, {});
  const withScenario = await agent.runMatchAgent(
    fixture.id,
    "How would probabilities change with Saka unavailable?",
    agentNow
  );
  assert.match(withScenario.answer, /UNSUPPORTED_SCENARIO/);
  assert.equal(/\d+(?:\.\d+)?%/.test(withScenario.answer), false);
  assert.deepEqual(withScenario.numericEvidence, {});
  const unicodeScenario = await agent.runMatchAgent(
    fixture.id,
    "Suppose Martin Ødegaard does not start; how would the probabilities change?",
    agentNow
  );
  assert.match(unicodeScenario.answer, /UNSUPPORTED_SCENARIO/);
  assert.equal(/\d+(?:\.\d+)?%/.test(unicodeScenario.answer), false);
  assert.deepEqual(unicodeScenario.numericEvidence, {});
  assert.equal(
    agent.contextNarrationMustRemainDeterministic(
      "Explain what changed since the previous forecast"
    ),
    true
  );
  assert.equal(
    agent.contextNarrationMustRemainDeterministic(
      "Explain what if Saka does not start"
    ),
    true
  );
  assert.equal(
    agent.contextNarrationMustRemainDeterministic("Explain: is Saka available?"),
    true
  );
  assert.equal(
    agent.contextNarrationMustRemainDeterministic("Why is Saka doubtful?"),
    true
  );
  assert.equal(
    agent.contextNarrationMustRemainDeterministic(
      "Why does the production model favor Arsenal?"
    ),
    false
  );
  const lineup = await agent.runMatchAgent(fixture.id, "Is the expected lineup available?", agentNow);
  assert.match(lineup.answer, /lineup state: NONE/i);
  assert.doesNotMatch(lineup.answer, /that player/i);

  const shadow = structuredClone(t24);
  shadow.modelVersion = "pl-shadow-phase4b-test";
  shadow.provenance.uniqueKey = shadow.provenance.uniqueKey.replace(
    model.PRODUCTION_MODEL_VERSION,
    shadow.modelVersion
  );
  assert.deepEqual(
    service.productionSnapshotsForMatch(fixture.id, [shadow, t24]).map(
      (item) => item.provenance.uniqueKey
    ),
    [t24.provenance.uniqueKey]
  );
  assert.throws(() => service.buildMatchForecast(fixture, shadow), /Refusing non-production/);

  const legacyFixture = liveFixtures().find(
    (item) => item.id !== fixture.id && item.status !== "FINISHED" && item.kickoffUtc
  );
  assert.ok(legacyFixture);
  const legacy = await service.getMatchIntelligence(
    legacyFixture.id,
    new Date("2026-08-25T00:00:00.000Z")
  );
  assert.equal(legacy.context.atForecast.status, "NOT_RECORDED");
  assert.match(legacy.context.atForecast.note, /not backfilled/i);
  assert.deepEqual(legacy.context.news, []);
  assert.deepEqual(legacy.context.availability.items, []);
  assert.deepEqual(legacy.context.tactics.items, []);

  const invalidContextlessProvenance = structuredClone(contextlessFirstWrite);
  invalidContextlessProvenance.sourceState.contextEvidenceCount = 0;
  invalidContextlessProvenance.sourceState.contextModelUsedEvidenceCount = 7;
  invalidContextlessProvenance.sourceState.contextInformationalEvidenceCount = 9;
  invalidContextlessProvenance.sourceState.contextUsedInForecastEvidenceIds = [];
  assert.throws(
    () => service.buildMatchForecast(collisionFixture, invalidContextlessProvenance),
    /invalid champion context provenance/
  );

  console.log("Phase 4B integration tests passed");
}

main();
