/**
 * Premier League production 2026-27 ledger.
 *
 * BACKTEST, RETROSPECTIVE, and LIVE_OOS must never mix in evaluation queries.
 */

import {
  listSnapshots,
  loadCommittedLiveOos,
  type PredictionSnapshot,
} from "@/lib/snapshots/store";
import type { CanonicalPredictionStage, EvaluationClass } from "@/lib/snapshots/types";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import { calculateBacktestMetrics } from "@/lib/evaluation/metrics";
import type { BacktestResult, Outcome } from "@/lib/evaluation/types";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { listLiveSnapshots, liveSnapshotUniverse } from "./ops/live-snapshot-reader";
import { productionModelVersion } from "./shadow/track";
import { canonicalLedgerMetrics } from "./ledger-metrics";

function productionOnly(snapshots: PredictionSnapshot[]): PredictionSnapshot[] {
  const version = productionModelVersion();
  return snapshots.filter((snapshot) => snapshot.modelVersion === version);
}

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
  return canonicalLedgerMetrics(season).production.totalForecastSnapshots;
}

export function stageBreakdown(
  snaps: PredictionSnapshot[]
): Record<CanonicalPredictionStage, number> {
  const out: Record<CanonicalPredictionStage, number> = {
    HISTORICAL: 0,
    PRESEASON: 0,
    EARLY: 0,
    T7D: 0,
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
  productionForecastSnapshots: number;
  productionSettledForecastSnapshots: number;
  productionUniqueSettledFixtures: number;
  allTrackForecastSnapshots: number;
  allTrackSettledForecastSnapshots: number;
  /** @deprecated Use productionForecastSnapshots. */
  LIVE_OOS: number;
  /** @deprecated Use canonicalLedgerMetrics().production.committedForecastSnapshots. */
  liveOosCommitted: number;
  /** @deprecated Use canonicalLedgerMetrics().production.operationalForecastSnapshots. */
  liveOosOperational: number;
  RETROSPECTIVE: number;
  BACKTEST: number;
} {
  const indexed = listSnapshots().filter((s) => !season || s.season === season);
  const canonical = canonicalLedgerMetrics(season);
  return {
    productionForecastSnapshots: canonical.production.totalForecastSnapshots,
    productionSettledForecastSnapshots: canonical.production.settledForecastSnapshots,
    productionUniqueSettledFixtures: canonical.production.uniqueFixturesSettled,
    allTrackForecastSnapshots: canonical.allTracks.totalForecastSnapshots,
    allTrackSettledForecastSnapshots: canonical.allTracks.settledForecastSnapshots,
    LIVE_OOS: canonical.production.totalForecastSnapshots,
    liveOosCommitted: canonical.production.committedForecastSnapshots,
    liveOosOperational: canonical.production.operationalForecastSnapshots,
    RETROSPECTIVE: indexed.filter((s) => s.evaluationClass === "RETROSPECTIVE").length,
    BACKTEST: indexed.filter((s) => s.evaluationClass === "BACKTEST").length,
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
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  /** @deprecated Use totalForecastSnapshots. */
  n: number;
  /** @deprecated Use settledForecastSnapshots. */
  nSettled: number;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  topPickAccuracy: number | null;
}

export interface LivePerformanceReport {
  season: string;
  evaluationClass: EvaluationClass;
  aggregationUnit: "forecast_snapshot";
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  uniqueFixturesForecast: number;
  uniqueFixturesSettled: number;
  /** @deprecated Use totalForecastSnapshots. */
  nPredictions: number;
  /** @deprecated Use settledForecastSnapshots. */
  nSettled: number;
  /** @deprecated Use canonical ledger metrics. */
  nCommitted: number;
  /** @deprecated Use canonical ledger metrics. */
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
  const canonical = evaluationClass === "LIVE_OOS" ? canonicalLedgerMetrics(season) : null;
  const allSnapshots =
    evaluationClass === "LIVE_OOS"
      ? listLiveSnapshots({ season, evaluationClass: "LIVE_OOS" })
      : snapshotsOfClass(evaluationClass, season, { source: "index" });
  const snaps = evaluationClass === "LIVE_OOS" ? productionOnly(allSnapshots) : allSnapshots;
  const snapshotKeys = new Set(snaps.map((snapshot) => snapshot.provenance.uniqueKey));
  const settled = loadSettlements().filter(
    (s) =>
      s.evaluationClass === evaluationClass &&
      s.season === season &&
      (evaluationClass !== "LIVE_OOS" || s.modelVersion === productionModelVersion()) &&
      snapshotKeys.has(s.snapshotUniqueKey)
  );
  const nPredictions = canonical?.production.totalForecastSnapshots ?? snaps.length;
  const nSettled = canonical?.production.settledForecastSnapshots ?? settled.length;
  const uniqueFixturesForecast =
    canonical?.production.uniqueFixturesForecast ?? new Set(snaps.map((s) => s.fixtureId)).size;
  const uniqueFixturesSettled =
    canonical?.production.uniqueFixturesSettled ?? new Set(settled.map((s) => s.fixtureId)).size;
  // Multiple stage snapshots settle against the same match outcome. Use unique
  // fixtures for the sample-size gate so 38 snapshot rows from ten matches do
  // not masquerade as 38 independent observations.
  const tiny = uniqueFixturesSettled < 20;
  const metrics = nSettled ? calculateBacktestMetrics(settlementsToBacktest(settled)) : null;
  const stages = stageBreakdown(snaps);
  const stageOrder: CanonicalPredictionStage[] = [
    "PRESEASON",
    "EARLY",
    "T7D",
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
      totalForecastSnapshots: stages[stage],
      settledForecastSnapshots: rows.length,
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
    aggregationUnit: "forecast_snapshot",
    totalForecastSnapshots: nPredictions,
    settledForecastSnapshots: nSettled,
    uniqueFixturesForecast,
    uniqueFixturesSettled,
    nPredictions,
    nSettled,
    nCommitted:
      canonical
        ? canonical.production.committedForecastSnapshots
        : nPredictions,
    nOperational:
      canonical
        ? canonical.production.operationalForecastSnapshots
        : 0,
    stages,
    byStage,
    sampleNote: tiny
      ? `Sample size is ${nSettled} settled forecast snapshots across ${uniqueFixturesSettled} unique fixtures. Headline aggregate metrics remain withheld until 20 unique fixtures have settled.`
      : `Settled sample ${nSettled} of ${nPredictions} ${evaluationClass} forecast snapshots across ${uniqueFixturesSettled} unique fixtures.`,
    brier: nSettled === 0 || tiny ? null : metrics!.brierScore,
    rps: nSettled === 0 || tiny ? null : metrics!.rps,
    logLoss: nSettled === 0 || tiny ? null : metrics!.logLoss,
    confidenceEce: metrics && uniqueFixturesSettled >= 20 ? metrics.confidenceEce : null,
    pooledReliabilityMae:
      metrics && uniqueFixturesSettled >= 20 ? metrics.pooledReliabilityMae : null,
    topPickAccuracy: nSettled === 0 || tiny ? null : metrics!.accuracy1x2,
  };
}

export interface PublicStagePerformanceRow {
  stage: CanonicalPredictionStage;
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  topPickAccuracy: number | null;
}

export type PublicLivePerformanceReport = Omit<
  LivePerformanceReport,
  "nPredictions" | "nSettled" | "nCommitted" | "nOperational" | "byStage"
> & {
  committedForecastSnapshots: number;
  operationalForecastSnapshots: number;
  byStage: PublicStagePerformanceRow[];
};

/** Remove ambiguous legacy count aliases from public JSON contracts. */
export function publicLivePerformanceReport(
  report: LivePerformanceReport
): PublicLivePerformanceReport {
  const {
    nPredictions: _nPredictions,
    nSettled: _nSettled,
    nCommitted,
    nOperational,
    byStage,
    ...explicit
  } = report;
  return {
    ...explicit,
    committedForecastSnapshots: nCommitted,
    operationalForecastSnapshots: nOperational,
    byStage: byStage.map(
      ({ n: _n, nSettled: _nSettledStage, ...row }) => row
    ),
  };
}

export function fixtureLiveView(fixtureId: string, season = PREMIER_LEAGUE_CURRENT_SEASON) {
  const snaps = productionOnly(
    operationalLiveOosUnion(season).snapshots.filter((s) => s.fixtureId === fixtureId)
  ).sort(
    (a, b) =>
      a.asOf.localeCompare(b.asOf) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.provenance.uniqueKey.localeCompare(b.provenance.uniqueKey)
  );
  const settlements = loadSettlements().filter(
    (s) => s.fixtureId === fixtureId && s.modelVersion === productionModelVersion()
  );
  const byStage: Record<string, { snapshot: PredictionSnapshot | null; settlement: SettlementRecord | null }> = {};
  for (const stage of [
    "PRESEASON",
    "EARLY",
    "T7D",
    "T24H",
    "T2H",
    "T60M",
    "FINAL_PREKICK",
  ] as const) {
    const snapshot =
      snaps.filter((s) => canonicalizePredictionStage(s.predictionStage) === stage).at(-1) ?? null;
    const settlement = snapshot
      ? settlements.find((x) => x.snapshotUniqueKey === snapshot.provenance.uniqueKey) ?? null
      : null;
    byStage[stage] = { snapshot, settlement };
  }
  return { fixtureId, season, snapshots: snaps, settlements, byStage };
}
