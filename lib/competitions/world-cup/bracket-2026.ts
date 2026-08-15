/**
 * Official FIFA World Cup 2026 knockout bracket routing.
 *
 * The 2026 tournament is 48 teams · 12 groups (A–L) of 4. Qualification:
 *   • 12 group winners        (1A … 1L)
 *   • 12 group runners-up      (2A … 2L)
 *   • 8 best third-placed teams (the best 8 of the 12 group thirds)
 *   = 32 teams enter the Round of 32.
 *
 * The Round of 32 is NOT a generic 1-vs-32 performance seed. FIFA fixes every
 * slot in advance (Match 73 = 2A v 2B, Match 74 = 1E v a third-placed team,
 * etc.). The only thing decided after the group stage is WHICH third-placed
 * team lands in each of the 8 "third-placed" slots — governed by FIFA's
 * "Annex C" combination table (which 8 of the 12 groups produced the best
 * thirds → a fixed assignment to slots).
 *
 * This module encodes:
 *   • the exact R32 slot definitions (matches 73–88),
 *   • the fixed knockout tree (R16 89–96, QF 97–100, SF 101–102, Final 104),
 *   • the Annex C allowed-group sets per third-placed slot, and
 *   • a deterministic resolver that assigns the 8 qualifying thirds to slots
 *     while honouring those allowed sets (a valid Annex C matching).
 *
 * It is pure data + pure functions (no Elo / RNG), so it is fully unit-testable.
 */

export type GroupLetter =
  | "A" | "B" | "C" | "D" | "E" | "F"
  | "G" | "H" | "I" | "J" | "K" | "L";

export const GROUP_LETTERS: GroupLetter[] = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L",
];

/** The 8 Round-of-32 slots that receive a best-third-placed team. */
export type ThirdSlotId = "M74" | "M77" | "M79" | "M80" | "M81" | "M82" | "M85" | "M87";

export const THIRD_SLOT_ORDER: ThirdSlotId[] = [
  "M74", "M77", "M79", "M80", "M81", "M82", "M85", "M87",
];

/**
 * FIFA Annex C — for each third-placed slot, the set of groups whose third-
 * placed team is permitted to be routed there. The actual group chosen depends
 * on the overall combination of the 8 qualifying groups (see resolver below).
 *
 * Source: FIFA World Cup 2026 match schedule / Annex C bracket routing.
 */
export const THIRD_PLACE_ALLOWED: Record<ThirdSlotId, GroupLetter[]> = {
  M74: ["A", "B", "C", "D", "F"], // 1E vs 3rd
  M77: ["C", "D", "F", "G", "H"], // 1I vs 3rd
  M79: ["C", "E", "F", "H", "I"], // 1A vs 3rd
  M80: ["E", "H", "I", "J", "K"], // 1L vs 3rd
  M81: ["B", "E", "F", "I", "J"], // 1D vs 3rd
  M82: ["A", "E", "H", "I", "J"], // 1G vs 3rd
  M85: ["E", "F", "G", "I", "J"], // 1B vs 3rd
  M87: ["D", "E", "I", "J", "L"], // 1K vs 3rd
};

/** A participant slot in a bracket match. */
export type Position =
  | { kind: "winner"; group: GroupLetter } // 1X
  | { kind: "runnerUp"; group: GroupLetter } // 2X
  | { kind: "third"; slot: ThirdSlotId } // best-third placed (Annex C)
  | { kind: "winnerOf"; match: number }; // winner of a prior match

export type Round = "R32" | "R16" | "QF" | "SF" | "Final";

export interface BracketMatch {
  no: number; // official FIFA match number
  round: Round;
  home: Position;
  away: Position;
}

/**
 * The official 2026 knockout bracket. Match numbers and pairings follow the
 * published FIFA 2026 schedule. (Match 103, the third-place play-off, is
 * intentionally omitted — it does not affect champion routing.)
 */
