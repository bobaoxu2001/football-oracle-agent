/**
 * Phase 4B0 observational model-vs-market benchmark.
 *
 * Pure and read-only: no forecasting-engine import and no store writes.
 */

import type { Fixture } from "@/lib/identity/types";
import { brier3, rps3 } from "@/lib/evaluation/metrics";
import type { Outcome } from "@/lib/evaluation/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import {
  canonicalizePredictionStage,
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
} from "@/lib/snapshots/types";
import {
  assessEvaluationMaturity,
  type EvaluationMaturityAssessment,
} from "@/lib/evaluation/evidence-integrity";
import type { SettlementRecord } from "../settlement";
import {
  validateProductionForecastSnapshot,
  type ForecastFreshnessSnapshotInput,
} from "../ops/production-freshness";
import type { MarketConsensusSnapshot } from "./types";
import { MARKET_SCHEMA_VERSION, MARKET_TYPE_H2H } from "./types";

export const MARKET_BENCHMARK_SCHEMA_VERSION = "market-benchmark-v0.1.0";
export const MARKET_BENCHMARK_MIN_BOOKMAKERS = 3;
export const MARKET_BENCHMARK_MARGIN_CAUTION = 0.25;

export type MarketBenchmarkStatus =
  | "NO_ALIGNED_EVIDENCE"
  | "ALIGNED_EVIDENCE_NO_SETTLED"
  | "EARLY_EVIDENCE"
  | "PROVISIONAL"
  | "EVALUATION_READY";

export type ConsensusRejectionReason =
  | "WRONG_ORIGIN"
  | "WRONG_SCHEMA"
  | "WRONG_MARKET_TYPE"
  | "INVALID_TIMESTAMP"
  | "AFTER_MODEL_CUTOFF"
  | "NOT_PREKICK"
  | "COMPUTED_BEFORE_RETRIEVAL"
  | "INSUFFICIENT_BOOKMAKERS"
  | "INVALID_PROBABILITIES";

export type MarketQualityFlag =
  | "HIGH_MAX_BOOKMAKER_MARGIN"
  | "NEGATIVE_MIN_BOOKMAKER_MARGIN";

export interface MarketBenchmarkPair {
  fixtureId: string;
  home: string;
  away: string;
  kickoffUtc: string;
  fixtureStatus: string;
  forecast: {
    snapshotKey: string;
    stage: string;
    cutoffAt: string;
    generatedAt: string;
    modelVersion: string;
    home: number;
    draw: number;
    away: number;
  };
  market: {
    consensusId: string;
    retrievedAt: string;
    source: string;
    method: string;
    bookmakerCount: number;
    home: number;
    draw: number;
    away: number;
    marginMin: number;
    marginMax: number;
    lagToForecastCutoffMs: number;
    qualityFlags: MarketQualityFlag[];
  };
  comparison: {
    totalVariationDistance: number;
    favouriteAgrees: boolean;
    settled: boolean;
    actualOutcome: Outcome | null;
  };
}

export interface MarketBenchmarkPerformance {
  reportingAllowed: boolean;
  reportingReason: string;
  model: { brier: number | null; rps: number | null; logLoss: number | null };
  market: { brier: number | null; rps: number | null; logLoss: number | null };
  modelMinusMarket: { brier: number | null; rps: number | null; logLoss: number | null };
}

export interface MarketBenchmarkReport {
  schemaVersion: typeof MARKET_BENCHMARK_SCHEMA_VERSION;
  generatedAt: string;
  status: MarketBenchmarkStatus;
  observationalOnly: true;
  affectsProductionForecast: false;
  independentUnit: "fixture";
  aggregationUnit: "latest_valid_production_snapshot_per_fixture_aligned_at_cutoff";
  temporalRule: "market.retrievedAt <= forecast.cutoffAt < kickoffUtc";
  definitions: {
    alignedFixture: string;
    settledAlignedFixture: string;
    consensus: string;
    qualityCaution: string;
    performanceGate: string;
  };
  counts: {
    productionSnapshotsConsidered: number;
    productionSnapshotsRejected: number;
    latestValidProductionFixtures: number;
    marketConsensusSnapshotsConsidered: number;
    alignedUniqueFixtures: number;
    settledAlignedUniqueFixtures: number;
    conflictingSettlementFixtures: number;
  };
  consensusRejections: Record<ConsensusRejectionReason, number>;
  maturity: EvaluationMaturityAssessment;
  performance: MarketBenchmarkPerformance;
  pairs: MarketBenchmarkPair[];
}

function fixtureKickoff(fixture: Fixture): string | null {
  return fixture.kickoffUtc ?? fixture.kickoff ?? null;
}

