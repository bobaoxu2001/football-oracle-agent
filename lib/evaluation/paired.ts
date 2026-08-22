/**
 * Paired champion-vs-challenger evaluation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAIRING RULE
 *
 * A fixture-stage contributes ONLY when BOTH models have a settled prediction
 * for the same (fixtureId, predictionStage) and the same actual result. An
 * unpaired settlement is counted and reported, never silently folded into an
 * average — comparing a mean over different fixture sets is the classic way to
 * manufacture an advantage that does not exist.
 *
 * Metrics are the existing proper scores (brier3, rps3, log loss) recomputed
 * from the FROZEN probabilities on each settlement row, so this module cannot
 * disagree with the ledger it reads.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import { parseSnapshotUniqueKey } from "@/lib/snapshots/types";
import type { Outcome } from "./types";

export interface PairedSettlement {
  fixtureId: string;
  predictionStage: string;
  season: string;
  /** Freeze cutoff shared by both sides. Null only if the unique key could not be parsed. */
  asOf: string;
  settledAt: string;
  actualOutcome: Outcome;
  actualScore: { home: number; away: number };
  baseline: PairedSide;
  shadow: PairedSide;
  /** shadow − baseline. Negative = shadow scored better on that metric. */
  delta: { brier: number; rps: number; logLoss: number };
  /** Probability bucket of the BASELINE favourite, for bucketed reporting. */
  probabilityBucket: string;
}

export interface PairedSide {
  modelVersion: string;
  home: number;
  draw: number;
  away: number;
  brier: number;
  rps: number;
  logLoss: number;
  topPickCorrect: boolean;
}

const BUCKET_EDGES = [0, 0.4, 0.5, 0.6, 0.7, 1.01];
const BUCKET_LABELS = ["<40%", "40–50%", "50–60%", "60–70%", "70%+"];

export function probabilityBucket(p: number): string {
  for (let i = 0; i < BUCKET_LABELS.length; i++) {
    if (p >= BUCKET_EDGES[i] && p < BUCKET_EDGES[i + 1]) return BUCKET_LABELS[i];
  }
  return BUCKET_LABELS[BUCKET_LABELS.length - 1];
}

function sideOf(rec: SettlementRecord): PairedSide {
  return {
    modelVersion: rec.modelVersion,
    home: rec.predicted.home,
    draw: rec.predicted.draw,
    away: rec.predicted.away,
    brier: rec.brier,
    rps: rec.rps,
    logLoss: rec.logLoss,
    topPickCorrect: rec.topPickCorrect,
  };
}

export interface PairingInput {
  settlements: SettlementRecord[];
  baselineVersion: string;
  shadowVersion: string;
  season?: string;
}

export interface PairingResult {
  pairs: PairedSettlement[];
  /** Settled for the baseline but with no shadow counterpart, and vice versa. */
  baselineOnly: number;
  shadowOnly: number;
  /** Pairs rejected because the two rows disagreed on the actual result. */
  inconsistent: number;
  /**
   * Same fixture+stage settled for both models, but the freeze cutoffs differ.
   * These are not pairs: comparing two information sets is not a head-to-head.
   */
  cutoffMismatch: number;
}

/**
 * Join settlements into pairs keyed by fixture + stage.
 *
 * A disagreement on the actual outcome between the two rows means one of them
 * was settled against a different (probably corrected) result. Such a pair is
 * rejected rather than averaged, because the two models would not be being
 * scored on the same event.
 */
function asOfOf(rec: SettlementRecord): string | null {
  return parseSnapshotUniqueKey(rec.snapshotUniqueKey)?.asOf ?? null;
}