export const BRACKET_2026: BracketMatch[] = [
  // ── Round of 32 (matches 73–88) ──────────────────────────────────────────
  { no: 73, round: "R32", home: { kind: "runnerUp", group: "A" }, away: { kind: "runnerUp", group: "B" } },
  { no: 74, round: "R32", home: { kind: "winner", group: "E" }, away: { kind: "third", slot: "M74" } },
  { no: 75, round: "R32", home: { kind: "winner", group: "F" }, away: { kind: "runnerUp", group: "C" } },
  { no: 76, round: "R32", home: { kind: "winner", group: "C" }, away: { kind: "runnerUp", group: "F" } },
  { no: 77, round: "R32", home: { kind: "winner", group: "I" }, away: { kind: "third", slot: "M77" } },
  { no: 78, round: "R32", home: { kind: "runnerUp", group: "E" }, away: { kind: "runnerUp", group: "I" } },
  { no: 79, round: "R32", home: { kind: "winner", group: "A" }, away: { kind: "third", slot: "M79" } },
  { no: 80, round: "R32", home: { kind: "winner", group: "L" }, away: { kind: "third", slot: "M80" } },
  { no: 81, round: "R32", home: { kind: "winner", group: "D" }, away: { kind: "third", slot: "M81" } },
  { no: 82, round: "R32", home: { kind: "winner", group: "G" }, away: { kind: "third", slot: "M82" } },
  { no: 83, round: "R32", home: { kind: "runnerUp", group: "K" }, away: { kind: "runnerUp", group: "L" } },
  { no: 84, round: "R32", home: { kind: "winner", group: "H" }, away: { kind: "runnerUp", group: "J" } },
  { no: 85, round: "R32", home: { kind: "winner", group: "B" }, away: { kind: "third", slot: "M85" } },
  { no: 86, round: "R32", home: { kind: "winner", group: "J" }, away: { kind: "runnerUp", group: "H" } },
  { no: 87, round: "R32", home: { kind: "winner", group: "K" }, away: { kind: "third", slot: "M87" } },
  { no: 88, round: "R32", home: { kind: "runnerUp", group: "D" }, away: { kind: "runnerUp", group: "G" } },

  // ── Round of 16 (matches 89–96) ──────────────────────────────────────────
  { no: 89, round: "R16", home: { kind: "winnerOf", match: 73 }, away: { kind: "winnerOf", match: 75 } },
  { no: 90, round: "R16", home: { kind: "winnerOf", match: 74 }, away: { kind: "winnerOf", match: 77 } },
  { no: 91, round: "R16", home: { kind: "winnerOf", match: 76 }, away: { kind: "winnerOf", match: 78 } },
  { no: 92, round: "R16", home: { kind: "winnerOf", match: 79 }, away: { kind: "winnerOf", match: 80 } },
  { no: 93, round: "R16", home: { kind: "winnerOf", match: 83 }, away: { kind: "winnerOf", match: 84 } },
  { no: 94, round: "R16", home: { kind: "winnerOf", match: 81 }, away: { kind: "winnerOf", match: 82 } },
  { no: 95, round: "R16", home: { kind: "winnerOf", match: 86 }, away: { kind: "winnerOf", match: 88 } },
  { no: 96, round: "R16", home: { kind: "winnerOf", match: 85 }, away: { kind: "winnerOf", match: 87 } },

  // ── Quarter-finals (matches 97–100) ──────────────────────────────────────
  { no: 97, round: "QF", home: { kind: "winnerOf", match: 89 }, away: { kind: "winnerOf", match: 90 } },
  { no: 98, round: "QF", home: { kind: "winnerOf", match: 93 }, away: { kind: "winnerOf", match: 94 } },
  { no: 99, round: "QF", home: { kind: "winnerOf", match: 91 }, away: { kind: "winnerOf", match: 92 } },
  { no: 100, round: "QF", home: { kind: "winnerOf", match: 95 }, away: { kind: "winnerOf", match: 96 } },

  // ── Semi-finals (matches 101–102) ────────────────────────────────────────
  { no: 101, round: "SF", home: { kind: "winnerOf", match: 97 }, away: { kind: "winnerOf", match: 98 } },
  { no: 102, round: "SF", home: { kind: "winnerOf", match: 99 }, away: { kind: "winnerOf", match: 100 } },

  // ── Final (match 104; 103 is the 3rd-place play-off, omitted) ─────────────
  { no: 104, round: "Final", home: { kind: "winnerOf", match: 101 }, away: { kind: "winnerOf", match: 102 } },
];

/** reach[] bucket index a match WINNER earns (0=R32 entry handled separately). */
export const REACH_BUCKET: Record<Round, number> = {
  R32: 1, // win in R32 → reached Round of 16
  R16: 2, // → reached quarter-final
  QF: 3, // → reached semi-final
  SF: 4, // → reached final
  Final: 5, // → champion
};

// ---------------------------------------------------------------------------
// Annex C — assign the 8 qualifying thirds to the 8 third-placed slots
// ---------------------------------------------------------------------------

