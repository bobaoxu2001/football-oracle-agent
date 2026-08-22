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
import type { PredictionSnapshot } from "@/lib/snapshots/types";
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
  /** Both models frozen at the same fixture/stage/asOf. Not yet evidence. */
  frozenPairs: number;
  /** Both models settled against the same result at the same cutoff. */
  settledPairs: number;
  /** Settled pairs that pass integrity. Unsettled frozen pairs are not this. */
  pairedEvidence: number;
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
  pairedSettlements: number;
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
    minForDisplay: number;
    minForDecision: number;
    metricsVisible: boolean;
    criteria: typeof PROMOTION_CRITERIA;
    reasons: string[];
    note: string;
  };
}

function countSnapshots(season: string, modelVersion: string): number {
  try {
    return listLiveSnapshots({ season }).filter(
      (s: PredictionSnapshot) => s.modelVersion === modelVersion
    ).length;
  } catch {
    return 0;
  }
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
  const settlements = loadSettlements();
  const pairing = pairSettlements({
    settlements,
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
    season,
  });
  const integrity = auditShadowIntegrity({ settlements, season });
  const n = integrity.pairedEvidence;
  const frozenBaseline = countSnapshots(season, PRODUCTION_MODEL_VERSION);
  const frozenShadow = countSnapshots(season, SHADOW_MODEL_VERSION);
  const tick = loadOpsTickState();
  const lastFreeze =
    tick.lastShadowFreezeAt ?? latestShadowCreatedAt(season);
  const neverFrozen = frozenShadow === 0 && !lastFreeze;
  const enoughToShow = shadowMetricsVisible(n, integrity.ok);
  const promotionStatus = shadowPromotionStatus({
    pairedEvidence: n,
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
  if (n < MIN_PAIRED_FOR_DISPLAY) {
    reasons.push(
      `Paired evidence n=${n} is below the metrics display floor of ${MIN_PAIRED_FOR_DISPLAY}. Headline metrics are withheld.`
    );
  } else if (n < MIN_PAIRED_FOR_DECISION) {
    reasons.push(
      `Paired evidence n=${n} meets the display floor (${MIN_PAIRED_FOR_DISPLAY}) but is below the promotion consideration floor of ${MIN_PAIRED_FOR_DECISION}. Metrics may be shown; promotion stays NOT_ELIGIBLE.`
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
    pairedSettlements: pairing.pairs.length,
    baselineOnlySettlements: pairing.baselineOnly,
    shadowOnlySettlements: pairing.shadowOnly,
    inconsistentPairs: pairing.inconsistent,
    cutoffMismatches: pairing.cutoffMismatch,
    metrics: enoughToShow ? pairedMetrics(pairing.pairs) : null,
    byOutcome: enoughToShow ? breakdownByOutcome(pairing.pairs) : [],
    byBucket: enoughToShow ? breakdownByBucket(pairing.pairs) : [],
    byStage: enoughToShow ? breakdownByStage(pairing.pairs) : [],
    recentPairs: pairing.pairs.slice(-10).reverse(),
    sampleNote: enoughToShow
      ? `${n} paired evidence rows. Differences are still small-sample; ${MIN_PAIRED_FOR_DECISION} pairs are the floor for any promotion decision.`
      : `Only ${n} paired evidence row${n === 1 ? "" : "s"}. Sample size is insufficient — headline metrics are withheld until ${MIN_PAIRED_FOR_DISPLAY} integrity-passing settled pairs exist. Frozen-but-unsettled pairs and preview comparisons are not evidence.`,
    collection: {
      freezingEnabled: shadowModelEnabled(),
      lastSuccessfulShadowFreezeAt: lastFreeze,
      lastOpsTickAt: tick.lastTickAt,
      lastShadowLifecycleError: tick.lastShadowError ?? null,
      frozenBaselineSnapshots: frozenBaseline,
      frozenShadowSnapshots: frozenShadow,
      frozenPairs: integrity.frozenPairs,
      settledPairs: integrity.settledPairs,
      pairedEvidence: integrity.pairedEvidence,
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
      minForDisplay: MIN_PAIRED_FOR_DISPLAY,
      minForDecision: MIN_PAIRED_FOR_DECISION,
      metricsVisible: enoughToShow,
      criteria: PROMOTION_CRITERIA,
      reasons,
      note:
        "Promotion is never automatic. Production serves the baseline unconditionally; " +
        "changing that requires a code change and a recorded decision against every criterion.",
    },
  };
}
