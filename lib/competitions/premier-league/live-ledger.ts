/**
 * Genuine live 2026-27 ledger.
 *
 * BACKTEST, RETROSPECTIVE, and LIVE_OOS must never mix in evaluation queries.
 */

import {
  listSnapshots,
  loadCommittedLiveOos,
  snapshotIndexStats,
  type PredictionSnapshot,
} from "@/lib/snapshots/store";
import type { CanonicalPredictionStage, EvaluationClass } from "@/lib/snapshots/types";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import { calculateBacktestMetrics } from "@/lib/evaluation/metrics";
import type { BacktestResult, Outcome } from "@/lib/evaluation/types";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";

export function snapshotsOfClass(
  evaluationClass: EvaluationClass,
  season?: string,
  options: { source?: "committed" | "index" } = {}
): PredictionSnapshot[] {
  const all =
    evaluationClass === "LIVE_OOS" && options.source !== "index"
      ? loadCommittedLiveOos()
      : listSnapshots();
  return all.filter((s) => {
    if ((s.evaluationClass ?? null) !== evaluationClass) return false;
    if (season && s.season !== season) return false;
    return true;
  });
}

export function liveOosCount(season = PREMIER_LEAGUE_CURRENT_SEASON): number {
  return snapshotsOfClass("LIVE_OOS", season).length;
}

export function stageBreakdown(
  snaps: PredictionSnapshot[]
): Record<CanonicalPredictionStage, number> {
  const out: Record<CanonicalPredictionStage, number> = {
    HISTORICAL: 0,
    PRESEASON: 0,
    EARLY: 0,
    T24H: 0,
    T2H: 0,
    T60M: 0,
    FINAL_PREKICK: 0,
    RETROSPECTIVE: 0,
  };
  for (const s of snaps) out[canonicalizePredictionStage(s.predictionStage)] += 1;
  return out;
}

export function ledgerCounts(season = PREMIER_LEAGUE_CURRENT_SEASON): {
  LIVE_OOS: number;
  RETROSPECTIVE: number;
  BACKTEST: number;
  rawReferences: number;
  uniqueSnapshots: number;
  duplicatesSuppressed: number;
} {
  const index = snapshotIndexStats();
  const indexed = listSnapshots().filter((s) => !season || s.season === season);
  return {
    LIVE_OOS: snapshotsOfClass("LIVE_OOS", season, { source: "committed" }).length,
    RETROSPECTIVE: indexed.filter((s) => s.evaluationClass === "RETROSPECTIVE").length,
    BACKTEST: indexed.filter((s) => s.evaluationClass === "BACKTEST").length,
    rawReferences: index.rawReferences,
    uniqueSnapshots: index.uniqueSnapshots,
    duplicatesSuppressed: index.duplicatesSuppressed,
  };
}

function settlementsToBacktest(rows: SettlementRecord[]): BacktestResult[] {
  return rows.map((r) => {
    const actual: Outcome = r.actualOutcome;
    const predicted: Outcome =
      r.predicted.home >= r.predicted.draw && r.predicted.home >= r.predicted.away
        ? "home"
        : r.predicted.away >= r.predicted.draw
          ? "away"
          : "draw";
    return {
      match: {
        id: r.fixtureId,
        date: r.settledAt.slice(0, 10),
        season: r.season,
        homeSlug: "",
        awaySlug: "",
        homeGoals: r.actualScore.home,
        awayGoals: r.actualScore.away,
        competition: "premier league",
      },
      prediction: {
        winHome: r.predicted.home,
        draw: r.predicted.draw,
        winAway: r.predicted.away,
        expectedGoalsHome: 0,
        expectedGoalsAway: 0,
        mostLikelyScore: { home: 0, away: 0 },
      },
      asOf: r.settledAt,
      dataCutoff: r.settledAt,
      modelVersion: r.modelVersion,
      actual,
      predicted,
      correct1x2: predicted === actual,
      exactScore: false,
      top3Score: false,
      probAssignedToActual:
        actual === "home" ? r.predicted.home : actual === "draw" ? r.predicted.draw : r.predicted.away,
    };
  });
}

export interface LivePerformanceReport {
  season: string;
  evaluationClass: EvaluationClass;
  nPredictions: number;
  nSettled: number;
  sampleNote: string;
  stages: Record<CanonicalPredictionStage, number>;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  confidenceEce: number | null;
  pooledReliabilityMae: number | null;
  topPickAccuracy: number | null;
}

export function livePerformanceReport(
  evaluationClass: EvaluationClass = "LIVE_OOS",
  season = PREMIER_LEAGUE_CURRENT_SEASON
): LivePerformanceReport {
  const snaps = snapshotsOfClass(evaluationClass, season, {
    source: evaluationClass === "LIVE_OOS" ? "committed" : "index",
  });
  const settled = loadSettlements().filter(
    (s) => s.evaluationClass === evaluationClass && s.season === season
  );
  const nPredictions = snaps.length;
  const nSettled = settled.length;
  const tiny = nSettled < 20;
  const metrics = nSettled ? calculateBacktestMetrics(settlementsToBacktest(settled)) : null;
  return {
    season,
    evaluationClass,
    nPredictions,
    nSettled,
    stages: stageBreakdown(snaps),
    sampleNote: tiny
      ? `Sample size is ${nSettled}. Do not draw impressive-looking conclusions from so few settled matches.`
      : `Settled sample ${nSettled} of ${nPredictions} ${evaluationClass} snapshots.`,
    brier: nSettled === 0 || tiny ? null : metrics!.brierScore,
    rps: nSettled === 0 || tiny ? null : metrics!.rps,
    logLoss: nSettled === 0 || tiny ? null : metrics!.logLoss,
    confidenceEce: metrics && nSettled >= 20 ? metrics.confidenceEce : null,
    pooledReliabilityMae: metrics && nSettled >= 20 ? metrics.pooledReliabilityMae : null,
    topPickAccuracy: nSettled === 0 || tiny ? null : metrics!.accuracy1x2,
  };
}
