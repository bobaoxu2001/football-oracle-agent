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
import { liveSnapshotUniverse } from "./ops/live-snapshot-reader";

export function operationalLiveOosUnion(season = PREMIER_LEAGUE_CURRENT_SEASON): {
  snapshots: PredictionSnapshot[];
  committed: number;
  operational: number;
  total: number;
} {
  return liveSnapshotUniverse(season);
}

/**
 * Snapshots of one evaluation class.
 *
 * `source` selects WHICH LIVE_OOS store answers (it is ignored for the other
 * classes, which only ever live in the committed index):
 *   "union"     — frozen tape + operational archive, deduped (default)
 *   "committed" — the immutable frozen tape only
 *   "index"     — the in-process snapshot index only
 */
export function snapshotsOfClass(
  evaluationClass: EvaluationClass,
  season?: string,
  options: { source?: "committed" | "index" | "union" } = {}
): PredictionSnapshot[] {
  const source = options.source ?? "union";
  if (evaluationClass === "LIVE_OOS" && source === "union") {
    return operationalLiveOosUnion(season).snapshots;
  }
  if (evaluationClass === "LIVE_OOS" && source === "committed") {
    return loadCommittedLiveOos().filter((s) => !season || s.season === season);
  }
  const all = listSnapshots();
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

/**
 * Class counts for the season.
 *
 * `LIVE_OOS` is the deduped union actually scored by
 * {@link livePerformanceReport}; the committed/operational split is reported
 * alongside it so the frozen tape is never confused with working rows.
 */
export function ledgerCounts(season = PREMIER_LEAGUE_CURRENT_SEASON): {
  LIVE_OOS: number;
  liveOosCommitted: number;
  liveOosOperational: number;
  RETROSPECTIVE: number;
  BACKTEST: number;
  rawReferences: number;
  uniqueSnapshots: number;
  duplicatesSuppressed: number;
} {
  const index = snapshotIndexStats();
  const indexed = listSnapshots().filter((s) => !season || s.season === season);
  const union = operationalLiveOosUnion(season);
  return {
    LIVE_OOS: union.total,
    liveOosCommitted: union.committed,
    liveOosOperational: union.operational,
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

export interface StagePerformanceRow {
  stage: CanonicalPredictionStage;
  n: number;
  nSettled: number;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  topPickAccuracy: number | null;
}

export interface LivePerformanceReport {
  season: string;
  evaluationClass: EvaluationClass;
  nPredictions: number;
  nSettled: number;
  nCommitted: number;
  nOperational: number;
  sampleNote: string;
  stages: Record<CanonicalPredictionStage, number>;
  byStage: StagePerformanceRow[];
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
  const union = evaluationClass === "LIVE_OOS" ? operationalLiveOosUnion(season) : null;
  const snaps = snapshotsOfClass(evaluationClass, season, {
    source: evaluationClass === "LIVE_OOS" ? "union" : "index",
  });
  const settled = loadSettlements().filter(
    (s) => s.evaluationClass === evaluationClass && s.season === season
  );
  const nPredictions = snaps.length;
  const nSettled = settled.length;
  const tiny = nSettled < 20;
  const metrics = nSettled ? calculateBacktestMetrics(settlementsToBacktest(settled)) : null;
  const stages = stageBreakdown(snaps);
  const stageOrder: CanonicalPredictionStage[] = [
    "PRESEASON",
    "EARLY",
    "T24H",
    "T2H",
    "T60M",
    "FINAL_PREKICK",
  ];
  const byStage: StagePerformanceRow[] = stageOrder.map((stage) => {
    const rows = settled.filter((s) => canonicalizePredictionStage(s.predictionStage) === stage);
    const m = rows.length ? calculateBacktestMetrics(settlementsToBacktest(rows)) : null;
    return {
      stage,
      n: stages[stage],
      nSettled: rows.length,
      brier: rows.length ? m!.brierScore : null,
      rps: rows.length ? m!.rps : null,
      logLoss: rows.length ? m!.logLoss : null,
      topPickAccuracy: rows.length ? m!.accuracy1x2 : null,
    };
  });
  return {
    season,
    evaluationClass,
    nPredictions,
    nSettled,
    nCommitted: union?.committed ?? nPredictions,
    nOperational: union?.operational ?? 0,
    stages,
    byStage,
    sampleNote: tiny
      ? `Sample size is ${nSettled}. Do not draw impressive-looking conclusions from so few settled matches. Sample too small for meaningful calibration assessment.`
      : `Settled sample ${nSettled} of ${nPredictions} ${evaluationClass} snapshots.`,
    brier: nSettled === 0 || tiny ? null : metrics!.brierScore,
    rps: nSettled === 0 || tiny ? null : metrics!.rps,
    logLoss: nSettled === 0 || tiny ? null : metrics!.logLoss,
    confidenceEce: metrics && nSettled >= 20 ? metrics.confidenceEce : null,
    pooledReliabilityMae: metrics && nSettled >= 20 ? metrics.pooledReliabilityMae : null,
    topPickAccuracy: nSettled === 0 || tiny ? null : metrics!.accuracy1x2,
  };
}

export function fixtureLiveView(fixtureId: string, season = PREMIER_LEAGUE_CURRENT_SEASON) {
  const snaps = operationalLiveOosUnion(season).snapshots.filter((s) => s.fixtureId === fixtureId);
  const settlements = loadSettlements().filter((s) => s.fixtureId === fixtureId);
  const byStage: Record<string, { snapshot: PredictionSnapshot | null; settlement: SettlementRecord | null }> = {};
  for (const stage of ["PRESEASON", "EARLY", "T24H", "T2H", "T60M", "FINAL_PREKICK"] as const) {
    const snapshot = snaps.find((s) => canonicalizePredictionStage(s.predictionStage) === stage) ?? null;
    const settlement = snapshot
      ? settlements.find((x) => x.snapshotUniqueKey === snapshot.provenance.uniqueKey) ?? null
      : null;
    byStage[stage] = { snapshot, settlement };
  }
  return { fixtureId, season, snapshots: snaps, settlements, byStage };
}
