/** Production read-path resilience and writer fail-closed gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TickOptions } from "@/lib/competitions/premier-league/ops/tick";

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
  const { liveOpsObserversDegraded, runGuardedLiveOpsTick } = await import(
    "@/lib/competitions/premier-league/ops/tick"
  );
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
    "/api/market",
    "/api/market/health",
    "/api/matches/:matchId/intelligence",
  ]) {
    assert.equal(publicCacheSources.includes(noStoreSource), false);
    const rule = headerRules.find(candidate => candidate.source === noStoreSource);
    assert.ok(rule?.headers.some(header =>
      header.key === "Cache-Control" && header.value === "private, no-store"
    ));
  }
  assert.equal(publicCacheSources.includes("/api/live"), true);
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
  assert.match(backupRestoreSource, /football-oracle-ops-backup-v2/);
  assert.match(backupRestoreSource, /pl_match_context_snapshots/);
  assert.match(backupRestoreSource, /acquireTickLock\("ops-bundle-export"\)/);
  assert.match(backupRestoreSource, /acquireTickLock\("ops-bundle-restore"\)/);
  assert.match(backupRestoreSource, /updatedAt:\s*nextMongoBundleRevision\(\)/);
  assert.match(backupRestoreSource, /withTransaction/);
  assert.match(backupRestoreSource, /contexts\.deleteMany/);
  assert.match(backupRestoreSource, /contexts\.insertMany/);
  assert.match(backupRestoreSource, /contextDocuments:\s*unknown/);
  assert.match(backupRestoreSource, /contextCount:\s*number/);
  assert.match(backupRestoreSource, /contextSha256:\s*string/);
  assert.match(backupRestoreSource, /context count\/checksum mismatch/);
  assert.match(backupRestoreSource, /requireResolvedContextReferences/);
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

  const workflow = fs.readFileSync(
    path.join(process.cwd(), ".github", "workflows", "ops-tick.yml"),
    "utf8"
  );
  assert.match(workflow, /cron: "3-58\/5 \* \* \* \*"/);
  assert.match(workflow, /cron: "17 \* \* \* \*"/);
  assert.match(workflow, /: > \/tmp\/tick-body/);
  assert.match(workflow, /: > \/tmp\/observer-body/);
  assert.match(workflow, /OBSERVER_CODE=[\s\S]*?--max-time 130/);
  assert.match(
    workflow,
    /for i in \$\(seq 1 "\$ROUNDS"\); do[\s\S]*?: > \/tmp\/observer-body[\s\S]*?OBSERVER_CODE=/
  );
  assert.match(workflow, /"\$OBSERVER_CODE" != "200"[\s\S]*?"\$OBSERVER_CODE" != "409"/);
  assert.match(workflow, /observer_state=http_\$\{OBSERVER_CODE\}[\s\S]*?fail=1/);
  assert.match(workflow, /github\.event\.schedule == '17 \* \* \* \*'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'[\s\S]*?github\.event\.inputs\.mode == 'loop'/);
  assert.match(workflow, /ROUND_STARTED_AT=/);
  assert.match(workflow, /DELAY="\$\(\( 300 - ELAPSED \)\)"/);
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
