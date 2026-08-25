/** Phase 4A: canonical ledger-unit and settlement-replay regression gates. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import { buildCanonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

function snapshot(input: {
  fixtureId: string;
  modelVersion: string;
  stage: "PRESEASON" | "T24H";
  asOf: string;
}): PredictionSnapshot {
  const uniqueKey = [
    "premier-league",
    "test-season",
    input.fixtureId,
    input.modelVersion,
    input.stage,
    input.asOf,
  ].join("::");
  return {
    competition: "premier-league",
    season: "test-season",
    fixtureId: input.fixtureId,
    homeTeam: "Home",
    awayTeam: "Away",
    homeSlug: "home",
    awaySlug: "away",
    kickoff: "2099-08-20T20:00:00.000Z",
    createdAt: input.asOf,
    asOf: input.asOf,
    dataCutoff: input.asOf,
    modelVersion: input.modelVersion,
    predictionStage: input.stage,
    evaluationClass: "LIVE_OOS",
    homeProbability: 0.5,
    drawProbability: 0.3,
    awayProbability: 0.2,
    homeGoalExpectation: 1.5,
    awayGoalExpectation: 1,
    scorelineDistribution: {},
    modelParameters: {},
    sourceState: {},
    provenance: { store: "file", uniqueKey, notes: "test" },
    home: 0.5,
    draw: 0.3,
    away: 0.2,
    homeExpectedGoals: 1.5,
    awayExpectedGoals: 1,
  };
}

function settlement(row: PredictionSnapshot): SettlementRecord {
  return {
    snapshotUniqueKey: row.provenance.uniqueKey,
    fixtureId: row.fixtureId,
    season: row.season,
    modelVersion: row.modelVersion,
    predictionStage: String(row.predictionStage),
    evaluationClass: "LIVE_OOS",
    settledAt: "2099-08-20T22:00:00.000Z",
    actualOutcome: "home",
    actualScore: { home: 2, away: 0 },
    predicted: { home: row.homeProbability, draw: row.drawProbability, away: row.awayProbability },
    brier: 0.38,
    rps: 0.17,
    logLoss: -Math.log(row.homeProbability),
    topPickCorrect: true,
    verificationId: `verified::${row.fixtureId}`,
  };
}

const productionVersion = "production-v1";
const shadowVersion = "shadow-v1";
const pPre = snapshot({
  fixtureId: "fixture-a",
  modelVersion: productionVersion,
  stage: "PRESEASON",
  asOf: "2099-08-01T00:00:00.000Z",
});
const pTimed = snapshot({
  fixtureId: "fixture-a",
  modelVersion: productionVersion,
  stage: "T24H",
  asOf: "2099-08-19T20:00:00.000Z",
});
const pOther = snapshot({
  fixtureId: "fixture-b",
  modelVersion: productionVersion,
  stage: "PRESEASON",
  asOf: "2099-08-01T00:00:00.000Z",
});
const shadowTimed = snapshot({
  fixtureId: "fixture-a",
  modelVersion: shadowVersion,
  stage: "T24H",
  asOf: "2099-08-19T20:00:00.000Z",
});
const orphan = { ...settlement(pOther), snapshotUniqueKey: "missing-snapshot" };

const metrics = buildCanonicalLedgerMetrics({
  season: "test-season",
  snapshots: [pPre, pTimed, pOther, shadowTimed, pTimed],
  committedSnapshots: [pPre, pOther],
  settlements: [settlement(pPre), settlement(pTimed), settlement(shadowTimed), orphan],
  productionVersion,
  shadowVersion,
});

check("production snapshot count is canonical-key deduped", metrics.production.totalForecastSnapshots === 3);
check("settled production snapshots retain stage multiplicity", metrics.production.settledForecastSnapshots === 2);
check("unique settled fixtures cannot be confused with snapshots", metrics.production.uniqueFixturesSettled === 1);
check("production committed/operational split is explicit", metrics.production.committedForecastSnapshots === 2 && metrics.production.operationalForecastSnapshots === 1);
check("shadow track remains separate", metrics.shadow.totalForecastSnapshots === 1 && metrics.shadow.settledForecastSnapshots === 1);
check("all-track totals include production and shadow", metrics.allTracks.totalForecastSnapshots === 4 && metrics.allTracks.settledForecastSnapshots === 3);
check("all-track unique fixtures do not double-count model tracks", metrics.allTracks.uniqueFixturesSettled === 1);
check("persisted and linked settlement records are separate", metrics.settlements.persistedSnapshotSettlementRecords === 4 && metrics.settlements.linkedForecastSnapshotRecords === 3 && metrics.settlements.orphanSettlementRecords === 1);
check("settlement event count is explicitly unavailable", metrics.settlements.successfulSettlementEvents === null && metrics.settlements.eventCountStatus === "unavailable");

async function replayGate(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "football-oracle-phase4a-"));
  process.env.SNAPSHOT_STORE_PATH = path.join(tmp, "working.jsonl");
  process.env.LIVE_OOS_ARCHIVE_PATH = path.join(tmp, "archive.jsonl");
  process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(tmp, "operational.jsonl");
  process.env.SETTLEMENT_STORE_PATH = path.join(tmp, "settlements.jsonl");

  try {
    const { createSnapshot, resetSnapshotCache } = await import("@/lib/snapshots/store");
    const { settleFixtureDetailed, loadSettlements } = await import(
      "@/lib/competitions/premier-league/settlement"
    );
    resetSnapshotCache();
    createSnapshot({
      competition: "premier-league",
      season: "2099-00",
      fixtureId: "phase4a-replay-fixture",
      asOf: "2099-01-01T00:00:00.000Z",
      kickoff: "2099-01-02T20:00:00.000Z",
      modelVersion: "phase4a-production",
      predictionStage: "T24H",
      evaluationClass: "LIVE_OOS",
      homeSlug: "home",
      awaySlug: "away",
      home: 0.5,
      draw: 0.3,
      away: 0.2,
      homeExpectedGoals: 1.5,
      awayExpectedGoals: 1,
      scorelineDistribution: {},
    });
    const fixture = {
      id: "phase4a-replay-fixture",
      competition: "premier-league" as const,
      season: "2099-00",
      date: "2099-01-02",
      kickoff: "2099-01-02T20:00:00.000Z",
      kickoffUtc: "2099-01-02T20:00:00.000Z",
      homeSlug: "home",
      awaySlug: "away",
      homeGoals: 2,
      awayGoals: 0,
      status: "FINISHED" as const,
      venue: "home" as const,
      source: "phase4a-test",
    };
    const first = settleFixtureDetailed(fixture, "2099-01-02T22:00:00.000Z", {
      evaluationClass: "LIVE_OOS",
      verificationId: "phase4a-first",
    });
    const replay = settleFixtureDetailed(fixture, "2099-01-02T23:00:00.000Z", {
      evaluationClass: "LIVE_OOS",
      verificationId: "phase4a-replay",
    });
    check("first settlement pass reports one inserted record", first.inserted.length === 1 && first.existing.length === 0);
    check("repeated settlement pass reports replay, not another write", replay.inserted.length === 0 && replay.existing.length === 1);
    check("repeated settlement pass keeps one persisted row", loadSettlements().length === 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void replayGate()
  .then(() => {
    console.log(`\nPhase 4A ledger metrics: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
