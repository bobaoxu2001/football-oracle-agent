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
import {
  canonicalizePredictionStage,
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
  parseSnapshotUniqueKey,
} from "@/lib/snapshots/types";
import { calculateBacktestMetrics } from "@/lib/evaluation/metrics";
import { validateSettlementSnapshotConsistency } from "@/lib/evaluation/settlement-integrity";
import type { BacktestResult, Outcome } from "@/lib/evaluation/types";
import {
  assessEvaluationMaturity,
  fixtureClusterBootstrap,
  publishFixtureClusterBootstrap,
  selectLatestValidPreKickByFixture,
  selectLatestValidPreKickByFixtureStage,
  type EvaluationMaturityAssessment,
  type FixtureClusterBootstrapResult,
  type PublishedFixtureClusterBootstrapResult,
  type PreKickEvidenceObservation,
} from "@/lib/evaluation/evidence-integrity";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { listLiveSnapshots, liveSnapshotUniverse } from "./ops/live-snapshot-reader";
import { productionModelVersion } from "./shadow/track";
import { canonicalLedgerMetrics } from "./ledger-metrics";
import { liveFixtures } from "./fixture-store";
import {
  validateProductionForecastSnapshot,
  type ForecastFreshnessSnapshotInput,
} from "./ops/production-freshness";

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
      asOf: parseSnapshotUniqueKey(r.snapshotUniqueKey)?.asOf ?? r.settledAt,
      dataCutoff: parseSnapshotUniqueKey(r.snapshotUniqueKey)?.asOf ?? r.settledAt,
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

interface SettlementEvidence extends PreKickEvidenceObservation {
  settlement: SettlementRecord;
}