/**
 * EXACT Annex C overrides. Optional, keyed by the sorted 8-group combination
 * (e.g. "ABCDEFGH"). If a full 8-entry override is present for a combination,
 * it is used verbatim; otherwise the deterministic matcher below computes a
 * rules-valid assignment.
 *
 * TODO(annex-c): populate with FIFA's exact published row for each of the 495
 * combinations where it differs from the computed matching. The matcher already
 * guarantees a VALID assignment (every third only lands in an allowed slot) for
 * all 495 combinations — these overrides would only pin the exact slot in the
 * rare cases where more than one valid matching exists.
 */
export const EXACT_ANNEX_C: Record<string, Record<ThirdSlotId, GroupLetter>> = {
  // "ABCDEFGH": { M74: "A", M77: "C", M79: "F", M80: "E", M81: "B", M82: "H", M85: "G", M87: "D" },

  // 2026 REAL tournament combination (B,D,E,F,I,J,K,L qualified as best thirds).
  // The deterministic matcher's alphabetical-first pass produces a DIFFERENT
  // valid matching (it swaps I↔J between M82/M85 — both are allowed-set-legal,
  // since M82 allows {A,E,H,I,J} and M85 allows {E,F,G,I,J}, so I and J are each
  // legal in either slot). Cross-checked against the real Wikipedia Round-of-32
  // fixture list on 1 July 2026 (Belgium v Senegal, Switzerland v Algeria) to
  // pin FIFA's actual published assignment rather than the matcher's guess.
  BDEFIJKL: { M74: "D", M77: "F", M79: "E", M80: "K", M81: "B", M82: "I", M85: "J", M87: "L" },
};

export function combinationKey(groups: GroupLetter[]): string {
  return [...groups].sort().join("");
}

/**
 * Deterministic bipartite matching (Kuhn's augmenting-path algorithm) of the
 * qualifying third-placed groups to the third-placed slots, honouring
 * THIRD_PLACE_ALLOWED. Groups are tried alphabetically and slots in fixed
 * order, so the same combination always yields the same assignment.
 *
 * Returns null if no perfect matching exists (should never happen for a valid
 * 8-of-12 combination — see validateAnnexCResolvable()).
 */
function matchThirdsToSlots(
  groups: GroupLetter[]
): Record<ThirdSlotId, GroupLetter> | null {
  const matchSlot: Partial<Record<ThirdSlotId, GroupLetter>> = {};

  const tryAssign = (g: GroupLetter, visited: Set<ThirdSlotId>): boolean => {
    for (const slot of THIRD_SLOT_ORDER) {
      if (!THIRD_PLACE_ALLOWED[slot].includes(g)) continue;
      if (visited.has(slot)) continue;
      visited.add(slot);
      const occupant = matchSlot[slot];
      if (occupant === undefined || tryAssign(occupant, visited)) {
        matchSlot[slot] = g;
        return true;
      }
    }
    return false;
  };

  for (const g of [...groups].sort()) {
    if (!tryAssign(g, new Set())) return null;
  }

  const assigned = THIRD_SLOT_ORDER.filter((s) => matchSlot[s] !== undefined);
  if (assigned.length !== groups.length) return null;
  return matchSlot as Record<ThirdSlotId, GroupLetter>;
}

/**
 * Assign the 8 best-third groups to the 8 third-placed R32 slots.
 *
 * 1. If a full EXACT_ANNEX_C override exists for this combination, use it.
 * 2. Otherwise compute a deterministic, rules-valid matching.
 * 3. Emergency fallback (should be unreachable): fill any unassigned slot with
 *    any remaining group so the simulation never crashes — flagged in dev.
 */