function snapshotInput(snapshot: PredictionSnapshot): ForecastFreshnessSnapshotInput {
  return {
    snapshotId: snapshot.provenance.uniqueKey,
    fixtureId: snapshot.fixtureId,
    modelRole: "production",
    modelVersion: snapshot.modelVersion,
    evaluationClass: snapshot.evaluationClass ?? null,
    predictionStage: String(snapshot.predictionStage),
    kickoffUtc: snapshot.kickoff,
    cutoffAt: snapshot.asOf,
    generatedAt: effectiveSnapshotGeneratedAt(snapshot),
    latestIncludedInputAt: effectiveSnapshotLatestIncludedInputAt(snapshot),
  };
}

function probabilityTripletIsValid(row: MarketConsensusSnapshot): boolean {
  const values = [row.fairHome, row.fairDraw, row.fairAway];
  return (
    values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9
  );
}

export function consensusRejectionReasons(input: {
  consensus: MarketConsensusSnapshot;
  forecastCutoffAt: string;
  kickoffUtc: string;
}): ConsensusRejectionReason[] {
  const { consensus, forecastCutoffAt, kickoffUtc } = input;
  const reasons: ConsensusRejectionReason[] = [];
  const retrieved = Date.parse(consensus.retrievedAt);
  const computed = Date.parse(consensus.computedAt);
  const cutoff = Date.parse(forecastCutoffAt);
  const kickoff = Date.parse(kickoffUtc);
  if (consensus.origin !== "LIVE_RECORDED") reasons.push("WRONG_ORIGIN");
  if (consensus.marketSchemaVersion !== MARKET_SCHEMA_VERSION) reasons.push("WRONG_SCHEMA");
  if (consensus.marketType !== MARKET_TYPE_H2H) reasons.push("WRONG_MARKET_TYPE");
  if (![retrieved, computed, cutoff, kickoff].every(Number.isFinite)) {
    reasons.push("INVALID_TIMESTAMP");
    return reasons;
  }
  if (retrieved > cutoff) reasons.push("AFTER_MODEL_CUTOFF");
  if (retrieved >= kickoff) reasons.push("NOT_PREKICK");
  if (computed < retrieved) reasons.push("COMPUTED_BEFORE_RETRIEVAL");
  if (consensus.bookmakerCount < MARKET_BENCHMARK_MIN_BOOKMAKERS) {
    reasons.push("INSUFFICIENT_BOOKMAKERS");
  }
  if (!probabilityTripletIsValid(consensus)) reasons.push("INVALID_PROBABILITIES");
  return reasons;
}

export function marketQualityFlags(consensus: MarketConsensusSnapshot): MarketQualityFlag[] {
  const flags: MarketQualityFlag[] = [];
  if (consensus.marginMax > MARKET_BENCHMARK_MARGIN_CAUTION) {
    flags.push("HIGH_MAX_BOOKMAKER_MARGIN");
  }
  if (consensus.marginMin < 0) flags.push("NEGATIVE_MIN_BOOKMAKER_MARGIN");
  return flags;
}

function favourite(p: { home: number; draw: number; away: number }): Outcome {
  return p.home >= p.draw && p.home >= p.away
    ? "home"
    : p.away >= p.draw
      ? "away"
      : "draw";
}

function latestSnapshotPerFixture(rows: PredictionSnapshot[]): PredictionSnapshot[] {
  const selected = new Map<string, PredictionSnapshot>();
  for (const row of rows) {
    const current = selected.get(row.fixtureId);
    if (!current) {
      selected.set(row.fixtureId, row);
      continue;
    }
    const cutoffDelta = Date.parse(row.asOf) - Date.parse(current.asOf);
    const generatedDelta =
      Date.parse(effectiveSnapshotGeneratedAt(row)) -
      Date.parse(effectiveSnapshotGeneratedAt(current));
    if (
      cutoffDelta > 0 ||
      (cutoffDelta === 0 && generatedDelta > 0) ||
      (cutoffDelta === 0 &&
        generatedDelta === 0 &&
        row.provenance.uniqueKey.localeCompare(current.provenance.uniqueKey) > 0)
    ) {
      selected.set(row.fixtureId, row);
    }
  }
  return [...selected.values()];
}

