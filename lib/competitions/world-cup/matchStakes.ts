/**
 * MATCH STAKES — a "knows-football" rotation/motivation layer for the FINAL
 * group round.
 *
 * THE INTUITION (the central ask): a model that truly understands the tournament
 * should know that the LAST group game is not played at equal intensity by every
 * team. A side whose place is already settled — group win clinched, or safely
 * through with nothing left to climb to — routinely RESTS starters (Germany,
 * Argentina once they've locked things up), while a side still fighting to
 * qualify, or in a live race for top spot (Netherlands & Japan chasing first
 * place for a better knockout path), plays a full-strength XI. Raw Elo can't see
 * this, so it over-rates a coasting favourite in a dead rubber.
 *
 * WHAT IT DOES: for an UPCOMING final-round group fixture, it trims the effective
 * rating of a team that has little left to play for (a capped, negative nudge —
 * rotation risk), and leaves everyone else untouched. It is deliberately a
 * BEHAVIOURAL PRIOR, not a claim about the actual team sheet: we never assert a
 * specific player is rested, and the size is capped so it nudges tight games
 * (where rotation matters most) without ever overturning a real gap.
 *
 * STRICT, HONEST GATES (so it only fires for the intended population):
 *   • Group fixture only, and only the team's FINAL group game (1 game left).
 *   • "Secured" = MATHEMATICALLY guaranteed a top-two place (we never guess this;
 *     it is enumerated over the remaining results — see classifyStakes).
 *   • Among secured teams we separate "place settled" (rotate) from "still racing
 *     for first" (full strength). A merely comfortable leader (≥ ROTATION_LEAD
 *     points clear) is treated as likely-to-rotate; a team level/near-level at the
 *     top, or one that still must get a result, is left at full strength.
 *
 * NOT applied in the Monte-Carlo tournament/group simulator (matchupRatings):
 * that replays the whole group from scratch, where "who has clinched" is
 * undefined and would be circular. This is a predictMatch-time signal for a
 * SPECIFIC upcoming fixture, computed from the real recorded standings.
 *
 * The magnitude is scaled by a coach `rotationTendency` (0..1) so a future
 * coach-profiles layer can make habitual rotators (pragmatic managers) rest more
 * and reluctant ones rest less; until that lands, every side uses the neutral
 * DEFAULT_ROTATION_TENDENCY. Pure helpers take inputs explicitly so a backtest
 * can recompute them walk-forward.
 */

import { groupOf } from "@/lib/seed/world-cup-2026-groups";
import { getCompletedFixture } from "@/lib/prediction-engine/completedFixtures";
import { isGroupFixture } from "./drawPropensity";

/** Base rotation Elo hit for a true dead rubber (before coach/state scaling). */
export const ROTATION_ELO = 40;
/** Hard cap on the absolute rotation nudge. */
export const ROTATION_CAP = 45;
/** Points clear of second place that flags a "comfortable" (likely-rotating) leader. */
export const ROTATION_LEAD = 3;
/** Neutral how-readily-a-side-rests-when-safe (0 = never, 1 = always). */
export const DEFAULT_ROTATION_TENDENCY = 0.6;

export type StakesState =
  | "done" // no upcoming group game for this team (group finished / not a group fixture)
  | "early" // more than the final group game remains — not modelled
  | "must-play" // still needs a result to advance (or is chasing a best-third) → full strength
  | "race-for-first" // through, but 1st vs 2nd is still live → full strength
  | "comfortable" // through and a comfortable group leader → likely rotation
  | "settled-top" // group win already mathematically guaranteed → likely rotation
  | "settled-second"; // through but cannot finish 1st → likely rotation

/** How strongly each state implies rotation (0 = full strength). */
export const ROTATION_WEIGHT: Record<StakesState, number> = {
  done: 0,
  early: 0,
  "must-play": 0,
  "race-for-first": 0,
  comfortable: 0.75,
  "settled-top": 1,
  "settled-second": 1,
};

/**
 * Classify a team's stakes in its final group game from the CURRENT points and
 * the remaining group fixtures. Pure and deterministic — enumerates every
 * win/draw/loss combination of the games still to play (3^k) and asks, in EVERY
 * outcome, whether the team is guaranteed top-two and whether first place is
 * still reachable. We rank on points only here (the strongest, tiebreak-free
 * claim); ties on points are treated conservatively so "secured"/"settled-top"
 * are never over-claimed.
 */