export function assignThirdPlaceSlots(
  groups: GroupLetter[]
): Record<ThirdSlotId, GroupLetter> {
  if (groups.length !== 8) {
    throw new Error(`Annex C expects exactly 8 third-placed groups, got ${groups.length}`);
  }

  const override = EXACT_ANNEX_C[combinationKey(groups)];
  if (override && THIRD_SLOT_ORDER.every((s) => override[s] !== undefined)) {
    return override;
  }

  const matched = matchThirdsToSlots(groups);
  if (matched) return matched;

  // Emergency fallback — preserves "32 distinct teams" even if a (theoretical)
  // unmatchable combination ever appeared. Should never run for real Annex C.
  if (process.env.NODE_ENV !== "production") {
    console.warn("[annex-c] no valid matching for", combinationKey(groups), "— using fallback");
  }
  const result: Partial<Record<ThirdSlotId, GroupLetter>> = {};
  const remaining = [...groups].sort();
  for (const slot of THIRD_SLOT_ORDER) {
    const pick =
      remaining.find((g) => THIRD_PLACE_ALLOWED[slot].includes(g)) ?? remaining[0];
    result[slot] = pick;
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return result as Record<ThirdSlotId, GroupLetter>;
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

/** Minimal shape the resolver needs from a group's ranked standings. */
export interface RankedTeam {
  slug: string;
}

export interface ResolveContext {
  /** Per group: ranked standings, index 0 = winner, 1 = runner-up, 2 = third. */
  groupResults: Record<GroupLetter, RankedTeam[]>;
  thirdAssignment: Record<ThirdSlotId, GroupLetter>;
  /** match number → winning team slug (filled as the bracket is played). */
  winners: Record<number, string>;
}

export function resolvePosition(pos: Position, ctx: ResolveContext): string {
  switch (pos.kind) {
    case "winner":
      return ctx.groupResults[pos.group][0].slug;
    case "runnerUp":
      return ctx.groupResults[pos.group][1].slug;
    case "third": {
      const group = ctx.thirdAssignment[pos.slot];
      return ctx.groupResults[group][2].slug;
    }
    case "winnerOf":
      return ctx.winners[pos.match];
  }
}

/** Human-readable label for a position (for debugging / tests / UI). */
export function positionLabel(pos: Position): string {
  switch (pos.kind) {
    case "winner":
      return `1${pos.group}`;
    case "runnerUp":
      return `2${pos.group}`;
    case "third":
      return `3rd→${pos.slot}`;
    case "winnerOf":
      return `W${pos.match}`;
  }
}

export interface ResolvedR32Match {
  no: number;
  home: string;
  away: string;
  homeLabel: string;
  awayLabel: string;
}

/**
 * Resolve the 16 Round-of-32 matchups to concrete team slugs given the group
 * results and which 8 groups produced the best thirds. Used by the simulator
 * and by the validation tests.
 */
export function resolveRoundOf32(
  groupResults: Record<GroupLetter, RankedTeam[]>,
  thirdGroups: GroupLetter[]
): { matches: ResolvedR32Match[]; thirdAssignment: Record<ThirdSlotId, GroupLetter> } {
  const thirdAssignment = assignThirdPlaceSlots(thirdGroups);
  const ctx: ResolveContext = { groupResults, thirdAssignment, winners: {} };
  const matches = BRACKET_2026.filter((m) => m.round === "R32").map((m) => ({
    no: m.no,
    home: resolvePosition(m.home, ctx),
    away: resolvePosition(m.away, ctx),
    homeLabel: positionLabel(m.home),
    awayLabel: positionLabel(m.away),
  }));
  return { matches, thirdAssignment };
}

export const R32_MATCHES = BRACKET_2026.filter((m) => m.round === "R32");
export const KNOCKOUT_MATCHES = BRACKET_2026.filter((m) => m.round !== "R32");

// ---------------------------------------------------------------------------
// Validation (pure, used by scripts/validate-bracket.ts)
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** The expected R32 slot spec, transcribed from the official requirements. */
const EXPECTED_R32: Record<number, [string, string]> = {
  73: ["2A", "2B"], 74: ["1E", "3rd→M74"], 75: ["1F", "2C"], 76: ["1C", "2F"],
  77: ["1I", "3rd→M77"], 78: ["2E", "2I"], 79: ["1A", "3rd→M79"], 80: ["1L", "3rd→M80"],
  81: ["1D", "3rd→M81"], 82: ["1G", "3rd→M82"], 83: ["2K", "2L"], 84: ["1H", "2J"],
  85: ["1B", "3rd→M85"], 86: ["1J", "2H"], 87: ["1K", "3rd→M87"], 88: ["2D", "2G"],
};

/** Verify the bracket structure matches the official 2026 spec (no generic seeding). */
export function validateBracketStructure(): CheckResult[] {
  const checks: CheckResult[] = [];

  // 1. R32 pairings exactly match the official spec.
  let r32Ok = true;
  const mismatches: string[] = [];
  for (const m of R32_MATCHES) {
    const exp = EXPECTED_R32[m.no];
    const got: [string, string] = [positionLabel(m.home), positionLabel(m.away)];
    if (!exp || exp[0] !== got[0] || exp[1] !== got[1]) {
      r32Ok = false;
      mismatches.push(`M${m.no}: got ${got.join(" v ")}, expected ${exp ? exp.join(" v ") : "?"}`);
    }
  }
  checks.push({
    name: "R32 pairings match official 2026 spec (not generic seeding)",
    ok: r32Ok && R32_MATCHES.length === 16,
    detail: r32Ok ? "All 16 R32 slots match." : mismatches.join("; "),
  });

  // 2. Group winners 1A–1L each appear exactly once in R32.
  const winners = new Set<string>();
  const runners = new Set<string>();
  const thirds = new Set<string>();
  for (const m of R32_MATCHES) {
    for (const p of [m.home, m.away]) {
      if (p.kind === "winner") winners.add(p.group);
      else if (p.kind === "runnerUp") runners.add(p.group);
      else if (p.kind === "third") thirds.add(p.slot);
    }
  }
  checks.push({
    name: "All 12 group winners (1A–1L) placed exactly once",
    ok: winners.size === 12,
    detail: `${winners.size}/12 distinct winners`,
  });
  checks.push({
    name: "All 12 runners-up (2A–2L) placed exactly once",
    ok: runners.size === 12,
    detail: `${runners.size}/12 distinct runners-up`,
  });
  checks.push({
    name: "All 8 third-placed slots present",
    ok: thirds.size === 8,
    detail: `${thirds.size}/8 third slots`,
  });

  // 3. Knockout tree: each match 73–102 feeds exactly one later match.
  const fedBy: Record<number, number> = {};
  for (const m of KNOCKOUT_MATCHES) {
    for (const p of [m.home, m.away]) {
      if (p.kind === "winnerOf") fedBy[p.match] = (fedBy[p.match] ?? 0) + 1;
    }
  }
  const treeIssues: string[] = [];
  for (let n = 73; n <= 102; n++) {
    if (fedBy[n] !== 1) treeIssues.push(`M${n} feeds ${fedBy[n] ?? 0} matches`);
  }
  if (fedBy[104]) treeIssues.push("Final (104) should not feed any match");
  checks.push({
    name: "Knockout tree is well-formed (each of 73–102 advances once)",
    ok: treeIssues.length === 0,
    detail: treeIssues.length ? treeIssues.join("; ") : "73→102 each advance exactly once; 104 is the final.",
  });

  return checks;
}

/** Enumerate all C(12,8)=495 third-placed combinations. */
export function allThirdCombinations(): GroupLetter[][] {
  const out: GroupLetter[][] = [];
  const n = GROUP_LETTERS.length;
  const choose = (start: number, acc: GroupLetter[]) => {
    if (acc.length === 8) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) {
      acc.push(GROUP_LETTERS[i]);
      choose(i + 1, acc);
      acc.pop();
    }
  };
  choose(0, []);
  return out;
}

/**
 * Verify that EVERY one of the 495 third-placed combinations resolves to a
 * valid Annex C assignment: 8 distinct slots, each group routed only to an
 * allowed slot, all input groups used exactly once.
 */
export function validateAnnexCResolvable(): CheckResult {
  const combos = allThirdCombinations();
  const failures: string[] = [];

  for (const combo of combos) {
    const a = assignThirdPlaceSlots(combo);
    const usedSlots = Object.keys(a) as ThirdSlotId[];
    const usedGroups = THIRD_SLOT_ORDER.map((s) => a[s]);

    if (usedSlots.length !== 8 || new Set(usedSlots).size !== 8) {
      failures.push(`${combinationKey(combo)}: not 8 distinct slots`);
      continue;
    }
    // Each assigned group must be allowed in its slot.
    const allowedOk = THIRD_SLOT_ORDER.every((s) =>
      THIRD_PLACE_ALLOWED[s].includes(a[s])
    );
    if (!allowedOk) {
      failures.push(`${combinationKey(combo)}: a group routed to a disallowed slot`);
      continue;
    }
    // The assigned groups must be exactly the input combination.
    if (combinationKey(usedGroups) !== combinationKey(combo)) {
      failures.push(`${combinationKey(combo)}: assigned groups ≠ qualifying groups`);
    }
  }

  return {
    name: "All 495 Annex C combinations resolve to valid third-placed slots",
    ok: failures.length === 0,
    detail:
      failures.length === 0
        ? `${combos.length}/495 combinations valid.`
        : `${failures.length} failed, e.g. ${failures.slice(0, 3).join("; ")}`,
  };
}