function actualOutcomes(rows: SettlementRecord[]): {
  byFixture: Map<string, Outcome>;
  conflicts: Set<string>;
} {
  const byFixture = new Map<string, Outcome>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const prior = byFixture.get(row.fixtureId);
    if (prior && prior !== row.actualOutcome) conflicts.add(row.fixtureId);
    else if (!prior) byFixture.set(row.fixtureId, row.actualOutcome);
  }
  for (const fixtureId of conflicts) byFixture.delete(fixtureId);
  return { byFixture, conflicts };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function performanceOf(pairs: MarketBenchmarkPair[]): MarketBenchmarkPerformance {
  const settled = pairs.filter(
    (pair): pair is MarketBenchmarkPair & { comparison: { actualOutcome: Outcome } } =>
      pair.comparison.settled && pair.comparison.actualOutcome !== null
  );
  const maturity = assessEvaluationMaturity(settled.length);
  if (!maturity.provisionalReportingAllowed) {
    return {
      reportingAllowed: false,
      reportingReason:
        `Withheld until at least ${maturity.thresholds.provisionalMinUniqueFixtures} ` +
        "independent settled fixtures have a time-aligned market consensus.",
      model: { brier: null, rps: null, logLoss: null },
      market: { brier: null, rps: null, logLoss: null },
      modelMinusMarket: { brier: null, rps: null, logLoss: null },
    };
  }
  const scores = settled.map((pair) => {
    const actual = pair.comparison.actualOutcome;
    const model = pair.forecast;
    const market = pair.market;
    const pModel = actual === "home" ? model.home : actual === "draw" ? model.draw : model.away;
    const pMarket = actual === "home" ? market.home : actual === "draw" ? market.draw : market.away;
    return {
      model: {
        brier: brier3(model.home, model.draw, model.away, actual),
        rps: rps3(model.home, model.draw, model.away, actual),
        logLoss: -Math.log(Math.max(1e-12, pModel)),
      },
      market: {
        brier: brier3(market.home, market.draw, market.away, actual),
        rps: rps3(market.home, market.draw, market.away, actual),
        logLoss: -Math.log(Math.max(1e-12, pMarket)),
      },
    };
  });
  const model = {
    brier: mean(scores.map((row) => row.model.brier)),
    rps: mean(scores.map((row) => row.model.rps)),
    logLoss: mean(scores.map((row) => row.model.logLoss)),
  };
  const market = {
    brier: mean(scores.map((row) => row.market.brier)),
    rps: mean(scores.map((row) => row.market.rps)),
    logLoss: mean(scores.map((row) => row.market.logLoss)),
  };
  return {
    reportingAllowed: true,
    reportingReason: `Provisional comparison over ${settled.length} independent settled fixtures.`,
    model,
    market,
    modelMinusMarket: {
      brier: model.brier - market.brier,
      rps: model.rps - market.rps,
      logLoss: model.logLoss - market.logLoss,
    },
  };
}

