/** Phase 4B0 gates: time-aligned observational benchmark only. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Fixture } from "@/lib/identity/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import type { MarketConsensusSnapshot } from "@/lib/competitions/premier-league/market/types";
import {
  buildMarketBenchmarkReport,
  MARKET_BENCHMARK_SCHEMA_VERSION,
} from "@/lib/competitions/premier-league/market/benchmark";

const MODEL = "pl-live-v0.2.0";
const KICKOFF = "2026-09-01T12:00:00.000Z";
const CUTOFF = "2026-08-31T12:00:00.000Z";
const EVALUATED = "2026-09-02T12:00:00.000Z";
const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const TAPE_SHA256 = "a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da";

function fixture(id: string): Fixture {
  return {
    id,
    competition: "premier-league",
    season: "2026-27",
    date: "2026-09-01",
    kickoff: KICKOFF,
    kickoffUtc: KICKOFF,
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    status: "FINISHED",
    homeGoals: 2,
    awayGoals: 1,
    venue: "home",
    source: "test",
  } as Fixture;
}

function snapshot(
  fixtureId: string,
  options: {
    cutoff?: string;
    generatedAt?: string;
    stage?: "EARLY" | "T24H";
    modelVersion?: string;
    evaluationClass?: "LIVE_OOS" | "RETROSPECTIVE";
    probabilities?: [number, number, number];
  } = {}
): PredictionSnapshot {
  const cutoff = options.cutoff ?? CUTOFF;
  const generatedAt = options.generatedAt ?? cutoff;
  const stage = options.stage ?? "T24H";
  const [home, draw, away] = options.probabilities ?? [0.5, 0.3, 0.2];
  const modelVersion = options.modelVersion ?? MODEL;
  const key = `premier-league::2026-27::${fixtureId}::${modelVersion}::${stage}::${cutoff}`;
  return {
    competition: "premier-league",
    season: "2026-27",
    fixtureId,
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoff: KICKOFF,
    createdAt: generatedAt,
    asOf: cutoff,
    dataCutoff: cutoff,
    modelVersion,
    predictionStage: stage,
    evaluationClass: options.evaluationClass ?? "LIVE_OOS",
    homeProbability: home,
    drawProbability: draw,
    awayProbability: away,
    homeGoalExpectation: 1.5,
    awayGoalExpectation: 1,
    scorelineDistribution: {},
    modelParameters: {},
    sourceState: { origin: "scheduled", computedAt: generatedAt },
    provenance: { store: "memory", uniqueKey: key, notes: "test" },
    market: null,
    home,
    draw,
    away,
    homeExpectedGoals: 1.5,
    awayExpectedGoals: 1,
  };
}

function consensus(
  fixtureId: string,
  retrievedAt: string,
  options: { books?: number; marginMax?: number; probabilities?: [number, number, number] } = {}
): MarketConsensusSnapshot {
  const [home, draw, away] = options.probabilities ?? [0.45, 0.3, 0.25];
  return {
    consensusId: `consensus::${fixtureId}::${retrievedAt}`,
    marketSchemaVersion: "market-recorder-v0.1.0",
    origin: "LIVE_RECORDED",
    source: "the-odds-api",
    canonicalFixtureId: fixtureId,
    marketType: "h2h",
    retrievedAt,
    computedAt: retrievedAt,
    pollJobId: `poll::${retrievedAt}`,
    bookmakerCount: options.books ?? 10,
    consensusMethod: "median-fair-v1",
    fairHome: home,
    fairDraw: draw,
    fairAway: away,
    marginMin: 0.02,
    marginMax: options.marginMax ?? 0.08,
    dispersionHome: { min: home, max: home, stdev: 0, iqr: 0 },
    dispersionDraw: { min: draw, max: draw, stdev: 0, iqr: 0 },
    dispersionAway: { min: away, max: away, stdev: 0, iqr: 0 },
  };
}

function settlement(fixtureId: string, outcome: "home" | "draw" | "away" = "home"): SettlementRecord {
  return {
    snapshotUniqueKey: snapshot(fixtureId).provenance.uniqueKey,
    fixtureId,
    season: "2026-27",
    modelVersion: MODEL,
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    settledAt: EVALUATED,
    actualOutcome: outcome,
    actualScore: { home: outcome === "home" ? 2 : 1, away: outcome === "away" ? 2 : 1 },
    predicted: { home: 0.5, draw: 0.3, away: 0.2 },
    brier: 0,
    rps: 0,
    logLoss: 0,
    topPickCorrect: outcome === "home",
  };
}

function report(input: {
  snapshots: PredictionSnapshot[];
  consensus: MarketConsensusSnapshot[];
  fixtures: Fixture[];
  settlements?: SettlementRecord[];
}) {
  return buildMarketBenchmarkReport({
    ...input,
    settlements: input.settlements ?? [],
    productionModelVersion: MODEL,
    evaluatedAt: EVALUATED,
  });
}

const id = "pl-2026-27-arsenal-chelsea";
const inputSnapshots = [
  snapshot(id, {
    cutoff: "2026-08-30T12:00:00.000Z",
    generatedAt: "2026-08-30T12:00:00.000Z",
    stage: "EARLY",
  }),
  snapshot(id),
  snapshot(id, { generatedAt: "2026-08-31T11:59:59.000Z" }),
  snapshot(id, { modelVersion: "shadow-v1" }),
  snapshot(id, { evaluationClass: "RETROSPECTIVE" }),
];
const inputConsensus = [
  consensus(id, "2026-08-31T11:00:00.000Z"),
  consensus(id, "2026-08-31T11:55:00.000Z", { marginMax: 0.5 }),
  consensus(id, "2026-08-31T11:59:00.000Z", { books: 2 }),
  consensus(id, "2026-08-31T12:01:00.000Z"),
];
const frozenInput = JSON.stringify({ inputSnapshots, inputConsensus });
const one = report({
  snapshots: inputSnapshots,
  consensus: inputConsensus,
  fixtures: [fixture(id)],
  settlements: [settlement(id)],
});

assert.equal(one.schemaVersion, MARKET_BENCHMARK_SCHEMA_VERSION);
assert.equal(one.observationalOnly, true);
assert.equal(one.affectsProductionForecast, false);
assert.equal(one.counts.productionSnapshotsConsidered, 3, "shadow and retrospective must be isolated");
assert.equal(one.counts.productionSnapshotsRejected, 1, "generated-before-cutoff row must be retained but rejected");
assert.equal(one.counts.latestValidProductionFixtures, 1, "multiple snapshots cannot inflate fixture N");
assert.equal(one.counts.marketConsensusSnapshotsStored, 4);
assert.equal(one.counts.alignedUniqueFixtures, 1);
assert.equal(one.counts.fixturesWithoutAlignedConsensus, 0);
assert.equal(one.counts.settledAlignedUniqueFixtures, 1);
assert.equal(one.pairs[0].market.retrievedAt, "2026-08-31T11:55:00.000Z");
assert.equal(one.pairs[0].market.lagToForecastCutoffMs, 5 * 60_000);
assert.deepEqual(one.pairs[0].market.qualityFlags, ["HIGH_MAX_BOOKMAKER_MARGIN"]);
assert.equal(one.consensusRejections.AFTER_MODEL_CUTOFF, 1, "future market print must be rejected");
assert.equal(one.consensusRejections.INSUFFICIENT_BOOKMAKERS, 1);
assert.equal(one.performance.reportingAllowed, false, "one settled fixture is early evidence");
assert.equal(one.performance.model.brier, null, "withheld performance cannot leak a point estimate");
assert.equal(JSON.stringify({ inputSnapshots, inputConsensus }), frozenInput, "benchmark must not mutate inputs");

const futureOnly = report({
  snapshots: [snapshot(id)],
  consensus: [consensus(id, "2026-08-31T12:00:00.001Z")],
  fixtures: [fixture(id)],
});
assert.equal(futureOnly.status, "NO_ALIGNED_EVIDENCE");
assert.equal(futureOnly.counts.alignedUniqueFixtures, 0);
assert.equal(futureOnly.counts.fixturesWithoutAlignedConsensus, 1);

const fixtures20 = Array.from({ length: 20 }, (_, index) => fixture(`fixture-${index}`));
const provisional = report({
  fixtures: fixtures20,
  snapshots: fixtures20.map((row) => snapshot(row.id)),
  consensus: fixtures20.map((row) => consensus(row.id, "2026-08-31T11:55:00.000Z")),
  settlements: fixtures20.map((row) => settlement(row.id)),
});
assert.equal(provisional.status, "PROVISIONAL");
assert.equal(provisional.counts.settledAlignedUniqueFixtures, 20);
assert.equal(provisional.performance.reportingAllowed, true);
assert.ok(provisional.performance.model.brier !== null);
assert.ok(provisional.performance.market.brier !== null);

const source = fs.readFileSync(
  path.resolve("lib/competitions/premier-league/market/benchmark.ts"),
  "utf8"
);
assert.doesNotMatch(source, /prediction-engine\/league-engine|snapshotPremierLeagueMatch/);
assert.equal(createHash("sha256").update(fs.readFileSync(TAPE)).digest("hex"), TAPE_SHA256);

console.log("Phase 4B0 market benchmark: PASS (time alignment, fixture grain, quality caution, reporting gate, isolation)");
