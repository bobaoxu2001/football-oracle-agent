/**
 * KNOCKOUT-PATH EXPLAINER — the "who would they actually have to beat?" layer.
 *
 * Raw champion odds already price the draw (the Monte-Carlo routes through the
 * real FIFA bracket), but they don't TELL you why a high-Elo seed is capped:
 * that it landed in a quarter with two other giants, or that its Round-of-16
 * lands on the hosts. This module makes that legible. It is pure analysis — no
 * Elo nudges, no betting — so it lives beside the engine and is consumed by the
 * agent's narrative and the schedule UI.
 *
 * It works off the OFFICIAL routing in bracket-2026.ts (slot definitions +
 * winnerOf tree) and a SEEDING (which team finished 1st/2nd/3rd in each group).
 * The default seeding is projected from the real recorded standings plus a
 * deterministic Elo read of the games still to play, so the path reflects where
 * things actually stand — not a from-scratch replay.
 *
 * For each round on a team's path it reports the opponent:
 *   • Round of 32 — EXACT (the other team in the team's own R32 slot).
 *   • R16 → Final  — the PROJECTED danger: the highest-rated team in the opposing
 *     sub-bracket (the most likely single opponent, clearly labelled as such).
 *
 * No engine import (avoids a cycle): remaining group games are projected with a
 * plain effective-Elo + host-bonus read, which is all the routing needs.
 */

import {
  BRACKET_2026,
  resolveRoundOf32,
  type GroupLetter,
  type RankedTeam,
} from "./bracket-2026";
import { GROUPS, getGroup, getTeam, HOST_SLUGS } from "@/lib/seed/world-cup-2026-groups";
import { HOME_ADVANTAGE } from "@/lib/prediction-engine/ratings";
import { getEffectiveRating } from "@/lib/prediction-engine/availabilityAdjustments";
import { getCompletedFixture } from "@/lib/prediction-engine/completedFixtures";

/** Per group, the projected finishers (slugs) in order: [1st, 2nd, 3rd, 4th]. */
export type Seeding = Record<GroupLetter, string[]>;

const ROUND_NAME: Record<string, string> = {
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  Final: "Final",
};

function hostBonus(a: string, b: string): number {
  if (HOST_SLUGS.has(a) && !HOST_SLUGS.has(b)) return HOME_ADVANTAGE;
  if (HOST_SLUGS.has(b) && !HOST_SLUGS.has(a)) return -HOME_ADVANTAGE;
  return 0;
}

/**
 * Project a group's final order from recorded results + a deterministic Elo read
 * of the games still to play (closer than DRAW_BAND on effective Elo → draw).
 * Ranks on points → goal difference → goals scored → effective Elo.
 */
const DRAW_BAND = 35;
function projectGroupOrder(groupName: GroupLetter): string[] {
  const teams = getGroup(groupName).teams;
  const pts: Record<string, number> = {};
  const gd: Record<string, number> = {};
  const gf: Record<string, number> = {};
  for (const t of teams) {
    pts[t] = 0;
    gd[t] = 0;
    gf[t] = 0;
  }
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const a = teams[i];
      const b = teams[j];
      const res = getCompletedFixture(a, b);
      let ga: number;
      let gb: number;
      if (res) {
        ga = res.scoreA;
        gb = res.scoreB;
      } else {
        // Project the unplayed game from effective Elo (+ host bonus).
        const diff = getEffectiveRating(a) + hostBonus(a, b) - getEffectiveRating(b);
        if (Math.abs(diff) < DRAW_BAND) {
          ga = 1;
          gb = 1;
        } else if (diff > 0) {
          ga = 1;
          gb = 0;
        } else {
          ga = 0;
          gb = 1;
        }
      }
      gf[a] += ga;
      gf[b] += gb;
      gd[a] += ga - gb;
      gd[b] += gb - ga;
      if (ga > gb) pts[a] += 3;
      else if (gb > ga) pts[b] += 3;
      else {
        pts[a] += 1;
        pts[b] += 1;
      }
    }
  }
  return [...teams].sort(
    (x, y) =>
      pts[y] - pts[x] ||
      gd[y] - gd[x] ||
      gf[y] - gf[x] ||
      getEffectiveRating(y) - getEffectiveRating(x) ||
      (x < y ? -1 : 1)
  );
}

/** Default projected seeding for all 12 groups (1st…4th slugs each). */
export function projectSeeding(): Seeding {
  const out = {} as Seeding;
  for (const g of GROUPS) out[g.name as GroupLetter] = projectGroupOrder(g.name as GroupLetter);
  return out;
}

