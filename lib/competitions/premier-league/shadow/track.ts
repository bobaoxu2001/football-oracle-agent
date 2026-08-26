/**
 * Shadow model track + promotion gate.
 *
 * PRODUCTION = pl-live-v0.2.0 (baseline / champion)
 * SHADOW     = pl-live-v0.3.0-shadow (challenger)
 *
 * The shadow is never served as the answer. `productionModelVersion()` is the
 * single place that decides what production means, and it returns the baseline
 * unconditionally — there is deliberately no environment variable, no flag and
 * no config file that can flip it. Promotion is a code change plus a recorded
 * decision, not a runtime toggle.
 */

import type { ModelTrack } from "../model-tracks";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import { EVALUATION_MATURITY_POLICY } from "@/lib/evaluation/evidence-integrity";

export const SHADOW_MODEL_VERSION = "pl-live-v0.3.0-shadow";

export const SHADOW_TRACK: ModelTrack & {
  id: "production";
  challenger: true;
  championVersion: string;
} = {
  id: "production",
  challenger: true,
  championVersion: PRODUCTION_MODEL_VERSION,
  modelVersion: SHADOW_MODEL_VERSION,
  useChampionshipFeeder: true,
  applyOffseasonInit: true,
  seasonInitVersion: "pl-season-init-v0.2.0",
  features: {
    walkForwardElo: true,
    trueHomeAdvantage: true,
    dixonColes: true,
    championshipFeeder: true,
    officialCurrentSeasonMembership: true,
    liveMarketOdds: false,
    injuries: false,
    lineups: false,
    shotBasedXg: false,
  },
  rationale:
    "Challenger. Identical to pl-live-v0.2.0 except for a Gamma-Poisson shrunk attack/defence " +
    "correction estimated from current-season goals against the baseline's own walk-forward " +
    "expectations. With zero current-season evidence it reproduces the baseline exactly. " +
    "EXPERIMENTAL: never served to users, never promoted automatically.",
};

/**
 * Is shadow FREEZING enabled?
 *
 * Default ON, matching the repository's existing opt-out convention
 * (MARKET_RECORDER_DISABLED, MATCH_LEDGER_DISABLED). This is safe because
 * freezing a shadow snapshot is purely additive: a separate immutable record
 * under a separate model version that no production read path consults. Turning
 * it off simply stops paired evidence accumulating.
 */
export function shadowModelEnabled(): boolean {
  const raw = process.env.SHADOW_MODEL_ENABLED;
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/**
 * The model version production serves. ALWAYS the champion.
 *
 * Kept as a function so every caller routes through one auditable decision
 * point, and so a future promotion is a single reviewable diff.
 */
export function productionModelVersion(): string {
  return PRODUCTION_MODEL_VERSION;
}

export function isShadowVersion(modelVersion: string): boolean {
  return modelVersion === SHADOW_MODEL_VERSION;
}

// ── Promotion gate ────────────────────────────────────────────────────────

/**
 * Minimum paired settlements before headline comparisons are shown at all.
 * Below this, differences are noise and displaying them invites false
 * conclusions — the same threshold the LIVE_OOS ledger already uses.
 */
export const MIN_PAIRED_FOR_DISPLAY =
  EVALUATION_MATURITY_POLICY.provisionalMinUniqueFixtures;

/** Minimum paired settlements before a promotion decision is even considered. */
export const MIN_PAIRED_FOR_DECISION =
  EVALUATION_MATURITY_POLICY.evaluationReadyMinUniqueFixtures;

/**
 * Metric visibility is not promotion eligibility.
 *
 *   n < 20  → headline metrics withheld, promotion NOT_ELIGIBLE
 *   20 ≤ n < 50 → metrics visible, promotion still NOT_ELIGIBLE
 *   n ≥ 50  → metrics visible, status UNDER_OBSERVATION (a human may evaluate;
 *             nothing here promotes automatically)
 */
export function shadowMetricsVisible(
  uniquePairedFixtures: number,
  integrityOk: boolean
): boolean {
  return uniquePairedFixtures >= MIN_PAIRED_FOR_DISPLAY && integrityOk;
}

export type ShadowPromotionStatus = "NOT_ELIGIBLE" | "UNDER_OBSERVATION";

export function shadowPromotionStatus(input: {
  uniquePairedFixtures: number;
  integrityOk: boolean;
  hasProductionShadowFreeze: boolean;
}): ShadowPromotionStatus {
  if (
    input.uniquePairedFixtures >= MIN_PAIRED_FOR_DECISION &&
    input.integrityOk &&
    input.hasProductionShadowFreeze
  ) {
    return "UNDER_OBSERVATION";
  }
  return "NOT_ELIGIBLE";
}

export interface PromotionCriterion {
  key: string;
  requirement: string;
  rationale: string;
}

/**
 * The criteria a future promotion must satisfy. Declared now, evaluated later.
 * Deliberately NOT executable as an automatic gate: nothing in this codebase
 * may promote a model without a human decision.
 */
export const PROMOTION_CRITERIA: PromotionCriterion[] = [
  {
    key: "sample-size",
    requirement: `>= ${MIN_PAIRED_FOR_DECISION} unique fixtures with valid paired settlements`,
    rationale:
      "Proper-score differences on small samples are dominated by variance. 20 is the floor for looking; 50 is the floor for deciding.",
  },
  {
    key: "brier",
    requirement: "shadow mean Brier <= baseline",
    rationale: "Primary proper score. Order-blind, so it is read alongside RPS.",
  },
  {
    key: "rps",
    requirement: "shadow mean RPS <= baseline",
    rationale: "Ordered proper score: penalises being wrong in the wrong direction along H>D>A.",
  },
  {
    key: "log-loss",
    requirement: "shadow mean log loss <= baseline",
    rationale: "Punishes confident errors hardest; guards against overconfident corrections.",
  },
  {
    key: "calibration",
    requirement: "shadow confidence ECE not materially worse",
    rationale: "A sharper model that is miscalibrated is worse, not better.",
  },
  {
    key: "outcome-class",
    requirement: "no material regression on home / draw / away separately",
    rationale: "An aggregate gain can hide a systematic failure on draws.",
  },
  {
    key: "probability-bucket",
    requirement: "no material regression within probability buckets",
    rationale: "Detects a model that only improves where it was already confident.",
  },
  {
    key: "stability",
    requirement: "advantage stable across matchweeks, not driven by one round",
    rationale: "A single high-variance matchweek must not carry the decision.",
  },
  {
    key: "accuracy-is-not-a-criterion",
    requirement: "top-pick accuracy is descriptive only, never decisive",
    rationale:
      "Accuracy is not a proper score. Predicting Arsenal 3-0 correctly is not evidence the model is better.",
  },
];
