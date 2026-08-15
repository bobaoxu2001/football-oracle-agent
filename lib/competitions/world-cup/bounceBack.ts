/**
 * ROUND-2 BOUNCE-BACK — a capped motivation + mean-reversion nudge for a
 * QUALITY team that UNDER-performed in round 1 and now faces a clearly WEAKER
 * opponent. The intuition (V5.1.2 addendum): a strong side that only drew its
 * opener will "come out firing" in round 2, especially against a weaker team —
 * and the single-game result-learning (K≈60) over-docks an elite team for one
 * draw, so part of that penalty should revert.
 *
 * This is the deliberate counter-weight to the V5.1.2 Finishing downgrade:
 *   • The tactical Kill-Index trim says "don't OVER-price a stumbled favourite
 *     on reputation" — it still can't break a packed BUS.
 *   • This layer says "don't UNDER-price one either" — vs a weaker, non-bus
 *     opponent the quality + motivation reasserts and they should score more.
 * They coexist: vs an elite low block the tactical penalty dominates (Fade); vs
 * an ordinary weaker side the bounce-back dominates (they go for the kill).
 *
 * STRICT GATES (so it only fires for the intended population):
 *   • Group fixture only.
 *   • The team is genuine QUALITY (base Elo ≥ QUALITY_FLOOR).
 *   • The team UNDER-performed (its cumulative result delta is negative — i.e.
 *     it dropped points it was favoured to win). This also implies it has played.
 *   • It is still the clearly STRONGER side here (effective-Elo gap ≥ GAP_FLOOR).
 *
 * SIZE (capped, asymmetric — a motivation bonus, not a zero-sum transfer):
 *   reversion  = REVERT_FRAC × |resultDelta|            (give back part of the
 *                                                        single-game over-penalty)
 *   motivation = MOTIV_K × (gap − GAP_FLOOR), capped     (bigger vs weaker foes)
 *   delta      = min(BOUNCE_CAP, reversion + motivation)
 *
 * A capped behavioural prior, not a fitted constant — re-evaluate as round-2
 * results land. Pure helper (bounceBackDelta) takes inputs explicitly so the
 * walk-forward backtest can recompute it.
 */

import { getRating } from "@/lib/prediction-engine/ratings";
import { getResultDelta } from "@/lib/prediction-engine/ratingUpdates";
import { getEffectiveRating } from "@/lib/prediction-engine/availabilityAdjustments";
import { isGroupFixture } from "./drawPropensity";

/** Min base Elo to count as a "quality" side that should bounce back. */
export const QUALITY_FLOOR = 1700;
/** Min effective-Elo gap to count as the clearly stronger side. */
export const GAP_FLOOR = 60;
/** Fraction of the round-1 over-penalty that reverts. */
export const REVERT_FRAC = 0.5;
/** Motivation Elo per point of gap beyond the floor. */
export const MOTIV_K = 0.06;
/** Cap on the motivation component alone. */
export const MOTIV_CAP = 12;
/** Hard cap on the total bounce-back nudge. */
export const BOUNCE_CAP = 25;

/**
 * Pure bounce-back Elo nudge (≥ 0). Returns 0 unless every gate passes.
 * `resultDelta` is the team's cumulative result-learning delta (negative = it
 * under-performed); `effGap` is its effective Elo minus the opponent's.
 */
export function bounceBackDelta(
  base: number,
  resultDelta: number,
  effGap: number,
  isGroup: boolean
): number {
  if (!isGroup) return 0;
  if (base < QUALITY_FLOOR) return 0;
  if (resultDelta >= 0) return 0; // only sides that dropped points they were favoured to win
  if (effGap < GAP_FLOOR) return 0; // only when still the clearly stronger side
  const reversion = REVERT_FRAC * -resultDelta;
  const motivation = Math.min(MOTIV_CAP, MOTIV_K * (effGap - GAP_FLOOR));
  return Math.min(BOUNCE_CAP, Math.round(reversion + motivation));
}

/** Engine-facing bounce-back nudge for `team` against `opponent`. */
export function getBounceBack(team: string, opponent: string): number {
  return bounceBackDelta(
    getRating(team),
    getResultDelta(team),
    getEffectiveRating(team) - getEffectiveRating(opponent),
    isGroupFixture(team, opponent)
  );
}

/** Metadata for transparent UI labelling. */
export function bounceBackMeta(): {
  qualityFloor: number;
  gapFloor: number;
  cap: number;
} {
  return { qualityFloor: QUALITY_FLOOR, gapFloor: GAP_FLOOR, cap: BOUNCE_CAP };
}