/** The 8 best third-placed GROUPS under the seeding (points → GD → GF → Elo). */
function bestThirdGroups(seeding: Seeding): GroupLetter[] {
  const order = projectStandingsValues(seeding);
  const thirds = GROUPS.map((g) => {
    const slug = seeding[g.name as GroupLetter][2];
    return { letter: g.name as GroupLetter, slug };
  });
  thirds.sort((a, b) => order(b.slug) - order(a.slug));
  return thirds.slice(0, 8).map((t) => t.letter);
}

/** A coarse ranking value for a team (effective Elo) — used to rank thirds/branches. */
function projectStandingsValues(_seeding: Seeding): (slug: string) => number {
  // Thirds across groups can't be compared on points cleanly here without the
  // projected points table; effective Elo is a defensible, deterministic proxy
  // for "which thirds are strongest", consistent with the engine's own
  // cross-group tiebreak approximation (rankAcrossGroups falls back to Elo).
  return (slug: string) => getEffectiveRating(slug);
}

/** parentMatchNo[m] = the match that consumes the winner of match m (or undefined). */
function buildParentMap(): Record<number, number> {
  const parent: Record<number, number> = {};
  for (const m of BRACKET_2026) {
    for (const p of [m.home, m.away]) {
      if (p.kind === "winnerOf") parent[p.match] = m.no;
    }
  }
  return parent;
}

/** The two child match numbers feeding a match (null where a child is a group slot). */
function childrenOf(no: number): [number | null, number | null] {
  const m = BRACKET_2026.find((x) => x.no === no)!;
  const child = (p: typeof m.home) => (p.kind === "winnerOf" ? p.match : null);
  return [child(m.home), child(m.away)];
}

export interface PathStep {
  round: string; // human round name
  matchNo: number;
  opponentSlug: string;
  opponentLabel: string; // e.g. "1A · Mexico" or "1E/1F (projected) · Germany"
  exact: boolean; // true only at R32 (the other team in your own slot)
}

export interface KnockoutPath {
  slug: string;
  qualifiedAs: "1st" | "2nd" | "3rd" | null; // null = not projected to reach R32
  group: GroupLetter;
  quarter: number; // 1..4 (which QF region), 0 if not qualified
  steps: PathStep[];
}

/** All team slugs reachable in a match's sub-bracket, under a resolved R32. */
function subtreeTeams(no: number, r32: Record<number, [string, string]>): string[] {
  if (r32[no]) return [...r32[no]];
  const [c1, c2] = childrenOf(no);
  return [
    ...(c1 ? subtreeTeams(c1, r32) : []),
    ...(c2 ? subtreeTeams(c2, r32) : []),
  ];
}

/** Strongest (highest effective-Elo) team in a sub-bracket — the projected danger. */
function favouriteOf(no: number, r32: Record<number, [string, string]>): string {
  const teams = subtreeTeams(no, r32);
  return teams.reduce((best, t) => (getEffectiveRating(t) > getEffectiveRating(best) ? t : best));
}

/** Which group finished a slug as 1st/2nd/3rd (for a readable label). */
function seedLabel(slug: string, seeding: Seeding): string {
  for (const g of GROUPS) {
    const order = seeding[g.name as GroupLetter];
    const idx = order.indexOf(slug);
    if (idx === 0) return `1${g.name}`;
    if (idx === 1) return `2${g.name}`;
    if (idx === 2) return `3${g.name}`;
  }
  return "?";
}

/** Map each QF match (97–100) to a quarter index 1..4 for difficulty grouping. */
const QF_MATCH_TO_QUARTER: Record<number, number> = { 97: 1, 98: 2, 99: 3, 100: 4 };

/**
 * Project a team's full knockout path from a seeding (defaults to projectSeeding()).
 * Returns qualifiedAs=null with no steps if the team isn't projected to reach R32.
 */