export function pairSettlements(input: PairingInput): PairingResult {
  const scoped = input.settlements.filter(
    (s) => !input.season || s.season === input.season
  );
  // Pairing identity is fixture + stage + freeze cutoff. Stage alone is not
  // enough: a late shadow freeze at a different asOf must not join a historical
  // baseline snapshot of the same stage.
  const key = (s: SettlementRecord) => {
    const asOf = asOfOf(s);
    return `${s.fixtureId}::${String(s.predictionStage)}::${asOf ?? s.snapshotUniqueKey}`;
  };
  const stageKey = (s: SettlementRecord) => `${s.fixtureId}::${String(s.predictionStage)}`;

  const baseline = new Map<string, SettlementRecord>();
  const shadow = new Map<string, SettlementRecord>();
  for (const s of scoped) {
    if (s.modelVersion === input.baselineVersion) baseline.set(key(s), s);
    else if (s.modelVersion === input.shadowVersion) shadow.set(key(s), s);
  }

  const pairs: PairedSettlement[] = [];
  let inconsistent = 0;
  const inconsistentStageKeys = new Set<string>();
  for (const [k, b] of baseline) {
    const s = shadow.get(k);
    if (!s) continue;
    const bAsOf = asOfOf(b);
    const sAsOf = asOfOf(s);
    if (!bAsOf || !sAsOf || bAsOf !== sAsOf) continue;
    if (
      b.actualOutcome !== s.actualOutcome ||
      b.actualScore.home !== s.actualScore.home ||
      b.actualScore.away !== s.actualScore.away
    ) {
      inconsistent += 1;
      inconsistentStageKeys.add(`${b.fixtureId}::${String(b.predictionStage)}`);
      continue;
    }
    pairs.push({
      fixtureId: b.fixtureId,
      predictionStage: String(b.predictionStage),
      season: b.season,
      asOf: bAsOf,
      settledAt: b.settledAt,
      actualOutcome: b.actualOutcome,
      actualScore: b.actualScore,
      baseline: sideOf(b),
      shadow: sideOf(s),
      delta: {
        brier: s.brier - b.brier,
        rps: s.rps - b.rps,
        logLoss: s.logLoss - b.logLoss,
      },
      probabilityBucket: probabilityBucket(
        Math.max(b.predicted.home, b.predicted.draw, b.predicted.away)
      ),
    });
  }

  const pairedStageKeys = new Set(pairs.map((p) => `${p.fixtureId}::${p.predictionStage}`));

  const baselineByStage = new Map<string, SettlementRecord[]>();
  const shadowByStage = new Map<string, SettlementRecord[]>();
  for (const s of scoped) {
    const k = stageKey(s);
    if (s.modelVersion === input.baselineVersion) {
      const list = baselineByStage.get(k) ?? [];
      list.push(s);
      baselineByStage.set(k, list);
    } else if (s.modelVersion === input.shadowVersion) {
      const list = shadowByStage.get(k) ?? [];
      list.push(s);
      shadowByStage.set(k, list);
    }
  }
  let cutoffMismatch = 0;
  let baselineOnly = 0;
  let shadowOnly = 0;
  for (const [k, rows] of baselineByStage) {
    const sRows = shadowByStage.get(k);
    if (!sRows?.length) {
      baselineOnly += rows.length;
      continue;
    }
    if (!pairedStageKeys.has(k) && !inconsistentStageKeys.has(k)) cutoffMismatch += 1;
  }
  for (const [k, rows] of shadowByStage) {
    if (!baselineByStage.has(k)) shadowOnly += rows.length;
  }

  return {
    pairs: pairs.sort(
      (a, b) => a.settledAt.localeCompare(b.settledAt) || a.fixtureId.localeCompare(b.fixtureId)
    ),
    baselineOnly,
    shadowOnly,
    inconsistent,
    cutoffMismatch,
  };
}

export interface PairedMetrics {
  n: number;
  baseline: { brier: number | null; rps: number | null; logLoss: number | null; topPickAccuracy: number | null };
  shadow: { brier: number | null; rps: number | null; logLoss: number | null; topPickAccuracy: number | null };
  delta: { brier: number | null; rps: number | null; logLoss: number | null };
  /** Pairs where the shadow's proper score was better. Descriptive only. */
  shadowBetterBrier: number;
  shadowBetterRps: number;
  shadowBetterLogLoss: number;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

export function pairedMetrics(pairs: PairedSettlement[]): PairedMetrics {
  const n = pairs.length;
  const bBrier = mean(pairs.map((p) => p.baseline.brier));
  const sBrier = mean(pairs.map((p) => p.shadow.brier));
  const bRps = mean(pairs.map((p) => p.baseline.rps));
  const sRps = mean(pairs.map((p) => p.shadow.rps));
  const bLog = mean(pairs.map((p) => p.baseline.logLoss));
  const sLog = mean(pairs.map((p) => p.shadow.logLoss));
  return {
    n,
    baseline: {
      brier: bBrier,
      rps: bRps,
      logLoss: bLog,
      topPickAccuracy: mean(pairs.map((p) => (p.baseline.topPickCorrect ? 1 : 0))),
    },
    shadow: {
      brier: sBrier,
      rps: sRps,
      logLoss: sLog,
      topPickAccuracy: mean(pairs.map((p) => (p.shadow.topPickCorrect ? 1 : 0))),
    },
    delta: {
      brier: bBrier !== null && sBrier !== null ? sBrier - bBrier : null,
      rps: bRps !== null && sRps !== null ? sRps - bRps : null,
      logLoss: bLog !== null && sLog !== null ? sLog - bLog : null,
    },
    shadowBetterBrier: pairs.filter((p) => p.delta.brier < 0).length,
    shadowBetterRps: pairs.filter((p) => p.delta.rps < 0).length,
    shadowBetterLogLoss: pairs.filter((p) => p.delta.logLoss < 0).length,
  };
}

export interface PairedBreakdown {
  key: string;
  n: number;
  baselineBrier: number | null;
  shadowBrier: number | null;
  deltaBrier: number | null;
}

function breakdownBy(
  pairs: PairedSettlement[],
  keyOf: (p: PairedSettlement) => string
): PairedBreakdown[] {
  const groups = new Map<string, PairedSettlement[]>();
  for (const p of pairs) {
    const k = keyOf(p);
    const list = groups.get(k);
    if (list) list.push(p);
    else groups.set(k, [p]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const b = mean(rows.map((r) => r.baseline.brier));
      const s = mean(rows.map((r) => r.shadow.brier));
      return {
        key,
        n: rows.length,
        baselineBrier: b,
        shadowBrier: s,
        deltaBrier: b !== null && s !== null ? s - b : null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** By actual outcome — an aggregate gain can hide a systematic draw failure. */
export function breakdownByOutcome(pairs: PairedSettlement[]): PairedBreakdown[] {
  return breakdownBy(pairs, (p) => p.actualOutcome);
}

/** By baseline confidence bucket — detects gains only where already confident. */
export function breakdownByBucket(pairs: PairedSettlement[]): PairedBreakdown[] {
  return breakdownBy(pairs, (p) => p.probabilityBucket);
}

/** By prediction stage — the two models must be compared like for like. */
export function breakdownByStage(pairs: PairedSettlement[]): PairedBreakdown[] {
  return breakdownBy(pairs, (p) => p.predictionStage);
}
