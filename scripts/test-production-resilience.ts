/** Production read-path resilience and writer fail-closed gates. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TickOptions } from "@/lib/competitions/premier-league/ops/tick";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(source: string): unknown };

function emptyBundle() {
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
    contextSnapshots: "",
    fixturesOverlay: "",
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foa-production-resilience-"));
  const bundlePath = path.join(root, "ops-bundle.json");
  process.env.PL_OPS_BACKEND = "bundle";
  process.env.PL_DURABLE_WORK_DIR = path.join(root, "work");
  process.env.PL_OPS_BUNDLE_PATH = bundlePath;
  fs.writeFileSync(bundlePath, JSON.stringify(emptyBundle()), "utf8");

  const durable = await import("@/lib/competitions/premier-league/ops/durable-store");
  durable.resetDurableMetaForTests();

  const compressionJobs = Array.from({ length: 200 }, (_, index) =>
    JSON.stringify({ jobId: `job-${index}`, status: "PENDING", stage: "T7D" })
  ).join("\n") + "\n";
  const encodedBundle = durable.encodeMongoBundleForStorage({
    ...emptyBundle(),
    jobs: compressionJobs,
  });
  assert.equal("jobs" in encodedBundle, false);
  assert.ok(
    String(encodedBundle.jobsGzipBase64).length < Buffer.byteLength(compressionJobs, "utf8")
  );
  assert.equal(
    durable.decodeMongoBundleFromStorage(encodedBundle).jobs,
    compressionJobs
  );
  const legacyWrite = durable.mongoBundleForWrite(
    { ...emptyBundle(), jobs: compressionJobs },
    false
  );
  assert.equal(legacyWrite.jobs, compressionJobs);
  assert.equal("jobsGzipBase64" in legacyWrite, false);
  const compressedWrite = durable.mongoBundleForWrite(
    { ...emptyBundle(), jobs: compressionJobs },
    true
  );
  assert.equal("jobs" in compressedWrite, false);
  assert.equal(typeof compressedWrite.jobsGzipBase64, "string");
  assert.throws(
    () => durable.decodeMongoBundleFromStorage({ ...encodedBundle, jobsSha256: "0".repeat(64) }),
    /checksum mismatch/
  );
  assert.throws(
    () => durable.encodeMongoBundleForStorage({
      ...emptyBundle(),
      jobs: `${JSON.stringify({
        jobId: "oversized",
        padding: "x".repeat(8 * 1024 * 1024),
      })}\n`,
    }),
    /exceeds 8388608 bytes/
  );
  const legacyRevision = "2026-08-26T00:00:00.000Z";
  assert.equal(durable.parseMongoBundleRevision(legacyRevision), legacyRevision);
  const fencedRevision = durable.nextMongoBundleRevision(
    new Date("2026-08-26T00:01:00.000Z")
  );
  assert.deepEqual(fencedRevision, {
    iso: "2026-08-26T00:01:00.000Z",
    writerSchema: 2,
  });
  assert.deepEqual(durable.parseMongoBundleRevision(fencedRevision), fencedRevision);
  assert.deepEqual(durable.mongoBundleRevisionFilter(legacyRevision), {
    updatedAt: legacyRevision,
  });
  assert.deepEqual(durable.mongoBundleRevisionFilter(fencedRevision), {
    "updatedAt.iso": fencedRevision.iso,
    "updatedAt.writerSchema": 2,
  });
  const oldWriterPostMigrationFilter = {
    $or: [{ updatedAt: { $exists: false } }, { updatedAt: null }],
  };
  assert.notDeepEqual(
    durable.mongoBundleRevisionFilter(fencedRevision),
    oldWriterPostMigrationFilter
  );
  assert.throws(
    () => durable.parseMongoBundleRevision({ iso: fencedRevision.iso, writerSchema: 1 }),
    /unsupported writer schema/
  );
  assert.throws(
    () => durable.requireCompleteMongoStoredBundle({}),
    /sourceObservations is missing/
  );
  const partialStoredBundle = { ...legacyWrite };
  delete partialStoredBundle.fixturesOverlay;
  assert.throws(
    () => durable.requireCompleteMongoStoredBundle(partialStoredBundle),
    /fixturesOverlay is missing/
  );
  assert.equal(
    durable.requireCompleteMongoStoredBundle(legacyWrite).jobs,
    compressionJobs
  );
  assert.equal(
    typeof durable.requireCompleteMongoStoredBundle(encodedBundle).jobsGzipBase64,
    "string"
  );

  const originalRead = fs.readFileSync;
  let bundleReads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (path.resolve(String(file)) === path.resolve(bundlePath)) bundleReads += 1;
    return (originalRead as (...values: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  try {
    await Promise.all(Array.from({ length: 12 }, () => durable.hydrateDurableOps()));
    await durable.hydrateDurableOps();
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(bundleReads, 1, "fresh hydration must collapse repeated public reads");
  assert.equal(durable.durableStatus().hydrated, true);
  assert.equal(durable.durableStatus().hydrateRefreshFailed, false);
  const durableSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "competitions", "premier-league", "ops", "durable-store.ts"),
    "utf8"
  );
  assert.match(durableSource, /PUBLIC_HYDRATION_TIMEOUT_MS\s*=\s*20_000/);

  // A newer authoritative empty field must truncate bytes left in a warm
  // serverless work directory, never resurrect them on the next flush.
  const staleJob = `${JSON.stringify({ jobId: "stale-local-job" })}\n`;
  fs.writeFileSync(
    bundlePath,
    JSON.stringify({ ...emptyBundle(), jobs: staleJob }),
    "utf8"
  );
  await durable.hydrateDurableOps({ force: true, strict: true });
  const jobPath = path.join(process.env.PL_OPS_DIR!, "prediction-jobs.jsonl");
  assert.equal(fs.readFileSync(jobPath, "utf8"), staleJob);
  fs.writeFileSync(bundlePath, JSON.stringify(emptyBundle()), "utf8");
  await durable.hydrateDurableOps({ force: true, strict: true });
  assert.equal(fs.readFileSync(jobPath, "utf8"), "");

  const tickAt = "2026-08-25T17:05:00.000Z";
  fs.writeFileSync(
    bundlePath,
    JSON.stringify({ ...emptyBundle(), tickState: JSON.stringify({ lastTickAt: tickAt }) }),
    "utf8"
  );
  assert.equal(
    (await durable.durableTickFreshness(new Date("2026-08-25T17:11:59.000Z"))).fresh,
    true
  );
  assert.equal(
    (await durable.durableTickFreshness(new Date("2026-08-25T17:12:01.000Z"))).fresh,
    false
  );

  // A warm reader may retain its last verified in-process state, but the
  // failure is explicit and health-visible.
  fs.writeFileSync(bundlePath, "{broken", "utf8");
  const strictFlight = durable.hydrateDurableOps({ force: true, strict: true });
  const warmReaderFlight = durable.hydrateDurableOps({ force: true });
  const [strictFlightResult, warmReaderFlightResult] = await Promise.allSettled([
    strictFlight,
    warmReaderFlight,
  ]);
  assert.equal(strictFlightResult.status, "rejected");
  assert.equal(
    warmReaderFlightResult.status,
    "fulfilled",
    "a warm public reader applies its own stale-serving policy when joining a strict flight"
  );
  const stale = durable.durableStatus();
  assert.equal(stale.hydrated, true);
  assert.equal(stale.hydrateRefreshFailed, true);
  assert.ok(stale.lastHydrateFailedAt);

  // Writers never inherit that fallback. A strict refresh fails before the
  // scheduler can mutate or flush the stale work directory.
  await assert.rejects(
    durable.hydrateDurableOps({ force: true, strict: true }),
    /JSON|Unexpected|position/i
  );
  const brokenBytes = fs.readFileSync(bundlePath, "utf8");
  const {
    liveOpsObserversDegraded,
    liveOpsTickDegradationReason,
    liveOpsTickDegraded,
    runGuardedLiveOpsTick,
    runLiveOpsTick,
  } = await import("@/lib/competitions/premier-league/ops/tick");
  await assert.rejects(
    runGuardedLiveOpsTick({ skipNetwork: true }),
    /JSON|Unexpected|position/i
  );
  assert.equal(fs.readFileSync(bundlePath, "utf8"), brokenBytes);

  // A successful refresh clears the degradation marker.
  fs.writeFileSync(bundlePath, JSON.stringify(emptyBundle()), "utf8");
  await durable.hydrateDurableOps({ force: true, strict: true });
  assert.equal(durable.durableStatus().hydrateRefreshFailed, false);

  // A syntactically valid outer bundle with corrupt inner state is rejected
  // before any local file is changed or a writer can flush partial history.
  fs.writeFileSync(
    bundlePath,
    JSON.stringify({ ...emptyBundle(), jobs: "{not-json}\n" }),
    "utf8"
  );
  await assert.rejects(
    durable.hydrateDurableOps({ force: true, strict: true }),
    /jobs contains invalid JSON at line 1/
  );
  assert.equal(fs.readFileSync(jobPath, "utf8"), "");

  // Cold readers do not fabricate baseline-only public counts when durable
  // state is unavailable; they fail quickly and visibly.
  durable.resetDurableMetaForTests();
  fs.writeFileSync(bundlePath, "{broken", "utf8");
  await assert.rejects(durable.hydrateDurableOps(), /JSON|Unexpected|position/i);
  assert.equal(durable.durableStatus().hydrated, false);

  // Two overlapping writers serialize before hydration. The contender cannot
  // hydrate stale bytes while it waits; its later retry advances from the
  // first writer's committed tick instead of overwriting it.
  fs.writeFileSync(bundlePath, JSON.stringify(emptyBundle()), "utf8");
  durable.resetDurableMetaForTests();
  let unblockSource: () => void = () => undefined;
  let markSourceStarted: () => void = () => undefined;
  const sourceStarted = new Promise<void>(resolve => {
    markSourceStarted = resolve;
  });
  const blockingSource = {
    id: "blocking-test-source",
    kind: "live" as const,
    configured: true,
    fetch: async () => {
      markSourceStarted();
      await new Promise<void>(resolve => {
        unblockSource = resolve;
      });
      return [];
    },
  };
  const tickOptions: TickOptions = {
    fixtures: [],
    persistFixtures: false,
    persistObservations: false,
    persistFixturePatches: false,
    skipNetwork: true,
    skipShadow: true,
  };
  const firstWriter = runGuardedLiveOpsTick({
    ...tickOptions,
    now: "2026-08-25T18:00:00.000Z",
    sources: [blockingSource],
  });
  await sourceStarted;
  const overlappingWriter = await runGuardedLiveOpsTick({
    ...tickOptions,
    now: "2026-08-25T18:00:01.000Z",
    sources: [],
  });
  assert.equal(overlappingWriter.skipped, true);
  unblockSource();
  await firstWriter;
  const retryWriter = await runGuardedLiveOpsTick({
    ...tickOptions,
    now: "2026-08-25T18:05:00.000Z",
    sources: [],
  });
  assert.equal(retryWriter.skipped, undefined);
  const committedBundle = JSON.parse(fs.readFileSync(bundlePath, "utf8")) as {
    tickState: string;
  };
  const committedTick = JSON.parse(committedBundle.tickState) as {
    ticks: number;
    lastTickAt: string;
  };
  assert.equal(committedTick.ticks, 2);
  assert.equal(committedTick.lastTickAt, "2026-08-25T18:05:00.000Z");

  const configPath = path.join(process.cwd(), "next.config.mjs");
  const configModule = await import(`${pathToFileURL(configPath).href}?resilience=${Date.now()}`);
  const headerRules = await configModule.default.headers() as Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
  const publicCacheSources = headerRules
    .filter(rule => rule.headers.some(header =>
      header.key === "Vercel-CDN-Cache-Control" && header.value.startsWith("public")
    ))
    .map(rule => rule.source);
  for (const noStoreSource of [
    "/health",
    "/market",
    "/api/health",
    "/api/live",
    "/api/market",
    "/api/market/benchmark",
    "/api/market/health",
    "/api/matches/:matchId/intelligence",
  ]) {
    assert.equal(publicCacheSources.includes(noStoreSource), false);
    const rule = headerRules.find(candidate => candidate.source === noStoreSource);
    assert.ok(rule?.headers.some(header =>
      header.key === "Cache-Control" && header.value === "private, no-store"
    ));
  }
  const redirects = await configModule.default.redirects();
  assert.ok(redirects.some((redirect: { source: string }) => redirect.source === "/favicon.ico"));
  assert.equal(publicCacheSources.some(source => /agent|scenario/.test(source)), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), "app", "icon.svg")), true);
  const rateLimitSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "match-forecast", "rate-limit.ts"),
    "utf8"
  );
  assert.match(rateLimitSource, /DURABLE_GUARD_DEADLINE_MS\s*=\s*1_500/);
  assert.match(rateLimitSource, /timeoutMS:\s*2_000/);
  const tickLockSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "competitions", "premier-league", "ops", "tick-lock.ts"),
    "utf8"
  );
  assert.match(tickLockSource, /TICK_LOCK_OPERATION_TIMEOUT_MS\s*=\s*6_000/);
  assert.match(tickLockSource, /TICK_LOCK_RELEASE_TIMEOUT_MS\s*=\s*3_000/);
  const tickRouteSource = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "ops", "tick", "route.ts"),
    "utf8"
  );
  assert.match(tickRouteSource, /backup/);
  assert.match(tickRouteSource, /skipObservers/);
  assert.match(
    tickRouteSource,
    /if \(result\.skipped\)[\s\S]*?status: 409/
  );
  assert.match(tickRouteSource, /liveOpsTickDegraded\(result\) \? 503 : 200/);
  assert.equal(
    fs.existsSync(path.join(process.cwd(), "app", "api", "ops", "observers", "route.ts")),
    true
  );
  const observerRouteSource = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "ops", "observers", "route.ts"),
    "utf8"
  );
  assert.match(observerRouteSource, /runGuardedLiveOpsObservers\(\)/);
  assert.match(observerRouteSource, /maxDuration\s*=\s*120/);
  assert.match(observerRouteSource, /result\.skipped \? 409/);
  const matchLedgerStoreSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "match-ledger", "store.ts"),
    "utf8"
  );
  assert.match(matchLedgerStoreSource, /col\.bulkWrite\(/);
  assert.match(matchLedgerStoreSource, /\$setOnInsert/);
  assert.match(matchLedgerStoreSource, /\.find\(query,\s*\{ projection:/);
  assert.doesNotMatch(
    matchLedgerStoreSource,
    /collection\(COL_OBSERVATIONS\)[\s\S]{0,120}\.find\(\{\},/
  );
  const marketPageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "market", "page.tsx"),
    "utf8"
  );
  const marketApiSource = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "market", "route.ts"),
    "utf8"
  );
  for (const source of [marketPageSource, marketApiSource]) {
    assert.match(source, /listLatestConsensus\(\)/);
    assert.doesNotMatch(source, /listObservations\(\)/);
  }
  assert.match(marketPageSource, /Promise\.allSettled/);
  assert.match(marketPageSource, /Market summary is temporarily degraded/);
  assert.match(marketApiSource, /market_summary_unavailable/);
  assert.match(marketApiSource, /status:\s*503/);
  const storageRouteSource = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "ops", "storage", "route.ts"),
    "utf8"
  );
  assert.match(storageRouteSource, /acquireTickLock\("jobs-compression-migration"\)/);
  assert.match(storageRouteSource, /finally\s*{\s*await releaseTickLock\(leaseId\)/);
  assert.match(storageRouteSource, /maxDuration\s*=\s*60/);
  assert.match(storageRouteSource, /Date\.now\(\)\s*\+\s*50_000/);
  assert.match(storageRouteSource, /migrateMongoJobsToCompressedStorage\(deadline\)/);
  const backupRestoreSource = fs.readFileSync(
    path.join(process.cwd(), "scripts", "export-ops-bundle.ts"),
    "utf8"
  );
  assert.match(backupRestoreSource, /decodeMongoBundleFromStorage\([\s\S]*storedBundle/);
  assert.match(backupRestoreSource, /requireCompleteMongoStoredBundle/);
  assert.match(backupRestoreSource, /encodeMongoBundleForStorage\(logicalBundle\)/);
  assert.match(backupRestoreSource, /football-oracle-ops-backup-v3/);
  assert.match(backupRestoreSource, /pl_match_context_snapshots/);
  assert.match(backupRestoreSource, /pl_provenance_records/);
  assert.match(backupRestoreSource, /acquireTickLock\("ops-bundle-export"\)/);
  assert.match(backupRestoreSource, /acquireTickLock\("ops-bundle-restore"\)/);
  assert.match(backupRestoreSource, /updatedAt:\s*nextMongoBundleRevision\(\)/);
  assert.match(backupRestoreSource, /withTransaction/);
  assert.match(backupRestoreSource, /restoreImmutableContextDocuments/);
  assert.doesNotMatch(backupRestoreSource, /contexts[^\n]*\.deleteMany/);
  assert.doesNotMatch(backupRestoreSource, /contexts[^\n]*\.insertMany/);
  assert.match(backupRestoreSource, /contextDocuments:\s*unknown/);
  assert.match(backupRestoreSource, /contextCount:\s*number/);
  assert.match(backupRestoreSource, /contextSha256:\s*string/);
  assert.match(backupRestoreSource, /context count\/checksum mismatch/);
  assert.match(backupRestoreSource, /provenanceDocuments:\s*MongoProvenanceRecordDocument\[\]/);
  assert.match(backupRestoreSource, /provenanceCount:\s*number/);
  assert.match(backupRestoreSource, /provenanceCountsByKind:\s*ProvenanceCountsByKind/);
  assert.match(backupRestoreSource, /provenanceSha256:\s*string/);
  assert.match(backupRestoreSource, /\$setOnInsert/);
  assert.match(backupRestoreSource, /immutable read-back mismatch/);
  assert.doesNotMatch(backupRestoreSource, /provenance[^\n]*\.deleteMany/);
  assert.match(backupRestoreSource, /requireResolvedContextReferences/);
  assert.match(backupRestoreSource, /requireResolvedProvenanceGraph/);
  assert.match(backupRestoreSource, /contextSnapshotId/);
  assert.match(backupRestoreSource, /MONGODB_DB !== "football_oracle"/);
  assert.match(backupRestoreSource, /finally\s*{\s*await releaseTickLock\(lock\.leaseId\)/);

  const { marketRecorderFreshnessReasons } = await import(
    "@/lib/competitions/premier-league/market/health"
  );
  const healthNow = new Date("2026-08-25T18:30:00.000Z");
  assert.equal(
    marketRecorderFreshnessReasons(
      { lastSuccessAt: null, nextPollAt: null },
      healthNow
    ).length,
    1
  );
  assert.equal(
    marketRecorderFreshnessReasons(
      {
        lastSuccessAt: "2026-08-25T18:20:00.000Z",
        nextPollAt: "2026-08-25T18:25:00.000Z",
      },
      healthNow
    ).length,
    0
  );
  assert.match(
    marketRecorderFreshnessReasons(
      {
        lastSuccessAt: "2026-08-25T18:00:00.000Z",
        nextPollAt: "2026-08-25T18:05:00.000Z",
      },
      healthNow
    )[0],
    /overdue/
  );

  const healthyObservers = {
    now: healthNow.toISOString(),
    market: { attempted: true, pollJobId: "not-due", status: "SKIPPED", error: null },
    matchLedger: { attempted: true, ran: false, totalCompleted: null, errors: [], error: null },
  };
  assert.equal(liveOpsObserversDegraded(healthyObservers), false);
  assert.equal(
    liveOpsObserversDegraded({
      ...healthyObservers,
      market: { ...healthyObservers.market, status: "FAILED", error: "provider failed" },
    }),
    true
  );

  const healthyCore = {
    errors: [],
    fixtureConflicts: [],
    resultConflicts: [],
    jobsFailed: 0,
    jobsTerminalFailed: 0,
  };
  assert.equal(liveOpsTickDegraded(healthyCore), false);
  assert.equal(liveOpsTickDegraded({ ...healthyCore, errors: ["source failed"] }), true);
  assert.equal(
    liveOpsTickDegraded({
      ...healthyCore,
      fixtureConflicts: [
        {
          kind: "fixture-kickoff",
          fixtureId: "fixture-1",
          sources: ["a", "b"],
          detail: "sources disagree",
          recordedAt: healthNow.toISOString(),
        },
      ],
    }),
    true
  );
  assert.equal(
    liveOpsTickDegraded({
      ...healthyCore,
      resultConflicts: [
        {
          kind: "result-score",
          fixtureId: "fixture-1",
          sources: ["a", "b"],
          detail: "sources disagree",
          recordedAt: healthNow.toISOString(),
        },
      ],
    }),
    true
  );
  assert.equal(liveOpsTickDegraded({ ...healthyCore, jobsFailed: 1 }), true);
  assert.equal(
    liveOpsTickDegraded({ ...healthyCore, jobsTerminalFailed: 1 }),
    true
  );
  assert.equal(liveOpsTickDegradationReason(healthyCore), null);
  assert.equal(
    liveOpsTickDegradationReason({ ...healthyCore, errors: ["evidence failed"] }),
    "evidence failed"
  );
  assert.equal(
    liveOpsTickDegradationReason({ ...healthyCore, fixtureConflicts: [{
      kind: "fixture-kickoff",
      fixtureId: "fixture-1",
      sources: ["a", "b"],
      detail: "sources disagree",
      recordedAt: healthNow.toISOString(),
    }] }),
    "fixture conflicts detected: 1"
  );
  assert.equal(
    liveOpsTickDegradationReason({ ...healthyCore, jobsFailed: 2 }),
    "prediction jobs failed: 2"
  );
  assert.equal(
    liveOpsTickDegradationReason({ ...healthyCore, jobsTerminalFailed: 2 }),
    "prediction jobs exhausted retries: 2"
  );

  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "ops-tick.yml"),
    "utf8"
  );
  const workflowDocument = yaml.load(workflow) as {
    jobs?: { tick?: { steps?: Array<{ name?: string; run?: string }> } };
  };
  assert.ok(workflowDocument, "ops workflow must be valid YAML");
  assert.match(workflow, /cron: "3-58\/5 \* \* \* \*"/);
  assert.match(workflow, /cron: "17 \* \* \* \*"/);
  assert.match(workflow, /timeout-minutes: 330/);
  assert.match(workflow, /mode:\s+description:[\s\S]*?type: choice[\s\S]*?options:\s+- once\s+- loop/);
  assert.match(workflow, /continue_chain:\s+description:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /rounds:\s+description:[\s\S]*?type: number[\s\S]*?default: 60/);
  assert.match(workflow, /parent_run_id:\s+description:[\s\S]*?type: string/);
  assert.match(workflow, /run-name:.*handoff-from-\{0\}.*inputs\.parent_run_id/);
  assert.match(workflow, /REQUESTED_ROUNDS: \$\{\{ inputs\.rounds \}\}/);
  assert.match(workflow, /REQUESTED_ROUNDS="\$\{REQUESTED_ROUNDS:-60\}"/);
  assert.match(workflow, /\^\[0-9\]\+\$/);
  assert.match(workflow, /"\$REQUESTED_ROUNDS" -lt 1[\s\S]*?"\$REQUESTED_ROUNDS" -gt 60/);
  assert.match(workflow, /: > \/tmp\/tick-body/);
  assert.match(workflow, /: > \/tmp\/observer-body/);
  assert.match(workflow, /observer_state=skipped_primary_fresh/);
  assert.match(
    workflow,
    /body\.get\("skipped"\) is True[\s\S]*?body\.get\("skipReason"\) == "primary tick is fresh"/
  );
  assert.match(workflow, /OBSERVER_CODE=[\s\S]*?--max-time 130/);
  assert.match(
    workflow,
    /for i in \$\(seq 1 "\$ROUNDS"\); do[\s\S]*?: > \/tmp\/observer-body[\s\S]*?OBSERVER_CODE=/
  );
  assert.match(workflow, /"\$OBSERVER_CODE" != "200"[\s\S]*?"\$OBSERVER_CODE" != "409"/);
  assert.match(workflow, /MAX_CONSECUTIVE_FAILURES: "3"/);
  assert.match(workflow, /core_consecutive_failures="\$\(\( core_consecutive_failures \+ 1 \)\)"/);
  assert.match(workflow, /observer_consecutive_failures="\$\(\( observer_consecutive_failures \+ 1 \)\)"/);
  assert.match(workflow, /failure_recovery=core[\s\S]*?core_consecutive_failures=0/);
  assert.match(workflow, /failure_recovery=observer[\s\S]*?observer_consecutive_failures=0/);
  assert.match(
    workflow,
    /core_consecutive_failures" -ge "\$MAX_CONSECUTIVE_FAILURES"[\s\S]*?fatal_state=core_consecutive_failure_threshold[\s\S]*?break/
  );
  assert.doesNotMatch(
    workflow,
    /observer_consecutive_failures" -ge "\$MAX_CONSECUTIVE_FAILURES"[\s\S]*?fatal/
  );
  assert.match(workflow, /terminal core failures:[\s\S]*?terminal observer failures/);
  assert.match(workflow, /github\.event\.schedule == '17 \* \* \* \*'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'[\s\S]*?inputs\.mode == 'loop'/);
  assert.match(workflow, /ROUND_STARTED_AT=/);
  assert.match(workflow, /DELAY="\$\(\( 300 - ELAPSED \)\)"/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);

  const tickJobStart = workflow.indexOf("\n  tick:");
  const handoffJobStart = workflow.indexOf("\n  handoff:");
  assert.ok(tickJobStart > 0 && handoffJobStart > tickJobStart, "tick and handoff jobs must exist");
  const tickJob = workflow.slice(tickJobStart, handoffJobStart);
  const handoffJob = workflow.slice(handoffJobStart);
  assert.match(tickJob, /permissions:\s+contents: read/);
  assert.doesNotMatch(tickJob, /actions: write/);
  assert.match(tickJob, /ROUNDS=1[\s\S]*?if \[ "\$MODE" = "loop" \]/);
  assert.match(tickJob, /if \[ "\$MODE" = "once" \]; then\s+CORE_URL="\$\{CORE_URL\}&backup=1"/);
  assert.doesNotMatch(tickJob, /\bfail=[01]\b/);
  assert.match(
    tickJob,
    /market\/ledger observer remains degraded[\s\S]*?forecast-core recurrence will continue/
  );
  assert.match(handoffJob, /permissions:\s+actions: write/);
  assert.doesNotMatch(handoffJob, /CRON_SECRET/);
  assert.match(handoffJob, /needs: tick/);
  assert.match(handoffJob, /needs\.tick\.result == 'success'/);
  assert.match(handoffJob, /github\.run_attempt == 1/);
  assert.match(handoffJob, /vars\.OPS_HANDOFF_ENABLED == 'true'/);
  assert.match(handoffJob, /inputs\.mode == 'loop'[\s\S]*?inputs\.continue_chain/);
  assert.doesNotMatch(handoffJob, /inputs\.mode == 'once'/);
  assert.doesNotMatch(handoffJob, /always\(\)/);
  assert.match(handoffJob, /NEXT_TITLE: ops-tick handoff-from-\$\{\{ github\.run_id \}\}/);
  assert.match(handoffJob, /run\.get\("display_title"\) == os\.environ\["NEXT_TITLE"\]/);
  assert.match(handoffJob, /handoff_state=already_exists/);
  assert.match(handoffJob, /"mode": "loop"[\s\S]*?"continue_chain": "true"[\s\S]*?"rounds": "60"/);
  assert.match(handoffJob, /"parent_run_id": os\.environ\["PARENT_RUN_ID"\]/);
  assert.equal(
    (workflow.match(/actions\/workflows\/\$\{WORKFLOW_ID\}\/dispatches/g) ?? []).length,
    1,
    "one workflow definition must contain exactly one successor dispatch"
  );
  assert.doesNotMatch(handoffJob, /--retry|retry-all-errors/);
  assert.match(handoffJob, /X-GitHub-Api-Version: 2026-03-10/);
  assert.doesNotMatch(handoffJob, /return_run_details/);
  assert.match(handoffJob, /workflow_run_id/);
  assert.match(handoffJob, /handoff_state=created successor_run_id=/);

  // Execute the exact checked-in tick shell with deterministic HTTP doubles.
  // Observer-only failures must leave recurrence successful; core failures
  // still fail closed after the configured threshold.
  const tickScript = workflowDocument.jobs?.tick?.steps?.find(
    (step) => step.name === "Authenticated production ticks"
  )?.run;
  assert.ok(tickScript, "workflow tick shell must be extractable from parsed YAML");
  const shellRoot = path.join(root, "workflow-shell");
  const binRoot = path.join(shellRoot, "bin");
  fs.mkdirSync(binRoot, { recursive: true });
  const curlDouble = path.join(binRoot, "curl");
  fs.writeFileSync(
    curlDouble,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  if [ "$arg" = "-o" ]; then
    next=$((i + 1))
    output="\${!next}"
  fi
  if [[ "$arg" == http* ]]; then url="$arg"; fi
done
if [[ "$url" == *observers* ]]; then
  code="\${TEST_OBSERVER_CODE}"
  body="\${TEST_OBSERVER_BODY}"
else
  code="\${TEST_CORE_CODE}"
  body="\${TEST_CORE_BODY}"
fi
printf '%s' "$url" >> "\${TEST_CURL_LOG}"
printf '\n' >> "\${TEST_CURL_LOG}"
printf '%s' "$body" > "$output"
printf '%s' "$code"
`,
    "utf8"
  );
  fs.chmodSync(curlDouble, 0o755);
  const sleepDouble = path.join(binRoot, "sleep");
  fs.writeFileSync(sleepDouble, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.chmodSync(sleepDouble, 0o755);
  const tickScriptPath = path.join(shellRoot, "tick.sh");
  fs.writeFileSync(tickScriptPath, tickScript, "utf8");
  fs.chmodSync(tickScriptPath, 0o755);

  function runWorkflowShell(input: {
    mode: "once" | "loop";
    rounds: string;
    coreCode: string;
    observerCode: string;
    coreBody?: string;
    observerBody?: string;
    label?: string;
  }) {
    const summaryPath = path.join(
      shellRoot,
      `summary-${input.label ?? `${input.mode}-${input.coreCode}-${input.observerCode}`}.md`
    );
    return spawnSync("bash", [tickScriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        CRON_SECRET: "test-secret",
        OPS_TICK_URL: "https://example.invalid/api/ops/tick",
        OPS_OBSERVER_URL: "https://example.invalid/api/ops/observers",
        MODE: input.mode,
        REQUESTED_ROUNDS: input.rounds,
        MAX_CONSECUTIVE_FAILURES: "3",
        GITHUB_STEP_SUMMARY: summaryPath,
        TEST_CORE_CODE: input.coreCode,
        TEST_OBSERVER_CODE: input.observerCode,
        TEST_CORE_BODY: input.coreBody ?? "{}",
        TEST_OBSERVER_BODY: input.observerBody ?? "{}",
        TEST_CURL_LOG: `${summaryPath}.curl.log`,
      },
    });
  }

  const observerDegraded = runWorkflowShell({
    mode: "loop",
    rounds: "3",
    coreCode: "200",
    observerCode: "503",
  });
  assert.equal(observerDegraded.status, 0, observerDegraded.stderr);
  assert.match(observerDegraded.stdout, /forecast-core recurrence will continue/);
  assert.match(observerDegraded.stdout, /round=3 /);

  const coreDegraded = runWorkflowShell({
    mode: "loop",
    rounds: "3",
    coreCode: "503",
    observerCode: "200",
  });
  assert.notEqual(coreDegraded.status, 0);
  assert.match(coreDegraded.stdout, /fatal_state=core_consecutive_failure_threshold/);

  const oneShotObserverDegraded = runWorkflowShell({
    mode: "once",
    rounds: "60",
    coreCode: "200",
    observerCode: "503",
  });
  assert.equal(oneShotObserverDegraded.status, 0, oneShotObserverDegraded.stderr);
  assert.match(oneShotObserverDegraded.stdout, /mode=once rounds=1/);
  assert.doesNotMatch(oneShotObserverDegraded.stdout, /round=2 /);

  const freshBackup = runWorkflowShell({
    mode: "once",
    rounds: "60",
    coreCode: "200",
    observerCode: "503",
    coreBody: JSON.stringify({ skipped: true, skipReason: "primary tick is fresh" }),
    label: "fresh-backup",
  });
  assert.equal(freshBackup.status, 0, freshBackup.stderr);
  assert.match(freshBackup.stdout, /observer_state=skipped_primary_fresh/);
  assert.doesNotMatch(freshBackup.stdout, /observers_at=/);
  const freshBackupCurlLog = fs.readFileSync(
    path.join(shellRoot, "summary-fresh-backup.md.curl.log"),
    "utf8"
  );
  assert.equal(
    freshBackupCurlLog.trim().split("\n").filter(Boolean).length,
    1,
    "a fresh one-shot backup must call only the core freshness endpoint"
  );

  const lockedBackup = runWorkflowShell({
    mode: "once",
    rounds: "60",
    coreCode: "409",
    observerCode: "200",
    coreBody: JSON.stringify({ skipped: true, skipReason: "tick already running" }),
    label: "locked-backup",
  });
  assert.equal(lockedBackup.status, 0, lockedBackup.stderr);
  assert.match(lockedBackup.stdout, /observers_at=.*status=200/);

  const normalLoopWithFreshLookingBody = runWorkflowShell({
    mode: "loop",
    rounds: "1",
    coreCode: "200",
    observerCode: "200",
    coreBody: JSON.stringify({ skipped: true, skipReason: "primary tick is fresh" }),
    label: "normal-loop",
  });
  assert.equal(normalLoopWithFreshLookingBody.status, 0, normalLoopWithFreshLookingBody.stderr);
  assert.match(normalLoopWithFreshLookingBody.stdout, /observers_at=.*status=200/);

  const isolatedNow = "2026-08-26T12:30:00.000Z";
  const isolatedCoreOptions: TickOptions = {
    now: isolatedNow,
    fixtures: [],
    sources: [
      {
        id: "isolated-test-source",
        kind: "baseline",
        configured: true,
        async fetch() {
          return [];
        },
      },
    ],
    persistFixtures: false,
    persistObservations: false,
    persistFixturePatches: false,
    skipObservers: true,
  };
  await runLiveOpsTick({
    ...isolatedCoreOptions,
    shadowFreezeRunner: async () => ({ frozen: 0, errors: [] }),
  });
  const { buildHealthReport } = await import(
    "@/lib/competitions/premier-league/ops/health"
  );
  const cleanShadowHealth = buildHealthReport(new Date(isolatedNow));
  const isolatedShadowFailure = await runLiveOpsTick({
    ...isolatedCoreOptions,
    shadowFreezeRunner: async () => {
      throw new Error("synthetic challenger failure");
    },
  });
  const failedShadowHealth = buildHealthReport(new Date(isolatedNow));
  assert.deepEqual(isolatedShadowFailure.errors, []);
  assert.deepEqual(isolatedShadowFailure.shadowErrors, ["synthetic challenger failure"]);
  assert.equal(isolatedShadowFailure.state.lastError, null);
  assert.equal(isolatedShadowFailure.state.lastSuccessAt, isolatedNow);
  assert.equal(
    isolatedShadowFailure.state.lastShadowError,
    "synthetic challenger failure"
  );
  assert.equal(failedShadowHealth.scheduler.freshness.status, "FRESH");
  assert.deepEqual(
    {
      overall: failedShadowHealth.overall,
      reasons: failedShadowHealth.reasons,
      schedulerFreshness: failedShadowHealth.scheduler.freshness,
    },
    {
      overall: cleanShadowHealth.overall,
      reasons: cleanShadowHealth.reasons,
      schedulerFreshness: cleanShadowHealth.scheduler.freshness,
    },
    "challenger failure must not alter production health"
  );
  const opsTickSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "competitions", "premier-league", "ops", "tick.ts"),
    "utf8"
  );
  assert.match(opsTickSource, /providerTimeoutMs:\s*4_000/);
  assert.match(opsTickSource, /providerMaxRetries:\s*0/);
  assert.match(opsTickSource, /interRequestDelayMs:\s*1_500/);
  assert.match(opsTickSource, /acquireObserverLock\("ops-observers"\)/);
  assert.match(opsTickSource, /finally\s*{\s*await releaseObserverLock\(lock\.leaseId\)/);
  assert.match(opsTickSource, /await runGuardedLiveOpsObservers\({ now: options\.now }\)/);
  console.log("Production resilience tests passed");
}

void main();
