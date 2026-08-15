/**
 * Validation suite for the official 2026 World Cup tournament format.
 *
 * Run with:  npm run validate:bracket
 *
 * Confirms:
 *   • the R32 bracket matches the official spec (no generic seeding);
 *   • all 12 winners + 12 runners-up + 8 thirds are placed in the right slots;
 *   • every Annex C combination (all 495) resolves to allowed third-placed slots;
 *   • every resolved Round of 32 has exactly 32 distinct teams, no duplicates;
 *   • best third-placed teams only ever land in allowed slots;
 *   • the champion-probability Monte Carlo still runs and is well-formed.
 *
 * Exits with code 1 if any check fails.
 */

import {
  GROUP_LETTERS,
  THIRD_PLACE_ALLOWED,
  allThirdCombinations,
  resolveRoundOf32,
  validateBracketStructure,
  validateAnnexCResolvable,
  type GroupLetter,
  type RankedTeam,
  type ThirdSlotId,
} from "@/lib/competitions/world-cup/bracket-2026";
import { getChampionProbabilities, simulateTournament } from "@/lib/prediction-engine";

let failures = 0;
function report(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Synthetic, RNG-free group standings: "{letter}-1st" .. "{letter}-4th".
function fakeGroupResults(): Record<GroupLetter, RankedTeam[]> {
  const r = {} as Record<GroupLetter, RankedTeam[]>;
  for (const g of GROUP_LETTERS) {
    r[g] = [{ slug: `${g}-1st` }, { slug: `${g}-2nd` }, { slug: `${g}-3rd` }, { slug: `${g}-4th` }];
  }
  return r;
}

console.log("\n── 1. Bracket structure (official 2026 spec) ──────────────────────");
for (const c of validateBracketStructure()) report(c.name, c.ok, c.detail);

console.log("\n── 2. Annex C — all 495 third-placed combinations ─────────────────");
const annex = validateAnnexCResolvable();
report(annex.name, annex.ok, annex.detail);

console.log("\n── 3. Resolved Round of 32 integrity (synthetic, all 495 combos) ──");
{
  const fake = fakeGroupResults();
  const combos = allThirdCombinations();
  let dupeIssues = 0;
  let countIssues = 0;
  let winnerSlotIssues = 0;
  let thirdSlotIssues = 0;

  for (const combo of combos) {
    const comboSet = new Set(combo);
    const { matches, thirdAssignment } = resolveRoundOf32(fake, combo);

    // 16 matches, 32 participants
    const slugs = matches.flatMap((m) => [m.home, m.away]);
    if (matches.length !== 16 || slugs.length !== 32) countIssues++;
    if (new Set(slugs).size !== 32) dupeIssues++;

    for (const m of matches) {
      for (const [label, slug] of [
        [m.homeLabel, m.home],
        [m.awayLabel, m.away],
      ] as const) {
        if (/^1[A-L]$/.test(label)) {
          const g = label[1];
          if (slug !== `${g}-1st`) winnerSlotIssues++;
        } else if (/^2[A-L]$/.test(label)) {
          const g = label[1];
          if (slug !== `${g}-2nd`) winnerSlotIssues++;
        } else if (label.startsWith("3rd→")) {
          const slot = label.slice(4) as ThirdSlotId;
          const assignedGroup = thirdAssignment[slot];
          // (a) routed group must be allowed in this slot
          if (!THIRD_PLACE_ALLOWED[slot].includes(assignedGroup)) thirdSlotIssues++;
          // (b) routed group must be one of the qualifying thirds
          if (!comboSet.has(assignedGroup)) thirdSlotIssues++;
          // (c) the slug must be that group's third-placed team
          if (slug !== `${assignedGroup}-3rd`) thirdSlotIssues++;
        }
      }
    }
  }

  report("Every R32 has exactly 32 teams (16 matches)", countIssues === 0, `${countIssues} combos off`);
  report("No duplicate team in any R32", dupeIssues === 0, `${dupeIssues} combos with dupes`);
  report("Group winners & runners-up in correct fixed slots", winnerSlotIssues === 0, `${winnerSlotIssues} issues`);
  report("Best thirds only in allowed slots & correct team", thirdSlotIssues === 0, `${thirdSlotIssues} issues`);
}

console.log("\n── 4. Champion-probability Monte Carlo ────────────────────────────");
{
  const sims = 2000;
  const res = simulateTournament(sims);
  const champs = res.champions;

  report("48 teams present in champion table", champs.length === 48, `${champs.length} teams`);

  const champSum = champs.reduce((a, c) => a + c.champion, 0);
  report("Champion probabilities sum to ~1", Math.abs(champSum - 1) < 0.02, `sum=${champSum.toFixed(3)}`);

  // Exactly 32 teams reach R32 each sim → sum of roundOf32 shares ≈ 32.
  const r32Sum = champs.reduce((a, c) => a + c.roundOf32, 0);
  report("Exactly 32 qualifiers each simulation", Math.abs(r32Sum - 32) < 0.001, `sum=${r32Sum.toFixed(2)}`);

  // Monotonic funnel: champion ≤ final ≤ semi ≤ QF ≤ R16 ≤ R32 for every team.
  const monoOk = champs.every(
    (c) =>
      c.champion <= c.final + 1e-9 &&
      c.final <= c.semiFinal + 1e-9 &&
      c.semiFinal <= c.quarterFinal + 1e-9 &&
      c.quarterFinal <= c.roundOf16 + 1e-9 &&
      c.roundOf16 <= c.roundOf32 + 1e-9
  );
  report("Reach funnel is monotonic for all teams", monoOk);

  console.log(
    "   Top 5 title contenders:",
    champs
      .slice(0, 5)
      .map((c) => `${c.name} ${(c.champion * 100).toFixed(1)}%`)
      .join(" · ")
  );
}

console.log(
  `\n${failures === 0 ? "🎉 All checks passed." : `💥 ${failures} check(s) failed.`}\n`
);
process.exit(failures === 0 ? 0 : 1);
