/**
 * Group-stage draw-propensity correction — the "openers draw more than raw Elo
 * says" layer.
 *
 * WHY THIS EXISTS (and why it is NOT an Elo layer):
 *   The 11–15 June group openers drew at 50% (8/16); an Elo + Dixon-Coles model
 *   calibrated on general internationals expects ~23%. Even allowing for a small
 *   sample, World Cup GROUP matches — especially matchday-1 openers — are
 *   structurally cagier (rust, fitness, "don't lose first") and draw more than
 *   the league-style baseline. A walk-forward backtest showed the model's whole
 *   error budget was draws, not picking the wrong team.
 *
 *   Crucially, the fix is NOT to narrow the Elo gap: that would symmetrically
 *   inflate the UNDERDOG'S WIN probability, and the data showed favourites
 *   rarely LOST — they were HELD. So this layer adds mass to the DRAW outcome
 *   specifically, shrinking both win probabilities proportionally and leaving
 *   the favourite unchanged.
 *
 * Design (small, capped, transparent):
 *   • Only applies to genuine GROUP fixtures (both teams in the same group).
 *     Knockout / cross-group hypotheticals are untouched (they go to ET/pens).
 *   • Strongest for true OPENERS (neither side has played yet); tapered once a
 *     team has results on the board — a data-driven proxy for matchday.
 *   • The draw is multiplied up to a hard ceiling, never enough to make a draw
 *     an absurd outright pick. Target ≈ historical WC group draw rate (~28–31%),
 *     NOT this round's freak 50%.
 *
 * Pure helpers (drawMultiplierFor / inflateDraw) take their inputs explicitly so
 * the backtest can recompute them walk-forward; applyDrawPropensity is the
 * engine-facing convenience that reads current played-status from the results.
 *
 * Last updated: 2026-06-17.
 */

import { groupOf } from "@/lib/seed/world-cup-2026-groups";
import { MANUAL_MATCH_RESULTS } from "@/lib/seed/manual-match-results";
import { getStyle } from "@/lib/prediction-engine/tacticalMatchups";

/**
 * Max relative inflation of the draw probability (pure opener, group match).
 * FITTED, not guessed: a walk-forward grid search over every completed match
 * (`npm run evolve`) minimises log-loss as this rises. On the CURRENT sample —
 * 20 matchday-1 openers, which draw ~40% — the fit keeps climbing to the top of
 * the search grid, so chasing the exact optimum would over-fit an all-openers
 * round. We set 0.33: it captures nearly all of the log-loss gain, while the
 * 42% ceiling + opener taper hold the AVERAGE group draw prediction near the
 * long-run WC group rate (~30%). Re-run evolve once matchdays 2–3 land (fewer
 * draws expected as teams must chase points) and re-fit toward that.
 */
export const GROUP_DRAW_BOOST = 0.33;
/** Hard ceiling on the post-adjustment draw probability. */
export const DRAW_CEIL = 0.42;

/**
 * KILL-INDEX DAMPENER (V5.1 lesson, added 18 June).
 *
 * The 17 June England 4-2 Croatia rout exposed the limit of a flat draw boost:
 * a "resistant" underdog (Croatia: experience, midfield control) was still
 * dismantled because the favourite had ELITE kill power (Kane, set-pieces,
 * width). Inflating the draw the same amount for England as for a blunt,
 * possession-heavy favourite over-weights the draw exactly where it is least
 * likely. The broader matchday-1/2 data agrees: the lethal-attack favourites
 * (France, Argentina, England) WON, while the held favourites (Spain, Belgium,
 * Portugal, Brazil) were the cagey/possession types.
 *
 * So we shrink the draw boost by the FAVOURITE'S kill index — its tactical
 * `breakdown` rating (0–5). To avoid double-counting the tactical-matchup Elo
 * nudge (which already rewards a low-block clash) and to stay conservative on a
 * thin sample, the dampener fires ONLY for ELITE attacks (breakdown ≥ 4), and
 * never removes more than (1 − KILL_DAMP_FLOOR) of the boost — group games are
 * genuinely cagier, so even a lethal favourite keeps part of the cushion.
 *
 * A capped scouting-style prior, not a fitted constant; re-fit as data grows.
 */
export const KILL_INDEX_DAMP = 0.5;
/** Floor on the boost-retained fraction (a lethal favourite keeps ≥ this much). */
export const KILL_DAMP_FLOOR = 0.4;
/** Kill index (breakdown) at/below which no dampening applies. */
export const KILL_DAMP_THRESHOLD = 3;

/**
 * LOW-BLOCK FORTRESS DRAW TERM (added 25 June, from the backtest 复盘).
 *
 * The opener-tapered boost above under-corrects the model's clearest blind spot:
 * an elite/possession favourite held to a draw by a genuine BUS (Spain 0-0 Cape
 * Verde, Belgium 0-0 Iran, Portugal 1-1 DR Congo, England 0-0 Ghana). The taper
 * shrinks the draw cushion to almost nothing by matchday 3 — yet a real fortress
 * holds in round 3 just as well as round 1. So we add a SECOND, matchday-INVARIANT
 * draw term driven purely by the matchup: how far the underdog's low block out-
 * rates the favourite's ability to break it (busResist = dogLowBlock − favBreakdown,
 * the same "frustration" the tactical-Elo layer reads). Capped overall by DRAW_CEIL,
 * and it only fires when a side is genuinely profiled as a strong block, so blowouts
 * (weak/breached blocks, lethal-kill favourites) are untouched.
 *
 * A capped scouting-style prior, not a fitted constant; re-fit (npm run evolve)
 * as more matchdays land.
 */
