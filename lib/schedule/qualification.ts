/**
 * GROUP-STAGE QUALIFICATION → resolved Round of 32.
 *
 * Once every group has played all six round-robin games, the knockout field is
 * fully determined and we can resolve the official 2026 Round-of-32 slots to
 * concrete teams — instead of leaving them as "1A / 2B / 3rd→M74" placeholders.
 *
 * This is computed PURELY from completed results (via computeStandings):
 *   • Per group, the standings order gives the winner (1st), runner-up (2nd)
 *     and third place — exactly what the bracket's positional slots consume.
 *   • The eight best third-placed teams are the eight whose group-third row
 *     ranks highest across all 12 groups on the standard, computable ordering
 *     (points → goal difference → goals scored). FIFA's deeper tiebreak
 *     (fair-play, then drawing of lots) isn't derivable from results, so a
 *     deterministic group-letter fallback stands in — the same approximation the
 *     prediction engine uses for cross-group comparison.
 *   • The eight qualifying third GROUPS are handed to the Annex C resolver in
 *     bracket-2026.ts, which fixes each to its official third-placed slot.
 *
 * Nothing is invented: if the group stage is not complete, `complete` is false
 * and the R32 stays unresolved (the UI keeps showing positional slots).
 */

import type { GroupFixtures } from "./buildSchedule";
import { computeStandings, type GroupStanding, type StandingRow } from "./standings";
import {
  resolveRoundOf32,
  type GroupLetter,
  type RankedTeam,
  type ResolvedR32Match,
  type ThirdSlotId,
} from "@/lib/competitions/world-cup/bracket-2026";

/** Games in a 4-team round-robin group. */
const GROUP_GAMES = 6;

export interface RankedThird {
  slug: string;
  group: string;
  row: StandingRow;
  rank: number; // 1..12 across all group thirds
  qualified: boolean; // among the best 8
}

export interface Qualification {
  /** True once every group has all six results in. */
  complete: boolean;
  standings: GroupStanding[];
  /** Resolved Round-of-32 matchups (empty until `complete`). */
  r32: ResolvedR32Match[];
  /** The 8 best third-placed GROUPS, in qualification rank order. */
  thirdGroups: GroupLetter[];
  /** All 12 third-placed teams ranked, with a qualified flag (empty until complete). */
  thirds: RankedThird[];
  thirdAssignment: Record<ThirdSlotId, GroupLetter> | null;
}

/** Cross-group ordering for third-placed teams (a above b → negative). */
function compareThird(
  a: { group: string; row: StandingRow },
  b: { group: string; row: StandingRow }
): number {
  return (
    b.row.points - a.row.points ||
    b.row.goalDiff - a.row.goalDiff ||
    b.row.goalsFor - a.row.goalsFor ||
    // Deterministic, results-independent fallback (FIFA would use fair-play /
    // drawing of lots here — not computable from scores alone).
    (a.group < b.group ? -1 : a.group > b.group ? 1 : 0)
  );
}

/**
 * Resolve the knockout field from the merged group fixtures (live + manual
 * results already folded in). Safe to call at any point in the tournament.
 */
export function resolveQualification(groups: GroupFixtures[]): Qualification {
  const standings = computeStandings(groups);

  const complete = groups.every(
    (g) =>
      g.rows.filter(
        (r) =>
          r.status === "Finished" &&
          typeof r.goalsA === "number" &&
          typeof r.goalsB === "number"
      ).length >= GROUP_GAMES
  );

  if (!complete) {
    return {
      complete: false,
      standings,
      r32: [],
      thirdGroups: [],
      thirds: [],
      thirdAssignment: null,
    };
  }

  // Rank every group's third-placed team across the 12 groups.
  const thirdEntries = standings
    .map((s) => ({ group: s.group, row: s.rows[2] }))
    .sort(compareThird);

  const thirds: RankedThird[] = thirdEntries.map((t, i) => ({
    slug: t.row.slug,
    group: t.group,
    row: t.row,
    rank: i + 1,
    qualified: i < 8,
  }));

  const thirdGroups = thirds
    .filter((t) => t.qualified)
    .map((t) => t.group as GroupLetter);

  // Build per-group ranked results (winner / runner-up / third / fourth) and
  // resolve the official R32 slots through the Annex C assignment.
  const groupResults: Record<GroupLetter, RankedTeam[]> = {} as Record<
    GroupLetter,
    RankedTeam[]
  >;
  for (const s of standings) {
    groupResults[s.group as GroupLetter] = s.rows.map((r) => ({ slug: r.slug }));
  }
  const { matches, thirdAssignment } = resolveRoundOf32(groupResults, thirdGroups);

  return {
    complete: true,
    standings,
    r32: matches,
    thirdGroups,
    thirds,
    thirdAssignment,
  };
}
