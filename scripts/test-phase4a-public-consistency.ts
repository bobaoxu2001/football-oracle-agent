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
    settlements: metrics.settlements,
  };
}

async function main(): Promise<void> {
  const canonical = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const [liveResponse, healthResponse, accuracyResponse, shadowResponse] = await Promise.all([
    getLive(),
    getHealth(),
    getAccuracy(),
    getShadow(new Request("http://local/api/shadow")),
  ]);
  const [live, health, accuracy, shadow] = await Promise.all([
    liveResponse.json(),
    healthResponse.json(),
    accuracyResponse.json(),
    shadowResponse.json(),
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

  await check("settlement rows are not exposed as successful operations", () => {
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
    assert.ok(
      live.stagePerformance.every(
        (row: Record<string, unknown>) =>
          "totalForecastSnapshots" in row &&
          "settledForecastSnapshots" in row &&
          !("n" in row) &&
          !("nSettled" in row)
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
