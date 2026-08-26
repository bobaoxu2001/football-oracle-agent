/**
 * Shadow evaluation report — the read model for the comparison UI and API.
 *
 * Headline comparisons are WITHHELD below MIN_PAIRED_FOR_DISPLAY. Showing a
 * Brier delta over three matches invites exactly the conclusion this whole
 * phase exists to avoid.
 */

import { loadSettlements } from "../settlement";
import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { loadOpsTickState } from "../ops/tick";
import { listJobs } from "../ops/job-ledger";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import {
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import {
  breakdownByBucket,
  breakdownByOutcome,
  breakdownByStage,
  pairSettlements,
  pairedMetrics,
  type PairedBreakdown,
  type PairedMetrics,
  type PairedSettlement,
} from "@/lib/evaluation/paired";
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
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import { liveFixtures } from "../fixture-store";
import {
  validateProductionForecastSnapshot,
  type ForecastFreshnessSnapshotInput,
} from "../ops/production-freshness";
import { validateSettlementSnapshotConsistency } from "@/lib/evaluation/settlement-integrity";
import {
  MIN_PAIRED_FOR_DECISION,
  MIN_PAIRED_FOR_DISPLAY,
  PROMOTION_CRITERIA,
  SHADOW_MODEL_VERSION,
  productionModelVersion,
  shadowMetricsVisible,
  shadowModelEnabled,
  shadowPromotionStatus,
} from "./track";
import { auditShadowIntegrity, type ShadowIntegrityReport } from "./integrity";

export interface NextEligibleFreeze {
  fixtureId: string;
  stage: string;
  status: string;
  eligibleFrom: string;
  plannedAsOf: string;
  kickoffUtc: string;
}

export interface ShadowCollectionStatus {
  freezingEnabled: boolean;
  lastSuccessfulShadowFreezeAt: string | null;
  lastOpsTickAt: string | null;
  lastShadowLifecycleError: string | null;
  frozenBaselineSnapshots: number;
  frozenShadowSnapshots: number;
  /** Both model snapshots frozen at the same fixture/stage/asOf. Not yet evidence. */
  frozenSnapshotPairs: number;
  /** Both model snapshots settled against the same result at the same cutoff. */
  settledSnapshotPairs: number;
  /** Resolved paired settlement rows; canonical-valid evidence N is separate. */
  resolvedPairedSettlementRows: number;
  /** Independent fixtures represented by one valid headline pair each. */
  uniquePairedFixtures: number;
  unpairedBaselineOnly: number;
  orphanShadowSettlements: number;
  orphanShadowSnapshots: number;
  duplicateIdentities: number;
  cutoffMismatches: number;
  nextEligible: NextEligibleFreeze[];
  neverFrozenInProduction: boolean;
  missedShadowFreezeWindows: number;
}

export interface ShadowEvaluationReport {
  season: string;
  baselineVersion: string;
  shadowVersion: string;
  /** Always the baseline. Present so the UI can assert it, not assume it. */
  servingVersion: string;
  shadowEnabled: boolean;
  frozenBaselineSnapshots: number;
  frozenShadowSnapshots: number;
  pairedSettlementRows: number;
  uniquePairedFixtures: number;
  aggregationUnit: "latest_valid_paired_pre_kickoff_snapshot_per_fixture";
  headlineSelectionRule: "LATEST_VALID_PAIRED_PREKICK_PER_FIXTURE";
  evaluationMaturity: EvaluationMaturityAssessment;
  uncertainty: PublishedFixtureClusterBootstrapResult;
  baselineOnlySettlements: number;
  shadowOnlySettlements: number;
  inconsistentPairs: number;
  cutoffMismatches: number;
  /** Null until MIN_PAIRED_FOR_DISPLAY pairs of paired evidence exist. */
  metrics: PairedMetrics | null;
  byOutcome: PairedBreakdown[];
  byBucket: PairedBreakdown[];
  byStage: PairedBreakdown[];
  recentPairs: PairedSettlement[];
  sampleNote: string;
  collection: ShadowCollectionStatus;
  integrity: ShadowIntegrityReport;
  promotion: {
    status: "NOT_ELIGIBLE" | "UNDER_OBSERVATION";
    minUniqueFixturesForDisplay: number;
    minUniqueFixturesForDecision: number;
    metricsVisible: boolean;
    criteria: typeof PROMOTION_CRITERIA;
    reasons: string[];
    note: string;
  };
}

interface PairedEvidenceObservation extends PreKickEvidenceObservation {
  pair: PairedSettlement;
}

function pairedSnapshotInput(
  snapshot: PredictionSnapshot
): ForecastFreshnessSnapshotInput {
  return {
    snapshotId: snapshot.provenance.uniqueKey,
    fixtureId: snapshot.fixtureId,
    modelRole: snapshot.modelVersion === PRODUCTION_MODEL_VERSION ? "production" : "shadow",
    modelVersion: snapshot.modelVersion,
    evaluationClass: snapshot.evaluationClass ?? null,
    predictionStage: String(snapshot.predictionStage),
    kickoffUtc: snapshot.kickoff,
    cutoffAt: snapshot.asOf,
    generatedAt: effectiveSnapshotGeneratedAt(snapshot),
    latestIncludedInputAt: effectiveSnapshotLatestIncludedInputAt(snapshot),
  };
}

function pairedEvidenceObservations(
  pairs: PairedSettlement[],
  snapshots: PredictionSnapshot[]
): PairedEvidenceObservation[] {
  const productionByIdentity = new Map<string, PredictionSnapshot>();
  const shadowByIdentity = new Map<string, PredictionSnapshot>();
  for (const snapshot of snapshots) {
    const identity = `${snapshot.fixtureId}\u0000${canonicalizePredictionStage(snapshot.predictionStage)}\u0000${snapshot.asOf}`;
    if (snapshot.modelVersion === PRODUCTION_MODEL_VERSION) {
      productionByIdentity.set(identity, snapshot);
    } else if (snapshot.modelVersion === SHADOW_MODEL_VERSION) {
      shadowByIdentity.set(identity, snapshot);
    }
  }
  const currentKickoffByFixture = new Map(
    liveFixtures().map((fixture) => [
      fixture.id,
      fixture.kickoffUtc ?? fixture.kickoff ?? null,
    ])
  );
  const out: PairedEvidenceObservation[] = [];
  for (const pair of pairs) {
    const identity = `${pair.fixtureId}\u0000${canonicalizePredictionStage(pair.predictionStage)}\u0000${pair.asOf}`;
    const snapshot = productionByIdentity.get(identity);
    const shadowSnapshot = shadowByIdentity.get(identity);
    const currentKickoff = currentKickoffByFixture.get(pair.fixtureId) ?? snapshot?.kickoff;
    if (
      !snapshot?.kickoff ||
      !shadowSnapshot?.kickoff ||
      !currentKickoff ||
      Date.parse(snapshot.kickoff) !== Date.parse(shadowSnapshot.kickoff)
    ) continue;
    const productionValidation = validateProductionForecastSnapshot({
      snapshot: pairedSnapshotInput(snapshot),
      expectedKickoffUtc: currentKickoff,
      evaluatedAt: pair.settledAt,
    });
    const shadowValidation = validateProductionForecastSnapshot({
      snapshot: pairedSnapshotInput(shadowSnapshot),
      expectedKickoffUtc: currentKickoff,
      evaluatedAt: pair.settledAt,
    });
    if (!productionValidation.valid || !shadowValidation.valid) continue;
    const generatedAt = [
      effectiveSnapshotGeneratedAt(snapshot),
      effectiveSnapshotGeneratedAt(shadowSnapshot),
    ].sort().at(-1)!;
    out.push({
      pair,
      fixtureId: pair.fixtureId,
      predictionStage: canonicalizePredictionStage(pair.predictionStage),
      snapshotUniqueKey: snapshot.provenance.uniqueKey,
      cutoffAt: pair.asOf,
      generatedAt,
      kickoffAt: currentKickoff,
      kickoffAtFreeze: snapshot.kickoff,
    });
  }
  return out;
}

function pairedUncertainty(pairs: PairedSettlement[]): FixtureClusterBootstrapResult {
  return fixtureClusterBootstrap(
    pairs.map((pair) => ({
      fixtureId: pair.fixtureId,
      observationId: `${pair.predictionStage}\u0000${pair.asOf}`,
      values: {
        deltaBrier: pair.delta.brier,
        deltaRps: pair.delta.rps,
        deltaLogLoss: pair.delta.logLoss,
      },
    })),
    { metricKeys: ["deltaBrier", "deltaRps", "deltaLogLoss"] }
  );
}

function nextEligibleFreezes(limit = 8): NextEligibleFreeze[] {
  try {
    const nowMs = Date.now();
    return listJobs()
      .filter((j) => j.status === "PENDING" || j.status === "ELIGIBLE")
      .filter((j) => Date.parse(j.kickoffUtc) > nowMs)
      .sort((a, b) => a.eligibleFrom.localeCompare(b.eligibleFrom))
      .slice(0, limit)
      .map((j) => ({
        fixtureId: j.fixtureId,
        stage: j.stage,
        status: j.status,
        eligibleFrom: j.eligibleFrom,
        plannedAsOf: j.plannedAsOf,
        kickoffUtc: j.kickoffUtc,
      }));
  } catch {
    return [];
  }
}

function latestShadowCreatedAt(season: string): string | null {
  try {
    const times = listLiveSnapshots({ season })
      .filter((s: PredictionSnapshot) => s.modelVersion === SHADOW_MODEL_VERSION)
      .map((s) => s.createdAt)
      .filter(Boolean)
      .sort();
    return times.length ? times[times.length - 1] : null;
  } catch {
    return null;
  }
}

export function shadowEvaluationReport(
  season = PREMIER_LEAGUE_CURRENT_SEASON
): ShadowEvaluationReport {
  const allSettlements = loadSettlements();
  const snapshots = listLiveSnapshots({ season });
  const snapshotByKey = new Map(
    snapshots.map((snapshot) => [snapshot.provenance.uniqueKey, snapshot])
  );
  const settlements = allSettlements.filter((settlement) => {
    const snapshot = snapshotByKey.get(settlement.snapshotUniqueKey);
    return snapshot
      ? validateSettlementSnapshotConsistency(settlement, snapshot).consistent
      : false;
  });
  const pairing = pairSettlements({
    settlements,
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
    season,
  });
  const integrity = auditShadowIntegrity({ settlements: allSettlements, season });
  const pairEvidence = pairedEvidenceObservations(pairing.pairs, snapshots);
  const headlinePairs = selectLatestValidPreKickByFixture(pairEvidence).map(
    (row) => row.pair
  );
  const stageHeadlinePairs = selectLatestValidPreKickByFixtureStage(pairEvidence).map(
    (row) => row.pair
  );
  const uniquePairedFixtures = headlinePairs.length;
  const evaluationMaturity = assessEvaluationMaturity(uniquePairedFixtures);
  const enoughToShow = shadowMetricsVisible(uniquePairedFixtures, integrity.ok);
  const uncertainty = publishFixtureClusterBootstrap(
    pairedUncertainty(headlinePairs),
    enoughToShow
  );
  const frozenBaseline = snapshots.filter(
    (snapshot) => snapshot.modelVersion === PRODUCTION_MODEL_VERSION
  ).length;
  const frozenShadow = snapshots.filter(
    (snapshot) => snapshot.modelVersion === SHADOW_MODEL_VERSION
  ).length;
  const tick = loadOpsTickState();
  const lastFreeze =
    tick.lastShadowFreezeAt ?? latestShadowCreatedAt(season);
  const neverFrozen = frozenShadow === 0 && !lastFreeze;
  const promotionStatus = shadowPromotionStatus({
    uniquePairedFixtures,
    integrityOk: integrity.ok,
    hasProductionShadowFreeze: !neverFrozen,
  });

  const reasons: string[] = [];
  if (!integrity.ok) {
    reasons.push(
      `Integrity failed (${integrity.issues.length} issue${integrity.issues.length === 1 ? "" : "s"}).`
    );
  }
  if (neverFrozen) {
    reasons.push("No production shadow freeze has been recorded yet.");
  }
  if (uniquePairedFixtures < MIN_PAIRED_FOR_DISPLAY) {
    reasons.push(
      `Independent paired-fixture N=${uniquePairedFixtures} is below the metrics display floor of ${MIN_PAIRED_FOR_DISPLAY}. Headline metrics and intervals are withheld.`
    );
  } else if (uniquePairedFixtures < MIN_PAIRED_FOR_DECISION) {
    reasons.push(
      `Independent paired-fixture N=${uniquePairedFixtures} meets the display floor (${MIN_PAIRED_FOR_DISPLAY}) but is below the formal evaluation floor of ${MIN_PAIRED_FOR_DECISION}. Metrics may be shown; promotion stays NOT_ELIGIBLE.`
    );
  }
  if (promotionStatus === "NOT_ELIGIBLE" && reasons.length === 0) {
    reasons.push("Promotion remains locked.");
  }

  return {
    season,
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
    servingVersion: productionModelVersion(),
    shadowEnabled: shadowModelEnabled(),
    frozenBaselineSnapshots: frozenBaseline,
    frozenShadowSnapshots: frozenShadow,
    pairedSettlementRows: pairing.pairs.length,
    uniquePairedFixtures,
    aggregationUnit: "latest_valid_paired_pre_kickoff_snapshot_per_fixture",
    headlineSelectionRule: "LATEST_VALID_PAIRED_PREKICK_PER_FIXTURE",
    evaluationMaturity,
    uncertainty,
    baselineOnlySettlements: pairing.baselineOnly,
    shadowOnlySettlements: pairing.shadowOnly,
    inconsistentPairs: pairing.inconsistent,
    cutoffMismatches: pairing.cutoffMismatch,
    metrics: enoughToShow ? pairedMetrics(headlinePairs) : null,
    byOutcome: enoughToShow ? breakdownByOutcome(headlinePairs) : [],
    byBucket: enoughToShow ? breakdownByBucket(headlinePairs) : [],
    byStage: enoughToShow ? breakdownByStage(stageHeadlinePairs) : [],
    recentPairs: pairing.pairs.slice(-10).reverse(),
    sampleNote: enoughToShow
      ? `${evaluationMaturity.status} — independent N=${uniquePairedFixtures} unique fixtures. ${pairing.pairs.length} paired forecast-snapshot rows remain trajectory diagnostics; headline comparisons use one latest valid pair per fixture.`
      : `${evaluationMaturity.status} — independent N=${uniquePairedFixtures} unique paired fixture${uniquePairedFixtures === 1 ? "" : "s"}. The independent fixture sample is insufficient for headline inference. The ledger contains ${pairing.pairs.length} paired forecast-snapshot row${pairing.pairs.length === 1 ? "" : "s"}; those correlated rows do not increase N. Headline metrics and intervals are withheld until ${MIN_PAIRED_FOR_DISPLAY} unique paired fixtures.`,
    collection: {
      freezingEnabled: shadowModelEnabled(),
      lastSuccessfulShadowFreezeAt: lastFreeze,
      lastOpsTickAt: tick.lastTickAt,
      lastShadowLifecycleError: tick.lastShadowError ?? null,
      frozenBaselineSnapshots: frozenBaseline,
      frozenShadowSnapshots: frozenShadow,
      frozenSnapshotPairs: integrity.frozenSnapshotPairs,
      settledSnapshotPairs: integrity.settledSnapshotPairs,
      resolvedPairedSettlementRows: integrity.resolvedPairedSettlementRows,
      uniquePairedFixtures,
      unpairedBaselineOnly: integrity.unpairedBaseline,
      orphanShadowSettlements: integrity.orphanShadowSettlements,
      orphanShadowSnapshots: integrity.orphanShadowSnapshots,
      duplicateIdentities: integrity.duplicateIdentities,
      cutoffMismatches: integrity.cutoffMismatches,
      nextEligible: nextEligibleFreezes(),
      neverFrozenInProduction: neverFrozen,
      missedShadowFreezeWindows: integrity.missedShadowFreezeWindows,
    },
    integrity,
    promotion: {
      status: promotionStatus,
      minUniqueFixturesForDisplay: MIN_PAIRED_FOR_DISPLAY,
      minUniqueFixturesForDecision: MIN_PAIRED_FOR_DECISION,
      metricsVisible: enoughToShow,
      criteria: PROMOTION_CRITERIA,
      reasons,
      note:
        "Promotion is never automatic. Production serves the baseline unconditionally; " +
        "changing that requires a code change and a recorded decision against every criterion.",
    },
  };
}
