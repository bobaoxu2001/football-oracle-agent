/**
 * Genuine live 2026-27 ledger.
 *
 * BACKTEST, RETROSPECTIVE, and LIVE_OOS must never mix in evaluation queries.
 */

import { listSnapshots, type PredictionSnapshot } from "@/lib/snapshots/store";
import type { EvaluationClass } from "@/lib/snapshots/types";
import { calculateBacktestMetrics } from "@/lib/evaluation/metrics";
import type { BacktestResult, Outcome } from "@/lib/evaluation/types";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";

export function snapshotsOfClass(evaluationClass: EvaluationClass, season?: string): PredictionSnapshot[] {
  return listSnapshots().filter((s) => {
    if ((s.evaluationClass ?? null) !== evaluationClass) return false;
    if (season && s.season !== season) return false;
    return true;
  });
}

export function liveOosCount(season = PREMIER_LEAGUE_CURRENT_SEASON): number {
  return snapshotsOfClass("LIVE_OOS", season).length;
}

export function ledgerCounts(season = PREMIER_LEAGUE_CURRENT_SEASON): {
  LIVE_OOS: number;
  RETROSPECTIVE: number;
  BACKTEST: number;
} {
  const all = listSnapshots().filter((s) => !season || s.season === season);
  return {
    LIVE_OOS: all.filter((s) => s.evaluationClass === "LIVE_OOS").length,
    RETROSPECTIVE: all.filter((s) => s.evaluationClass === "RETROSPECTIVE").length,
    BACKTEST: all.filter((s) => s.evaluationClass === "BACKTEST").length,
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
  const snaps = snapshotsOfClass(evaluationClass, season);
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
    sampleNote: tiny
      ? `Sample size is ${nSettled}. Do not draw impressive-looking conclusions from so few settled matches.`
      : `Settled sample ${nSettled} of ${nPredictions} ${evaluationClass} snapshots.`,
    brier: metrics && !tiny ? metrics.brierScore : metrics ? metrics.brierScore : null,
    rps: metrics ? metrics.rps : null,
    logLoss: metrics ? metrics.logLoss : null,
    confidenceEce: metrics && nSettled >= 20 ? metrics.confidenceEce : null,
    pooledReliabilityMae: metrics && nSettled >= 20 ? metrics.pooledReliabilityMae : null,
    topPickAccuracy: metrics ? metrics.accuracy1x2 : null,
  };
}