export function buildMarketBenchmarkReport(input: {
  snapshots: PredictionSnapshot[];
  consensus: MarketConsensusSnapshot[];
  fixtures: Fixture[];
  settlements: SettlementRecord[];
  productionModelVersion: string;
  evaluatedAt: string;
}): MarketBenchmarkReport {
  const fixtureById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture]));
  const production = input.snapshots.filter(
    (snapshot) =>
      snapshot.evaluationClass === "LIVE_OOS" &&
      snapshot.modelVersion === input.productionModelVersion
  );
  const valid: PredictionSnapshot[] = [];
  let rejectedSnapshots = 0;
  for (const snapshot of production) {
    const fixture = fixtureById.get(snapshot.fixtureId);
    const kickoff = fixture ? fixtureKickoff(fixture) : null;
    if (!fixture || !kickoff) {
      rejectedSnapshots += 1;
      continue;
    }
    const validation = validateProductionForecastSnapshot({
      snapshot: snapshotInput(snapshot),
      expectedKickoffUtc: kickoff,
      evaluatedAt: input.evaluatedAt,
    });
    if (!validation.valid) rejectedSnapshots += 1;
    else valid.push(snapshot);
  }

  const latestSnapshots = latestSnapshotPerFixture(valid);
  const consensusByFixture = new Map<string, MarketConsensusSnapshot[]>();
  for (const row of input.consensus) {
    const list = consensusByFixture.get(row.canonicalFixtureId) ?? [];
    list.push(row);
    consensusByFixture.set(row.canonicalFixtureId, list);
  }
  const rejectionKeys: ConsensusRejectionReason[] = [
    "WRONG_ORIGIN",
    "WRONG_SCHEMA",
    "WRONG_MARKET_TYPE",
    "INVALID_TIMESTAMP",
    "AFTER_MODEL_CUTOFF",
    "NOT_PREKICK",
    "COMPUTED_BEFORE_RETRIEVAL",
    "INSUFFICIENT_BOOKMAKERS",
    "INVALID_PROBABILITIES",
  ];
  const rejections = Object.fromEntries(rejectionKeys.map((reason) => [reason, 0])) as Record<
    ConsensusRejectionReason,
    number
  >;
  const outcomes = actualOutcomes(
    input.settlements.filter(
      (row) =>
        row.evaluationClass === "LIVE_OOS" &&
        row.modelVersion === input.productionModelVersion
    )
  );

  const pairs: MarketBenchmarkPair[] = [];
  for (const snapshot of latestSnapshots) {
    const fixture = fixtureById.get(snapshot.fixtureId);
    const kickoff = fixture ? fixtureKickoff(fixture) : null;
    if (!fixture || !kickoff) continue;
    let aligned: MarketConsensusSnapshot | null = null;
    for (const candidate of consensusByFixture.get(snapshot.fixtureId) ?? []) {
      const reasons = consensusRejectionReasons({
        consensus: candidate,
        forecastCutoffAt: snapshot.asOf,
        kickoffUtc: kickoff,
      });
      for (const reason of reasons) rejections[reason] += 1;
      if (reasons.length) continue;
      if (!aligned || candidate.retrievedAt > aligned.retrievedAt) aligned = candidate;
    }
    if (!aligned) continue;
    const modelProb = {
      home: snapshot.homeProbability,
      draw: snapshot.drawProbability,
      away: snapshot.awayProbability,
    };
    const marketProb = {
      home: aligned.fairHome,
      draw: aligned.fairDraw,
      away: aligned.fairAway,
    };
    const actualOutcome = outcomes.byFixture.get(snapshot.fixtureId) ?? null;
    pairs.push({
      fixtureId: snapshot.fixtureId,
      home: snapshot.homeTeam,
      away: snapshot.awayTeam,
      kickoffUtc: kickoff,
      fixtureStatus: String(fixture.status),
      forecast: {
        snapshotKey: snapshot.provenance.uniqueKey,
        stage: canonicalizePredictionStage(snapshot.predictionStage),
        cutoffAt: snapshot.asOf,
        generatedAt: effectiveSnapshotGeneratedAt(snapshot),
        modelVersion: snapshot.modelVersion,
        ...modelProb,
      },
      market: {
        consensusId: aligned.consensusId,
        retrievedAt: aligned.retrievedAt,
        source: aligned.source,
        method: aligned.consensusMethod,
        bookmakerCount: aligned.bookmakerCount,
        ...marketProb,
        marginMin: aligned.marginMin,
        marginMax: aligned.marginMax,
        lagToForecastCutoffMs: Date.parse(snapshot.asOf) - Date.parse(aligned.retrievedAt),
        qualityFlags: marketQualityFlags(aligned),
      },
      comparison: {
        totalVariationDistance:
          (Math.abs(modelProb.home - marketProb.home) +
            Math.abs(modelProb.draw - marketProb.draw) +
            Math.abs(modelProb.away - marketProb.away)) /
          2,
        favouriteAgrees: favourite(modelProb) === favourite(marketProb),
        settled: actualOutcome !== null,
        actualOutcome,
      },
    });
  }
  pairs.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc) || a.fixtureId.localeCompare(b.fixtureId));

  const settledCount = pairs.filter((pair) => pair.comparison.settled).length;
  const maturity = assessEvaluationMaturity(settledCount);
  const status: MarketBenchmarkStatus =
    pairs.length === 0
      ? "NO_ALIGNED_EVIDENCE"
      : settledCount === 0
        ? "ALIGNED_EVIDENCE_NO_SETTLED"
        : maturity.status;

  return {
    schemaVersion: MARKET_BENCHMARK_SCHEMA_VERSION,
    generatedAt: input.evaluatedAt,
    status,
    observationalOnly: true,
    affectsProductionForecast: false,
    independentUnit: "fixture",
    aggregationUnit: "latest_valid_production_snapshot_per_fixture_aligned_at_cutoff",
    temporalRule: "market.retrievedAt <= forecast.cutoffAt < kickoffUtc",
    definitions: {
      alignedFixture:
        "One fixture whose latest valid production snapshot has a qualifying LIVE_RECORDED consensus retrieved no later than that snapshot cutoff.",
      settledAlignedFixture:
        "An aligned fixture with one consistent verified result; the fixture remains one independent sample regardless of snapshot count.",
      consensus:
        `Median of per-bookmaker proportional de-vigged 1X2 probabilities; at least ${MARKET_BENCHMARK_MIN_BOOKMAKERS} bookmakers.`,
      qualityCaution:
        `A contributing maximum bookmaker margin above ${MARKET_BENCHMARK_MARGIN_CAUTION * 100}% is flagged but not silently removed from the robust median.`,
      performanceGate:
        "Public outcome-score comparison is withheld below 20 independent settled aligned fixtures.",
    },
    counts: {
      productionSnapshotsConsidered: production.length,
      productionSnapshotsRejected: rejectedSnapshots,
      latestValidProductionFixtures: latestSnapshots.length,
      marketConsensusSnapshotsConsidered: input.consensus.length,
      alignedUniqueFixtures: pairs.length,
      settledAlignedUniqueFixtures: settledCount,
      conflictingSettlementFixtures: outcomes.conflicts.size,
    },
    consensusRejections: rejections,
    maturity,
    performance: performanceOf(pairs),
    pairs,
  };
}