function evaluationSnapshotInput(
  snapshot: PredictionSnapshot
): ForecastFreshnessSnapshotInput {
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

function settlementEvidence(
  rows: SettlementRecord[],
  snapshots: PredictionSnapshot[]
): SettlementEvidence[] {
  const snapshotByKey = new Map(
    snapshots.map((snapshot) => [snapshot.provenance.uniqueKey, snapshot])
  );
  const currentKickoffByFixture = new Map(
    liveFixtures().map((fixture) => [
      fixture.id,
      fixture.kickoffUtc ?? fixture.kickoff ?? null,
    ])
  );
  const out: SettlementEvidence[] = [];
  for (const settlement of rows) {
    const snapshot = snapshotByKey.get(settlement.snapshotUniqueKey);
    if (!snapshot) continue;
    if (!validateSettlementSnapshotConsistency(settlement, snapshot).consistent) continue;
    const kickoffAt = currentKickoffByFixture.get(settlement.fixtureId) ?? snapshot.kickoff;
    if (!kickoffAt) continue;
    const generatedAt = effectiveSnapshotGeneratedAt(snapshot);
    const validation = validateProductionForecastSnapshot({
      snapshot: evaluationSnapshotInput(snapshot),
      expectedKickoffUtc: kickoffAt,
      evaluatedAt: settlement.settledAt,
    });
    if (!validation.valid) continue;
    out.push({
      settlement,
      fixtureId: settlement.fixtureId,
      predictionStage: canonicalizePredictionStage(settlement.predictionStage),
      snapshotUniqueKey: settlement.snapshotUniqueKey,
      cutoffAt: snapshot.asOf,
      generatedAt,
      kickoffAt,
      kickoffAtFreeze: snapshot.kickoff,
    });
  }
  return out;
}

function scoreUncertainty(rows: SettlementRecord[]): FixtureClusterBootstrapResult {
  return fixtureClusterBootstrap(
    rows.map((row) => ({
      fixtureId: row.fixtureId,
      observationId: row.snapshotUniqueKey,
      values: {
        brier: row.brier,
        rps: row.rps,
        logLoss: row.logLoss,
      },
    })),
    { metricKeys: ["brier", "rps", "logLoss"] }
  );
}

export interface StagePerformanceRow {
  stage: CanonicalPredictionStage;
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  uniqueSettledFixtures: number;
  effectiveN: number;
  aggregationUnit: "latest_valid_snapshot_per_fixture_stage";
  selectionRule: "LATEST_VALID_PREKICK_WITHIN_FIXTURE_STAGE";
  uncertainty: FixtureClusterBootstrapResult;
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
  aggregationUnit: "latest_valid_pre_kickoff_snapshot_per_fixture";
  headlineSelectionRule: "LATEST_VALID_PREKICK_PER_FIXTURE";
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  uniqueFixturesForecast: number;
  uniqueFixturesSettled: number;
  independentSampleSize: number;
  evaluationMaturity: EvaluationMaturityAssessment;
  uncertainty: PublishedFixtureClusterBootstrapResult;
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
  const snapshotByKey = new Map(
    snaps.map((snapshot) => [snapshot.provenance.uniqueKey, snapshot])
  );
  const settled = loadSettlements().filter(
    (s) => {
      const snapshot = snapshotByKey.get(s.snapshotUniqueKey);
      return (
        s.evaluationClass === evaluationClass &&
        s.season === season &&
        (evaluationClass !== "LIVE_OOS" || s.modelVersion === productionModelVersion()) &&
        snapshot !== undefined &&
        validateSettlementSnapshotConsistency(s, snapshot).consistent
      );
    }
  );
  const nPredictions = canonical?.production.totalForecastSnapshots ?? snaps.length;
  const nSettled = canonical?.production.settledForecastSnapshots ?? settled.length;
  const uniqueFixturesForecast =
    canonical?.production.uniqueFixturesForecast ?? new Set(snaps.map((s) => s.fixtureId)).size;
  const uniqueFixturesSettled =
    canonical?.production.uniqueFixturesSettled ?? new Set(settled.map((s) => s.fixtureId)).size;
  const evidence = settlementEvidence(settled, snaps);
  // The production headline is one deterministic latest valid pre-kickoff
  // forecast per realised fixture. Earlier stage rows remain immutable
  // trajectory diagnostics and never gain independent-sample weight.
  const headlineRows = selectLatestValidPreKickByFixture(evidence).map(
    (row) => row.settlement
  );
  const independentSampleSize = headlineRows.length;
  const evaluationMaturity = assessEvaluationMaturity(independentSampleSize);
  const uncertainty = publishFixtureClusterBootstrap(
    scoreUncertainty(headlineRows),
    evaluationMaturity.provisionalReportingAllowed
  );
  const metrics = headlineRows.length
    ? calculateBacktestMetrics(settlementsToBacktest(headlineRows))
    : null;
  const stages = stageBreakdown(snaps);
  const stageHeadlineEvidence = selectLatestValidPreKickByFixtureStage(evidence);
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
    const snapshotRows = settled.filter(
      (s) => canonicalizePredictionStage(s.predictionStage) === stage
    );
    const rows = stageHeadlineEvidence
      .filter((row) => canonicalizePredictionStage(row.predictionStage) === stage)
      .map((row) => row.settlement);
    const m = rows.length
      ? calculateBacktestMetrics(settlementsToBacktest(rows))
      : null;
    return {
      stage,
      totalForecastSnapshots: stages[stage],
      settledForecastSnapshots: snapshotRows.length,
      uniqueSettledFixtures: rows.length,
      effectiveN: rows.length,
      aggregationUnit: "latest_valid_snapshot_per_fixture_stage",
      selectionRule: "LATEST_VALID_PREKICK_WITHIN_FIXTURE_STAGE",
      uncertainty: scoreUncertainty(rows),
      n: stages[stage],
      nSettled: snapshotRows.length,
      brier: rows.length ? m!.brierScore : null,
      rps: rows.length ? m!.rps : null,
      logLoss: rows.length ? m!.logLoss : null,
      topPickAccuracy: rows.length ? m!.accuracy1x2 : null,
    };
  });
  return {
    season,
    evaluationClass,
    aggregationUnit: "latest_valid_pre_kickoff_snapshot_per_fixture",
    headlineSelectionRule: "LATEST_VALID_PREKICK_PER_FIXTURE",
    totalForecastSnapshots: nPredictions,
    settledForecastSnapshots: nSettled,
    uniqueFixturesForecast,
    uniqueFixturesSettled,
    independentSampleSize,
    evaluationMaturity,
    uncertainty,
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
    sampleNote:
      `${evaluationMaturity.status} — independent N=${independentSampleSize} unique settled ` +
      `fixture${independentSampleSize === 1 ? "" : "s"}. The ledger retains ${nSettled} settled ` +
      `forecast snapshot${nSettled === 1 ? "" : "s"} for trajectory diagnostics. ` +
      (evaluationMaturity.provisionalReportingAllowed
        ? "Headline scores use the latest valid pre-kickoff snapshot per fixture; fixture-bootstrap uncertainty is shown."
        : `Headline aggregate scores and intervals remain withheld until ${evaluationMaturity.thresholds.provisionalMinUniqueFixtures} independent fixtures.`),
    brier:
      metrics && evaluationMaturity.provisionalReportingAllowed ? metrics.brierScore : null,
    rps: metrics && evaluationMaturity.provisionalReportingAllowed ? metrics.rps : null,
    logLoss:
      metrics && evaluationMaturity.provisionalReportingAllowed ? metrics.logLoss : null,
    confidenceEce:
      metrics && evaluationMaturity.provisionalReportingAllowed
        ? metrics.confidenceEce
        : null,
    pooledReliabilityMae:
      metrics && evaluationMaturity.provisionalReportingAllowed
        ? metrics.pooledReliabilityMae
        : null,
    topPickAccuracy:
      metrics && evaluationMaturity.provisionalReportingAllowed
        ? metrics.accuracy1x2
        : null,
  };
}