export function classifyStakes(
  target: string,
  currentPoints: Record<string, number>,
  remaining: [string, string][]
): StakesState {
  const teams = Object.keys(currentPoints);
  const gamesLeft = remaining.filter(([x, y]) => x === target || y === target).length;
  if (remaining.length === 0 || gamesLeft === 0) return "done";
  if (gamesLeft > 1) return "early";

  // Enumerate W/D/L over every remaining fixture → final-points scenarios.
  const combos: Record<string, number>[] = [];
  const rec = (i: number, pts: Record<string, number>) => {
    if (i === remaining.length) {
      combos.push(pts);
      return;
    }
    const [x, y] = remaining[i];
    rec(i + 1, { ...pts, [x]: pts[x] + 3 }); // x win
    rec(i + 1, { ...pts, [x]: pts[x] + 1, [y]: pts[y] + 1 }); // draw
    rec(i + 1, { ...pts, [y]: pts[y] + 3 }); // y win
  };
  rec(0, { ...currentPoints });

  let secured = true; // guaranteed top-two in every scenario
  let firstSecured = true; // guaranteed first in every scenario
  let firstPossible = false; // can finish first in at least one scenario
  for (const f of combos) {
    const tp = f[target];
    const aheadOrEqual = teams.filter((t) => t !== target && f[t] >= tp).length;
    const strictlyAhead = teams.filter((t) => t !== target && f[t] > tp).length;
    if (aheadOrEqual > 1) secured = false; // ≥2 others could be above it → maybe 3rd
    if (aheadOrEqual > 0) firstSecured = false; // someone matches/beats it → not certain 1st
    if (strictlyAhead === 0) firstPossible = true; // nobody strictly above → could be 1st
  }

  if (!secured) return "must-play";
  if (firstSecured) return "settled-top";
  if (!firstPossible) return "settled-second";
  // Through and first is still mathematically live: only flag rotation when the
  // team is a comfortable leader; a tight top-of-the-group is a real race.
  const maxOther = Math.max(
    ...teams.filter((t) => t !== target).map((t) => currentPoints[t])
  );
  return currentPoints[target] - maxOther >= ROTATION_LEAD
    ? "comfortable"
    : "race-for-first";
}

/** Capped, signed (≤ 0) rotation nudge for a stakes state. */
export function matchStakesDelta(
  state: StakesState,
  rotationTendency: number = DEFAULT_ROTATION_TENDENCY
): number {
  const w = ROTATION_WEIGHT[state];
  if (w === 0) return 0;
  const raw = ROTATION_ELO * w * Math.max(0, Math.min(1, rotationTendency));
  return -Math.min(ROTATION_CAP, Math.round(raw));
}

/** Build a group's current points table and still-to-play fixtures from results. */
function groupSituation(
  team: string
): { points: Record<string, number>; remaining: [string, string][] } {
  const teams = groupOf(team).teams;
  const points: Record<string, number> = {};
  for (const t of teams) points[t] = 0;
  const remaining: [string, string][] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i];
      const b = teams[j];
      const res = getCompletedFixture(a, b);
      if (!res) {
        remaining.push([a, b]);
        continue;
      }
      if (res.scoreA > res.scoreB) points[a] += 3;
      else if (res.scoreB > res.scoreA) points[b] += 3;
      else {
        points[a] += 1;
        points[b] += 1;
      }
    }
  }
  return { points, remaining };
}

/** Engine-facing stakes state for `team` in its fixture against `opponent`. */
export function getMatchStakesState(team: string, opponent: string): StakesState {
  if (!isGroupFixture(team, opponent)) return "done";
  const { points, remaining } = groupSituation(team);
  return classifyStakes(team, points, remaining);
}

/** Engine-facing rotation nudge (≤ 0) for `team` against `opponent`. */
export function getMatchStakes(team: string, opponent: string): number {
  return matchStakesDelta(getMatchStakesState(team, opponent));
}

/** Short, human-readable reason for a (rotation-flagged) stakes state. */
export function describeStakes(state: StakesState): string {
  switch (state) {
    case "settled-top":
      return "group win already secured";
    case "settled-second":
      return "through but cannot finish first";
    case "comfortable":
      return "comfortable group leader, little left to play for";
    default:
      return "place not yet settled";
  }
}

/** Metadata for transparent UI labelling. */
export function matchStakesMeta(): {
  rotationElo: number;
  cap: number;
  lead: number;
  defaultTendency: number;
} {
  return {
    rotationElo: ROTATION_ELO,
    cap: ROTATION_CAP,
    lead: ROTATION_LEAD,
    defaultTendency: DEFAULT_ROTATION_TENDENCY,
  };
}
