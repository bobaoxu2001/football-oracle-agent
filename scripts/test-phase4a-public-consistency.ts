/** Phase 4A: public ledger surfaces must share one explicit count contract. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { GET as getLive } from "@/app/api/live/route";
import { GET as getHealth } from "@/app/api/health/route";
import { GET as getAccuracy } from "@/app/api/accuracy/route";
import { GET as getShadow } from "@/app/api/shadow/route";
import { GET as getUpcoming } from "@/app/api/matches/upcoming/route";
import { GET as getFixtureLive } from "@/app/api/live/fixture/[id]/route";
import { buildPublicHealthResponse } from "@/lib/competitions/premier-league/ops/public-health";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { forecastFreshness } from "@/lib/match-forecast/service";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { jobsForFixture } from "@/lib/competitions/premier-league/ops/job-ledger";

let passed = 0;

async function check(name: string, test: () => void | Promise<void>): Promise<void> {
  await test();
  passed += 1;
  console.log(`✓ ${name}`);
}

function publicMetricShape(value: unknown): unknown {
  const metrics = value as ReturnType<typeof canonicalLedgerMetrics>;
  return {
    schemaVersion: metrics.schemaVersion,
    season: metrics.season,
    evaluationClass: metrics.evaluationClass,
    production: metrics.production,
    shadow: metrics.shadow,
    allTracks: metrics.allTracks,
    evaluationMaturity: metrics.evaluationMaturity,
    settlements: metrics.settlements,
  };
}

async function main(): Promise<void> {
  const canonical = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const [liveResponse, healthResponse, accuracyResponse, shadowResponse, upcomingResponse] = await Promise.all([
    getLive(),
    getHealth(),
    getAccuracy(),
    getShadow(new Request("http://local/api/shadow")),
    getUpcoming(),
  ]);
  const [live, health, accuracy, shadow, upcoming] = await Promise.all([
    liveResponse.json(),
    healthResponse.json(),
    accuracyResponse.json(),
    shadowResponse.json(),
    upcomingResponse.json(),
  ]);

  await check("live API publishes the canonical ledger metrics unchanged", () => {
    assert.deepEqual(publicMetricShape(live.ledgerMetrics), publicMetricShape(canonical));
  });

  await check("health API publishes the same canonical ledger metrics", () => {
    assert.deepEqual(publicMetricShape(health.ledgerMetrics), publicMetricShape(canonical));
  });

  await check("accuracy API publishes the same canonical ledger metrics", () => {
    assert.deepEqual(publicMetricShape(accuracy.ledgerMetrics), publicMetricShape(canonical));
  });

  await check("shadow API preserves production/shadow count isolation", () => {
    assert.deepEqual(shadow.ledgerMetrics.production, canonical.production);
    assert.deepEqual(shadow.ledgerMetrics.shadow, canonical.shadow);
  });

  await check("production health arithmetic is scope-consistent", () => {
    assert.equal(health.productionLedger.role, "production");
    assert.equal(
      health.productionLedger.unsettledForecastSnapshots,
      health.productionLedger.totalForecastSnapshots -
        health.productionLedger.settledForecastSnapshots
    );
    assert.equal(
      health.productionLedger.totalForecastSnapshots,
      canonical.production.totalForecastSnapshots
    );
    assert.equal(
      health.productionLedger.settledForecastSnapshots,
      canonical.production.settledForecastSnapshots
    );
    assert.equal(
      health.productionLedger.uniqueFixturesSettled,
      canonical.production.uniqueFixturesSettled
    );
  });

  await check("snapshot and unique-fixture units cannot collapse to one field", () => {
    assert.equal(
      live.ledger.settledForecastSnapshots,
      canonical.production.settledForecastSnapshots
    );
    assert.equal(live.ledger.uniqueFixturesSettled, canonical.production.uniqueFixturesSettled);
    assert.ok("settledForecastSnapshots" in live.ledger);
    assert.ok("uniqueFixturesSettled" in live.ledger);
  });

  await check("fixture maturity and independent N never use snapshot-row counts", () => {
    assert.equal(
      live.productionPerformance.independentSampleSize,
      canonical.evaluationMaturity.production.uniqueFixtureCount
    );
    assert.equal(
      live.productionPerformance.evaluationMaturity.uniqueFixtureCount,
      canonical.evaluationMaturity.production.uniqueFixtureCount
    );
    assert.equal(
      live.productionPerformance.uniqueFixturesSettled,
      canonical.production.uniqueFixturesSettled,
      "raw linked settled-fixture volume remains a separately labelled count"
    );
    assert.equal(
      live.productionPerformance.evaluationMaturity.status,
      canonical.evaluationMaturity.production.status
    );
    assert.ok(shadow.uniquePairedFixtures <= shadow.pairedSettlementRows);
    assert.equal(shadow.evaluationMaturity.uniqueFixtureCount, shadow.uniquePairedFixtures);
    assert.equal(shadow.uncertainty.independentUnit, "fixture");
  });

  await check("public freshness is canonical, scoped, and stage-based", () => {
    assert.equal(live.freshness.policyVersion, health.freshness.policyVersion);
    assert.equal(
      live.freshness.forecastCoverage.status,
      health.freshness.forecastCoverage.status
    );
    assert.equal(health.scheduler.freshness.scope, "scheduler");
    assert.equal(health.fixtureSync.freshness.scope, "fixtureSync");
    assert.equal(health.freshness.marketObserver.scope, "marketObserver");
    assert.equal(health.freshness.marketObserver.affectsProductionForecast, false);
    assert.ok(
      upcoming.matches.every(
        (match: { freshness: Record<string, unknown> }) =>
          match.freshness.policyVersion === health.freshness.policyVersion &&
          "meetsStagePolicy" in match.freshness &&
          !("ageHours" in match.freshness) &&
          !("note" in match.freshness)
      )
    );
    assert.equal(upcomingResponse.headers.get("cache-control"), "private, no-store");
  });

  await check("settlement rows are not exposed as successful operations", () => {
    assert.equal(canonical.settlements.scope, "all-tracks");
    assert.equal(health.settlement.scope, "all-tracks");
    assert.equal(live.settlements.scope, "all-tracks");
    assert.equal(accuracy.ledgerMetrics.settlements.scope, "all-tracks");
    assert.equal(shadow.ledgerMetrics.settlements.scope, "all-tracks");
    assert.equal(health.settlement.successfulSettlementEvents, null);
    assert.equal(health.settlement.eventCountStatus, "unavailable");
    assert.equal("succeeded" in health.settlement, false);
    assert.equal(live.settlements.successfulSettlementEvents, null);
  });

  await check("alias-index diagnostics are absent from public live counts", () => {
    const json = JSON.stringify(live);
    assert.equal(json.includes("duplicatesSuppressed"), false);
    assert.equal(json.includes("rawReferences"), false);
    assert.equal("nPredictions" in live.productionPerformance, false);
    assert.equal("nSettled" in live.productionPerformance, false);
    assert.equal("stages" in live.productionPerformance, false);
    assert.ok(
      live.stagePerformance.every(
        (row: Record<string, unknown>) =>
          "totalForecastSnapshots" in row &&
          "settledForecastSnapshots" in row &&
          "uniqueSettledFixtures" in row &&
          "effectiveN" in row &&
          !("n" in row) &&
          !("nSettled" in row)
      )
    );
  });

  await check("accuracy API keeps reconstruction under an explicit historical scope", () => {
    assert.equal("track" in accuracy, false);
    assert.equal("dc" in accuracy, false);
    assert.equal(
      accuracy.historicalReconstruction.scope,
      "historical-reconstruction"
    );
    assert.equal(
      accuracy.historicalReconstruction.evaluationClass,
      "RETROSPECTIVE"
    );
  });

  await check("headline estimates and intervals cannot leak through an EARLY_EVIDENCE payload", () => {
    assert.equal(live.productionPerformance.evaluationMaturity.status, "EARLY_EVIDENCE");
    for (const metric of [
      "brier",
      "rps",
      "logLoss",
      "confidenceEce",
      "pooledReliabilityMae",
      "topPickAccuracy",
    ]) {
      assert.equal(live.productionPerformance[metric], null);
    }
    assert.ok(
      Object.values(live.productionPerformance.uncertainty.pointEstimates).every(
        (value) => value === null
      )
    );
    assert.equal(live.productionPerformance.uncertainty.intervals, null);
    assert.notEqual(live.productionPerformance.uncertainty.intervalStatus, "AVAILABLE");

    assert.equal(shadow.evaluationMaturity.status, "EARLY_EVIDENCE");
    assert.equal(shadow.metrics, null);
    assert.ok(
      Object.values(shadow.uncertainty.pointEstimates).every(
        (value) => value === null
      )
    );
    assert.equal(shadow.uncertainty.intervals, null);
  });

  await check("health market failure keeps a stable full shape and unknown counts", async () => {
    const fixedNow = new Date("2026-08-26T12:00:00.000Z");
    const failed = await buildPublicHealthResponse({
      now: fixedNow,
      marketHealthBuilder: async () => {
        throw new Error("synthetic market read failure");
      },
    });
    assert.deepEqual(
      Object.keys(failed.market).sort(),
      Object.keys(health.market).sort()
    );
    assert.equal(failed.market.overall, "DEGRADED");
    assert.equal(
      failed.market.freshness.status,
      failed.market.source.configured ? "ERROR" : "UNCONFIGURED"
    );
    assert.equal(failed.market.freshness.evaluatedAt, fixedNow.toISOString());
    assert.equal(failed.market.freshness.affectsProductionForecast, false);
    assert.deepEqual(failed.freshness.marketObserver, failed.market.freshness);
    assert.equal(failed.market.observationsStored, null);
    assert.equal(failed.market.consensusStored, null);
    assert.equal(failed.market.fixturesMatched, null);
  });

  await check("fixture API uses one canonical evaluation instant and explicit validity fields", async () => {
    const fixtureId = upcoming.matches[0]?.match?.id as string | undefined;
    assert.ok(fixtureId, "an upcoming fixture is required for fixture-route consistency");
    const fixtureResponse = await getFixtureLive(
      new Request(`http://local/api/live/fixture/${fixtureId}`),
      { params: Promise.resolve({ id: fixtureId }) }
    );
    assert.equal(fixtureResponse.status, 200);
    const payload = await fixtureResponse.json();
    const fixture = liveFixtures().find((row) => row.id === fixtureId);
    assert.ok(fixture);
    const evaluatedAt = new Date(payload.freshness.evaluatedAt);
    const expected = forecastFreshness(
      fixture,
      listLiveSnapshots({ fixtureId }),
      evaluatedAt,
      jobsForFixture(fixtureId)
    );
    assert.deepEqual(payload.freshness, expected);
    assert.ok(payload.immutableTimeline.length > 0);
    assert.ok(
      payload.immutableTimeline.every(
        (row: Record<string, unknown>) =>
          "kickoffIdentityCurrent" in row &&
          "validForStagePolicy" in row &&
          "validForCurrentSelection" in row &&
          Array.isArray(row.validityIssues)
      )
    );
  });

  await check("all count-bearing pages are wired to the canonical contract", () => {
    const sources = {
      home: fs.readFileSync(path.resolve("app/page.tsx"), "utf8"),
      accuracy: fs.readFileSync(path.resolve("app/accuracy/page.tsx"), "utf8"),
      ledger: fs.readFileSync(path.resolve("app/live/page.tsx"), "utf8"),
      health: fs.readFileSync(path.resolve("app/health/page.tsx"), "utf8"),
      shadow: fs.readFileSync(path.resolve("app/shadow/page.tsx"), "utf8"),
    };
    assert.ok(sources.home.includes("canonicalLedgerMetrics"));
    assert.ok(sources.accuracy.includes("canonicalLedgerMetrics"));
    assert.ok(sources.ledger.includes("canonicalLedgerMetrics"));
    assert.ok(sources.health.includes("h.ledgerMetrics"));
    assert.ok(sources.shadow.includes("canonicalLedgerMetrics"));
    assert.equal(Object.values(sources).some((source) => source.includes("Settlement succeeded")), false);
  });

  await check("freshness-bearing production routes are not edge cached", () => {
    const config = fs.readFileSync(path.resolve("next.config.mjs"), "utf8");
    const noStoreBlock = config.slice(config.indexOf("const noStoreRoutes"));
    for (const route of [
      '"/"',
      '"/live"',
      '"/live/:path*"',
      '"/match/:path*"',
      '"/api/live"',
      '"/api/matches/upcoming"',
      '"/api/health"',
    ]) {
      assert.ok(noStoreBlock.includes(route), `${route} must be no-store`);
    }
  });

  await check("wide accuracy evidence stays inside its mobile scroll container", () => {
    const layout = fs.readFileSync(path.resolve("app/layout.tsx"), "utf8");
    const accuracy = fs.readFileSync(path.resolve("app/accuracy/page.tsx"), "utf8");
    assert.match(layout, /className="min-w-0 flex-1"/);
    assert.match(accuracy, /w-full max-w-full overflow-x-auto overscroll-x-contain/);
    assert.match(accuracy, /glass min-w-0 max-w-full/);
    assert.match(accuracy, /grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-5/);
    assert.match(accuracy, /min-w-0 lg:col-span-2/);
    assert.match(accuracy, /min-w-0 lg:col-span-3/);
  });

  console.log(`\nPhase 4A public consistency: ${passed} passed, 0 failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