export interface PublicStagePerformanceRow {
  stage: CanonicalPredictionStage;
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  uniqueSettledFixtures: number;
  effectiveN: number;
  aggregationUnit: "latest_valid_snapshot_per_fixture_stage";
  selectionRule: "LATEST_VALID_PREKICK_WITHIN_FIXTURE_STAGE";
  uncertainty: FixtureClusterBootstrapResult;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  topPickAccuracy: number | null;
}

export type PublicLivePerformanceReport = Omit<
  LivePerformanceReport,
  | "nPredictions"
  | "nSettled"
  | "nCommitted"
  | "nOperational"
  | "stages"
  | "byStage"
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
    stages: _stages,
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

export function fixtureLiveView(
  fixtureId: string,
  season = PREMIER_LEAGUE_CURRENT_SEASON,
  now = new Date()
) {
  const snaps = productionOnly(
    operationalLiveOosUnion(season).snapshots.filter((s) => s.fixtureId === fixtureId)
  ).sort(
    (a, b) =>
      a.asOf.localeCompare(b.asOf) ||
      effectiveSnapshotGeneratedAt(a).localeCompare(effectiveSnapshotGeneratedAt(b)) ||
      a.provenance.uniqueKey.localeCompare(b.provenance.uniqueKey)
  );
  const snapshotByKey = new Map(
    snaps.map((snapshot) => [snapshot.provenance.uniqueKey, snapshot])
  );
  const settlements = loadSettlements().filter((settlement) => {
    const snapshot = snapshotByKey.get(settlement.snapshotUniqueKey);
    return (
      settlement.fixtureId === fixtureId &&
      settlement.modelVersion === productionModelVersion() &&
      snapshot !== undefined &&
      validateSettlementSnapshotConsistency(settlement, snapshot).consistent
    );
  });
  const fixture = liveFixtures().find((row) => row.id === fixtureId);
  const currentKickoff = fixture?.kickoffUtc ?? fixture?.kickoff ?? null;
  const nowMs = now.getTime();
  const visibleHistory = snaps.filter(
    (snapshot) =>
      Date.parse(snapshot.asOf) <= nowMs &&
      Date.parse(effectiveSnapshotGeneratedAt(snapshot)) <= nowMs
  );
  const snapshotValidity = (snapshot: PredictionSnapshot) => {
    const kickoffIdentityCurrent = Boolean(
      currentKickoff &&
      snapshot.kickoff &&
      Date.parse(snapshot.kickoff) === Date.parse(currentKickoff)
    );
    const validation = validateProductionForecastSnapshot({
      snapshot: evaluationSnapshotInput(snapshot),
      expectedKickoffUtc: currentKickoff ?? "",
      evaluatedAt: now.toISOString(),
    });
    const validForStagePolicy = Boolean(validation.valid);
    return {
      kickoffIdentityCurrent,
      validForStagePolicy,
      validForCurrentSelection: kickoffIdentityCurrent && validForStagePolicy,
      validityIssues: validation.issues,
    };
  };
  const byStage: Record<
    string,
    {
      snapshot: PredictionSnapshot | null;
      settlement: SettlementRecord | null;
      kickoffIdentityCurrent: boolean;
      validForStagePolicy: boolean;
      validForCurrentSelection: boolean;
      validityIssues: string[];
    }
  > = {};
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
      visibleHistory
        .filter((s) => canonicalizePredictionStage(s.predictionStage) === stage)
        .at(-1) ?? null;
    const settlement = snapshot
      ? settlements.find((x) => x.snapshotUniqueKey === snapshot.provenance.uniqueKey) ?? null
      : null;
    const validity = snapshot
      ? snapshotValidity(snapshot)
      : {
          kickoffIdentityCurrent: false,
          validForStagePolicy: false,
          validForCurrentSelection: false,
          validityIssues: [],
        };
    byStage[stage] = {
      snapshot,
      settlement,
      ...validity,
    };
  }
  return {
    fixtureId,
    season,
    snapshots: visibleHistory,
    timeline: visibleHistory.map((snapshot) => ({ snapshot, ...snapshotValidity(snapshot) })),
    settlements,
    byStage,
  };
}