export const LOWBLOCK_DRAW_WEIGHT = 0.1;

/** Teams with at least one completed result on file (proxy for "has played"). */
const PLAYED_TEAMS = new Set<string>(
  MANUAL_MATCH_RESULTS.flatMap((m) => [m.teamA, m.teamB])
);

/** True when both teams are drawn into the same group (a real group fixture). */
export function isGroupFixture(aSlug: string, bSlug: string): boolean {
  try {
    return groupOf(aSlug).name === groupOf(bSlug).name;
  } catch {
    return false;
  }
}

/**
 * Boost-retained fraction given the favourite's kill index (tactical breakdown).
 * 1 for ordinary favourites; shrinks (down to KILL_DAMP_FLOOR) once the
 * favourite has an ELITE attack (breakdown ≥ KILL_DAMP_THRESHOLD+1), which is
 * less likely to be held to a draw.
 */
export function killDampFactor(favKillIndex: number): number {
  const excess = Math.max(0, favKillIndex - KILL_DAMP_THRESHOLD);
  return Math.max(KILL_DAMP_FLOOR, 1 - KILL_INDEX_DAMP * excess);
}

/**
 * Draw multiplier from the matchup type, how many of the two sides have already
 * played, and the FAVOURITE'S kill index. Non-group → 1 (no change). Group →
 * the boost is tapered by opener-ness (neither played gets the full boost; it
 * shrinks as results accumulate) AND dampened by the favourite's kill index
 * (an elite attack is less likely to be held). `favKillIndex` defaults to the
 * neutral 2 so legacy callers get the undampened behaviour.
 */
export function drawMultiplierFor(
  isGroup: boolean,
  playedCount: number,
  favKillIndex = 2,
  busResist = 0
): number {
  if (!isGroup) return 1;
  const w = playedCount <= 0 ? 1.0 : playedCount === 1 ? 0.6 : 0.4;
  const opener = GROUP_DRAW_BOOST * w * killDampFactor(favKillIndex);
  // Matchday-INVARIANT fortress term: a strong bus holds in every round.
  const fortress = LOWBLOCK_DRAW_WEIGHT * Math.max(0, busResist);
  return 1 + opener + fortress;
}

export interface InflatedProb {
  winA: number;
  draw: number;
  winB: number;
  /** Absolute increase in draw probability applied (0 if none). */
  boost: number;
  applied: boolean;
}

/**
 * Move probability mass into the draw by `mult`, capped at DRAW_CEIL, shrinking
 * both win probabilities proportionally so the favourite (and the win-odds
 * ratio) is preserved and the three outcomes still sum to 1.
 */
export function inflateDraw(
  winA: number,
  draw: number,
  winB: number,
  mult: number
): InflatedProb {
  const newDraw = Math.min(draw * mult, DRAW_CEIL);
  if (mult <= 1 || newDraw <= draw || draw >= 1) {
    return { winA, draw, winB, boost: 0, applied: false };
  }
  const scale = (1 - newDraw) / (1 - draw);
  return {
    winA: winA * scale,
    draw: newDraw,
    winB: winB * scale,
    boost: newDraw - draw,
    applied: true,
  };
}

export interface DrawAdjusted {
  winA: number;
  draw: number;
  winB: number;
  boost: number;
  applied: boolean;
  mult: number;
  /** True when the matchday-invariant low-block fortress term contributed. */
  lowBlockBoost: boolean;
}

/**
 * Engine-facing: apply the group-stage draw correction to a 1X2 distribution
 * using the CURRENT played-status of the two teams. Returns the (possibly
 * unchanged) distribution plus the boost applied, for transparent labelling.
 */
export function applyDrawPropensity(
  p: { winA: number; draw: number; winB: number },
  aSlug: string,
  bSlug: string
): DrawAdjusted {
  const isGroup = isGroupFixture(aSlug, bSlug);
  const playedCount = (PLAYED_TEAMS.has(aSlug) ? 1 : 0) + (PLAYED_TEAMS.has(bSlug) ? 1 : 0);
  // The favourite (higher pre-adjustment win prob) supplies the kill index that
  // dampens the boost; the underdog's low block supplies the matchday-invariant
  // fortress term — a bus the favourite can't break draws more, in any round.
  const favStyle = p.winA >= p.winB ? getStyle(aSlug) : getStyle(bSlug);
  const dogStyle = p.winA >= p.winB ? getStyle(bSlug) : getStyle(aSlug);
  const busResist = Math.max(0, dogStyle.lowBlock - favStyle.breakdown);
  const mult = drawMultiplierFor(isGroup, playedCount, favStyle.breakdown, busResist);
  const r = inflateDraw(p.winA, p.draw, p.winB, mult);
  return {
    winA: r.winA,
    draw: r.draw,
    winB: r.winB,
    boost: r.boost,
    applied: r.applied,
    mult,
    lowBlockBoost: isGroup && busResist > 0 && r.applied,
  };
}

/** Metadata for transparent UI labelling. */
export function drawPropensityMeta(): {
  boost: number;
  ceil: number;
  playedTeams: number;
} {
  return { boost: GROUP_DRAW_BOOST, ceil: DRAW_CEIL, playedTeams: PLAYED_TEAMS.size };
}