export function knockoutPath(slug: string, seeding: Seeding = projectSeeding()): KnockoutPath {
  const group = GROUPS.find((g) => g.teams.includes(slug))!.name as GroupLetter;
  const order = seeding[group];
  const posIdx = order.indexOf(slug);
  const qualifiedAs = posIdx === 0 ? "1st" : posIdx === 1 ? "2nd" : posIdx === 2 ? "3rd" : null;

  // Resolve the R32 with this seeding (thirds: best-8 groups → Annex C slots).
  const groupResults: Record<GroupLetter, RankedTeam[]> = {} as Record<GroupLetter, RankedTeam[]>;
  for (const g of GROUPS)
    groupResults[g.name as GroupLetter] = seeding[g.name as GroupLetter].map((s) => ({ slug: s }));
  const thirds = bestThirdGroups(seeding);
  const { matches } = resolveRoundOf32(groupResults, thirds);
  const r32: Record<number, [string, string]> = {};
  for (const m of matches) r32[m.no] = [m.home, m.away];

  // Is this team actually in the R32 field? (A 3rd that missed the best-8 isn't.)
  const myR32 = matches.find((m) => m.home === slug || m.away === slug);
  if (!myR32) return { slug, qualifiedAs: null, group, quarter: 0, steps: [] };

  const parent = buildParentMap();
  const steps: PathStep[] = [];

  // R32 — exact opponent (the other team in your slot).
  const r32Opp = myR32.home === slug ? myR32.away : myR32.home;
  steps.push({
    round: ROUND_NAME.R32,
    matchNo: myR32.no,
    opponentSlug: r32Opp,
    opponentLabel: `${seedLabel(r32Opp, seeding)} · ${getTeam(r32Opp).name}`,
    exact: true,
  });

  // Climb the tree; at each level the danger = favourite of the sibling sub-bracket.
  let cur = myR32.no;
  let quarter = 0;
  while (parent[cur] !== undefined) {
    const p = parent[cur];
    const [c1, c2] = childrenOf(p);
    const siblingMatch = c1 === cur ? c2 : c1;
    const pm = BRACKET_2026.find((x) => x.no === p)!;
    if (siblingMatch != null) {
      const oppFav = favouriteOf(siblingMatch, r32);
      steps.push({
        round: ROUND_NAME[pm.round],
        matchNo: p,
        opponentSlug: oppFav,
        opponentLabel: `${seedLabel(oppFav, seeding)} · ${getTeam(oppFav).name} (projected)`,
        exact: false,
      });
    }
    cur = p;
  }

  // Determine quarter: find the QF (97–100) on the path.
  for (const m of BRACKET_2026) {
    if (QF_MATCH_TO_QUARTER[m.no]) {
      const teams = subtreeTeams(m.no, r32);
      if (teams.includes(slug)) {
        quarter = QF_MATCH_TO_QUARTER[m.no];
        break;
      }
    }
  }

  return { slug, qualifiedAs, group, quarter, steps };
}

export interface QuarterField {
  quarter: number; // 1..4
  qfMatch: number; // 97..100
  winners: string[]; // group-winner slugs projected into this quarter
  topTeams: string[]; // strongest 3 teams in the quarter (by effective Elo)
  difficulty: number; // sum of the top-3 effective Elos (higher = harder)
}

/** Summarise the four quarter regions and their strength (for "death quarter" reads). */
export function quarterFields(seeding: Seeding = projectSeeding()): QuarterField[] {
  const groupResults: Record<GroupLetter, RankedTeam[]> = {} as Record<GroupLetter, RankedTeam[]>;
  for (const g of GROUPS)
    groupResults[g.name as GroupLetter] = seeding[g.name as GroupLetter].map((s) => ({ slug: s }));
  const { matches } = resolveRoundOf32(groupResults, bestThirdGroups(seeding));
  const r32: Record<number, [string, string]> = {};
  for (const m of matches) r32[m.no] = [m.home, m.away];

  return [97, 98, 99, 100].map((qf) => {
    const teams = subtreeTeams(qf, r32);
    const winners = teams.filter((t) => seedLabel(t, seeding).startsWith("1"));
    const top = [...teams].sort((a, b) => getEffectiveRating(b) - getEffectiveRating(a)).slice(0, 3);
    return {
      quarter: QF_MATCH_TO_QUARTER[qf],
      qfMatch: qf,
      winners,
      topTeams: top,
      difficulty: top.reduce((s, t) => s + getEffectiveRating(t), 0),
    };
  });
}

/** A short, deterministic English path summary for a team (agent/UI friendly). */
export function describePath(slug: string, seeding: Seeding = projectSeeding()): string {
  const p = knockoutPath(slug, seeding);
  const name = getTeam(slug).name;
  if (!p.qualifiedAs || p.steps.length === 0)
    return `${name} is not currently projected to reach the Round of 32.`;
  const legs = p.steps
    .map((s) => `${s.round}: ${getTeam(s.opponentSlug).name}${s.exact ? "" : " (projected)"}`)
    .join(" → ");
  return `${name} (projected ${p.qualifiedAs} of Group ${p.group}, quarter ${p.quarter}) — ${legs}.`;
}
