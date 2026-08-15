/**
 * Deterministic analysis builders for the non-matchup intents:
 *
 *   GROUP_QUALIFICATION — who gets out of a group (incl. third-place note)
 *   PATH_ANALYSIS       — a team's likely route to the final
 *   TEAM_ANALYSIS       — one-team profile (strength, outlook, risks)
 *   TEAM_COMPARISON     — two teams side-by-side (general, not one match)
 *   MODEL_EXPLANATION   — how the agent itself works
 *
 * Every number here comes from the deterministic engine (Elo ratings, the
 * Dixon-Coles goal model, the seeded Monte Carlo tournament with the official
 * 2026 bracket). The optional LLM may rephrase these results but never
 * produces numbers. Squad-depth/form notes are derived proxies or stored
 * team_news signals and are labeled as such.
 */

import {
  simulateGroup,
  getChampionOddsFor,
  getEffectiveRating,
  getTacticalMatchup,
  gapCalibration,
} from "@/lib/prediction-engine";
import { expectedGoals } from "@/lib/prediction-engine/elo";
import { matchProb } from "@/lib/prediction-engine/elo";
import {
  R32_MATCHES,
  BRACKET_2026,
  positionLabel,
  type Position,
  type GroupLetter,
} from "@/lib/competitions/world-cup/bracket-2026";
import { GROUPS, getTeam, groupOf } from "@/lib/seed/world-cup-2026-groups";
import { computeDisciplineRisk, type DisciplineRisk } from "@/lib/competitions/world-cup/discipline";
import type { TeamNewsItem } from "@/lib/news/types";
import type { GroupSimRow } from "@/lib/types";
import type { GroupTableData, StructuredFactor, TeamRef } from "./types";

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;

/** Median Elo across the 48 qualified teams (attack/defense proxy baseline). */
function medianElo(): number {
  const elos = GROUPS.flatMap((g) => g.teams).map((t) => getEffectiveRating(t)).sort((a, b) => a - b);
  return elos[Math.floor(elos.length / 2)];
}

/** Elo rank of a team among the 48 (1 = strongest). */
function eloRank(slug: string): number {
  const elos = GROUPS.flatMap((g) => g.teams)
    .map((t) => ({ t, e: getEffectiveRating(t) }))
    .sort((a, b) => b.e - a.e);
  return elos.findIndex((x) => x.t === slug) + 1;
}

/** Attack/defense proxies: expected goals for/against vs a median-strength team. */
function strengthProfile(slug: string) {
  const elo = getEffectiveRating(slug);
  const med = medianElo();
  return {
    elo,
    rank: eloRank(slug),
    attack: expectedGoals(elo, med, 0), // expected goals vs median team
    defense: expectedGoals(med, elo, 0), // expected goals conceded vs median team (lower = better)
  };
}

function tierLabel(rank: number): string {
  if (rank <= 5) return "title contender";
  if (rank <= 12) return "dark-horse / quarter-final calibre";
  if (rank <= 24) return "knockout-stage calibre";
  return "underdog";
}

// ---------------------------------------------------------------------------
// GROUP QUALIFICATION
// ---------------------------------------------------------------------------

export function buildGroupQualification(groupName: string, focusSlug?: string) {
  const rows = simulateGroup(groupName);
  const top2 = rows.slice(0, 2);
  const focus = focusSlug ? rows.find((r) => r.slug === focusSlug) : undefined;

  const lines: string[] = [];
  lines.push(
    `**Group ${groupName} qualification picture** (from 20,000 simulated group stages):`
  );
  for (const r of rows) {
    lines.push(
      `• ${r.flag} ${r.name} — top-2 finish ${pct(r.advance)}, win the group ${pct(r.winGroup)}, expected points ${r.expectedPoints.toFixed(1)}`
    );
  }
  lines.push(
    `\nMost likely qualifiers: **${top2.map((r) => r.name).join(" and ")}**. ` +
      `Finishing third is not the end — **8 of the 12 third-placed teams also advance** to the Round of 32 ` +
      `(ranked by points → goal difference → goals scored → fair play → FIFA ranking), so a strong third in Group ${groupName} still has a real path.`
  );
  if (focus) {
    lines.push(
      `\n${focus.flag} **${focus.name}**: ${pct(focus.advance)} to finish top-2; including the best-third route their knockout chances are higher still.`
    );
  }
  lines.push(
    `\nTie-breakers if teams finish level on points: overall goal difference → overall goals scored → head-to-head among the tied teams → fair-play conduct points → FIFA ranking (the World Cup applies overall GD/GF before head-to-head, unlike UEFA).`
  );

  const factors: StructuredFactor[] = rows.map((r) => ({
    label: `${r.flag} ${r.name}`,
    value: `advance ${pct(r.advance)} · win group ${pct(r.winGroup)} · xPts ${r.expectedPoints.toFixed(1)}`,
    weight: r.advance >= 0.5 ? "high" : r.advance >= 0.25 ? "medium" : "low",
  }));

  return {
    table: { group: groupName, rows, focusSlug } satisfies GroupTableData,
    explanation: lines.join("\n"),
    summary: `Group ${groupName}: ${top2[0].name} (${pct(top2[0].advance)}) and ${top2[1].name} (${pct(top2[1].advance)}) are the most likely qualifiers; 8 of 12 third-placed teams also advance.`,
    factors,
    rankings: rows.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      flag: r.flag,
      advance: r.advance,
      winGroup: r.winGroup,
      expectedPoints: r.expectedPoints,
    })),
    rulesApplied: [
      "Top 2 per group qualify; 8 best third-placed teams also qualify (32 total)",
      "Group tie-breakers: points → overall GD → overall GF → head-to-head → fair play → FIFA ranking",
    ],
    confidence: Math.round(top2[0].advance * 100),
    limitations: [
      "Group probabilities come from 20,000 seeded Monte Carlo runs of the official fixtures; they reflect Elo strength, not lineups.",
    ],
  };
}

// ---------------------------------------------------------------------------
// PATH ANALYSIS
// ---------------------------------------------------------------------------

function describePosition(pos: Position): string {
  const label = positionLabel(pos);
  if (label.startsWith("3rd")) return `one of the best third-placed teams (Annex C slot ${label.slice(4)})`;
  if (/^1[A-L]$/.test(label)) return `the Group ${label[1]} winner`;
  if (/^2[A-L]$/.test(label)) return `the Group ${label[1]} runner-up`;
  return label;
}

/** Groups that can feed a bracket position (best-third pool reported separately). */
function feedingGroups(pos: Position): GroupLetter[] {
  if (pos.kind === "winner" || pos.kind === "runnerUp") return [pos.group];
  if (pos.kind === "third") return []; // Annex C pool — depends on which thirds advance
  const m = BRACKET_2026.find((x) => x.no === pos.match);
  if (!m) return [];
  return [...new Set([...feedingGroups(m.home), ...feedingGroups(m.away)])];
}

function sideHasThird(pos: Position): boolean {
  if (pos.kind === "third") return true;
  if (pos.kind !== "winnerOf") return false;
  const m = BRACKET_2026.find((x) => x.no === pos.match);
  return m ? sideHasThird(m.home) || sideHasThird(m.away) : false;
}

/** Strongest team by Elo among the given groups — a concrete example opponent. */
function strongestIn(groups: GroupLetter[], excludeSlug: string) {
  let best: { name: string; flag: string; elo: number } | null = null;
  for (const g of groups) {
    const grp = GROUPS.find((x) => x.name === g);
    if (!grp) continue;
    for (const slug of grp.teams) {
      if (slug === excludeSlug) continue;
      const elo = getEffectiveRating(slug);
      if (!best || elo > best.elo) {
        const t = getTeam(slug);
        best = { name: t.name, flag: t.flag, elo };
      }
    }
  }
  return best;
}

const ROUND_LABEL: Record<string, string> = {
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  Final: "Final",
};

/**
 * Trace the OFFICIAL bracket chain from an R32 match to the final: for each
 * later round, which match the team would play and which groups feed the
 * opposite side (with the strongest example opponent by Elo). Deterministic —
 * no invented fixtures, just the published routing.
 */
function tracePotentialPath(startMatchNo: number, mySlug: string) {
  const steps: { round: string; matchNo: number; oppGroups: GroupLetter[]; hasThird: boolean; example: ReturnType<typeof strongestIn> }[] = [];
  let current = startMatchNo;
  for (;;) {
    const next = BRACKET_2026.find(
      (m) =>
        (m.home.kind === "winnerOf" && m.home.match === current) ||
        (m.away.kind === "winnerOf" && m.away.match === current)
    );
    if (!next) break;
    const other = next.home.kind === "winnerOf" && next.home.match === current ? next.away : next.home;
    const oppGroups = feedingGroups(other);
    steps.push({
      round: ROUND_LABEL[next.round] ?? next.round,
      matchNo: next.no,
      oppGroups,
      hasThird: sideHasThird(other),
      example: strongestIn(oppGroups, mySlug),
    });
    current = next.no;
  }
  return steps;
}

export function buildPathAnalysis(team: TeamRef, status?: string) {
  const group = groupOf(team.slug);
  const odds = getChampionOddsFor(team.slug);
  const rows = simulateGroup(group.name);
  const mine = rows.find((r) => r.slug === team.slug)!;

  // Official bracket: where the Group X winner / runner-up lands in the R32.
  const winnerMatch = R32_MATCHES.find(
    (m) =>
      (m.home.kind === "winner" && m.home.group === group.name) ||
      (m.away.kind === "winner" && m.away.group === group.name)
  );
  const runnerMatch = R32_MATCHES.find(
    (m) =>
      (m.home.kind === "runnerUp" && m.home.group === group.name) ||
      (m.away.kind === "runnerUp" && m.away.group === group.name)
  );
  const winnerOpp = winnerMatch
    ? describePosition(
        winnerMatch.home.kind === "winner" && winnerMatch.home.group === group.name
          ? winnerMatch.away
          : winnerMatch.home
      )
    : "TBD";
  const runnerOpp = runnerMatch
    ? describePosition(
        runnerMatch.home.kind === "runnerUp" && runnerMatch.home.group === group.name
          ? runnerMatch.away
          : runnerMatch.home
      )
    : "TBD";

  const stageRows = odds
    ? [
        { stage: "Reach Round of 32", p: odds.roundOf32 },
        { stage: "Reach Round of 16", p: odds.roundOf16 },
        { stage: "Reach Quarter-final", p: odds.quarterFinal },
        { stage: "Reach Semi-final", p: odds.semiFinal },
        { stage: "Reach Final", p: odds.final },
        { stage: "Win the title", p: odds.champion },
      ]
    : [];

  const lines: string[] = [];
  lines.push(`**${team.flag} ${team.name} — path to the final (official 2026 bracket).**`);
  lines.push(
    `\nGroup ${group.name}: win the group ${pct(mine.winGroup)}, finish top-2 ${pct(mine.advance)}.`
  );
  lines.push(
    `\nRound-of-32 routing (matches 73–88 are fixed):\n` +
      `• As **Group ${group.name} winners** → vs ${winnerOpp} (Match ${winnerMatch?.no ?? "—"}).\n` +
      `• As **runners-up** → vs ${runnerOpp} (Match ${runnerMatch?.no ?? "—"}).`
  );

  // Concrete scenario path: trace the official match chain for the group-winner
  // route, naming the groups feeding each opposite side + the strongest example
  // opponent by Elo. No invented fixtures — this is the published routing.
  // Returned SEPARATELY (pathBlock) so the agent appends it verbatim AFTER any
  // LLM narration — the LLM never gets the chance to drop or rewrite it.
  let pathBlock = "";
  if (winnerMatch) {
    const steps = tracePotentialPath(winnerMatch.no, team.slug);
    if (steps.length) {
      const stepLines = steps.map((s) => {
        const groupsTxt = s.oppGroups.length
          ? `winner side from Group${s.oppGroups.length > 1 ? "s" : ""} ${s.oppGroups.join("/")}`
          : "best-third pool";
        const third = s.hasThird && s.oppGroups.length ? " (+ best-third routing)" : "";
        const ex = s.example ? ` — strongest likely: ${s.example.flag} ${s.example.name} (Elo ${s.example.elo})` : "";
        return `• ${s.round} (Match ${s.matchNo}): vs ${groupsTxt}${third}${ex}`;
      });
      pathBlock =
        (status ? `Current status: **${status}** (live tournament state).\n\n` : "") +
        `**Potential path (scenario: winning Group ${group.name}):**\n` +
        `• Round of 32 (Match ${winnerMatch.no}): vs ${winnerOpp}\n` +
        stepLines.join("\n") +
        `\n\n_Exact opponents depend on group finish and third-place routing, so this is a scenario path, not a fixed bracket._`;
    }
  }
  if (stageRows.length) {
    lines.push(
      `\nStage-by-stage probabilities (10,000 tournament simulations):\n` +
        stageRows.map((s) => `• ${s.stage}: ${pct(s.p, 1)}`).join("\n")
    );
  }
  lines.push(
    `\nKey risk: the knockout draw shifts with the group finish — winning Group ${group.name} buys the ${winnerOpp.includes("third") ? "softer third-place opponent" : "route above"}, while finishing second changes the bracket half. Single-elimination football stays high-variance regardless of rating.`
  );

  const factors: StructuredFactor[] = stageRows.map((s) => ({
    label: s.stage,
    value: pct(s.p, 1),
    weight: s.p >= 0.5 ? "high" : s.p >= 0.2 ? "medium" : "low",
  }));

  return {
    explanation: lines.join("\n"),
    pathBlock,
    summary: `${team.name}: ${pct(mine.advance)} to exit Group ${group.name}; ${odds ? pct(odds.final, 1) : "—"} to reach the final, ${odds ? pct(odds.champion, 1) : "—"} to win it all.`,
    factors,
    rankings: stageRows.map((s, i) => ({ rank: i + 1, name: s.stage, probability: s.p })),
    rulesApplied: [
      "Official R32 slots (matches 73–88) incl. FIFA Annex C third-place routing",
      "Knockout tree: R32 → R16 → QF → SF → Final",
    ],
    confidence: odds ? Math.round(odds.roundOf16 * 100) : 50,
    limitations: [
      "Knockout opponents depend on every group's final order; the routing above shows the fixed bracket slots, not named opponents.",
    ],
  };
}

// ---------------------------------------------------------------------------
// TEAM ANALYSIS
// ---------------------------------------------------------------------------

export function buildTeamAnalysis(team: TeamRef, news: TeamNewsItem[]) {
  const prof = strengthProfile(team.slug);
  const odds = getChampionOddsFor(team.slug);
  const group = groupOf(team.slug);
  const rows = simulateGroup(group.name);
  const mine = rows.find((r) => r.slug === team.slug)!;
  const discipline: DisciplineRisk = computeDisciplineRisk(news);
  const newsDemo = news.length > 0 && news.every((n) => n.demo);

  const lines: string[] = [];
  lines.push(`**${team.flag} ${team.name} — 2026 profile.**`);
  lines.push(
    `\n• **Team strength:** Elo ${prof.elo} — ranked **#${prof.rank} of 48** (${tierLabel(prof.rank)}).` +
      `\n• **Attack (model proxy):** ${prof.attack.toFixed(2)} expected goals vs a median-strength opponent.` +
      `\n• **Defense (model proxy):** ${prof.defense.toFixed(2)} expected goals conceded vs the same baseline (lower is better).` +
      `\n• **Group ${group.name}:** ${pct(mine.advance)} to finish top-2 (${pct(mine.winGroup)} to win the group).` +
      (odds
        ? `\n• **Tournament outlook:** ${pct(odds.champion, 1)} champion · ${pct(odds.final, 1)} to reach the final · ${pct(odds.semiFinal, 1)} semi-final.`
        : "")
  );
  if (news.length > 0) {
    lines.push(
      `\n**Latest signals${newsDemo ? " (demo sample data)" : ""}:** ` +
        news
          .slice(0, 3)
          .map((n) => `${n.impactLevel}-impact ${n.category}: ${n.title}`)
          .join("; ") +
        "."
    );
  }
  lines.push(`\n**Discipline / suspension risk:** ${discipline.level}. ${discipline.detail}`);
  lines.push(
    `\n_Squad depth and week-to-week form are not modeled individually — Elo is the calibrated baseline, nudged only by capped, clearly-labeled news signals._`
  );

  const factors: StructuredFactor[] = [
    { label: "Elo / team strength", value: `${prof.elo} (#${prof.rank} of 48)`, weight: "high" },
    { label: "Attack rating (proxy)", value: `${prof.attack.toFixed(2)} EG vs median`, weight: "medium" },
    { label: "Defense rating (proxy)", value: `${prof.defense.toFixed(2)} EGA vs median`, weight: "medium" },
    { label: `Group ${group.name} advance`, value: pct(mine.advance), weight: "high" },
    ...(odds ? [{ label: "Championship probability", value: pct(odds.champion, 1), weight: "high" as const }] : []),
    { label: "Discipline / suspension risk", value: discipline.level, weight: "low" },
  ];

  return {
    explanation: lines.join("\n"),
    summary: `${team.name}: Elo ${prof.elo} (#${prof.rank}/48, ${tierLabel(prof.rank)}); ${pct(mine.advance)} to exit the group${odds ? `, ${pct(odds.champion, 1)} to win the title` : ""}.`,
    factors,
    rulesApplied: [],
    confidence: Math.round(mine.advance * 100),
    limitations: [
      "Attack/defense are Elo-derived proxies vs a median opponent, not lineup-level ratings.",
      "Squad depth and recent form are not modeled individually.",
      ...(newsDemo ? ["News signals shown are curated demo data, not live reports."] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// TEAM COMPARISON
// ---------------------------------------------------------------------------

export function buildTeamComparison(a: TeamRef, b: TeamRef) {
  const pa = strengthProfile(a.slug);
  const pb = strengthProfile(b.slug);
  const oa = getChampionOddsFor(a.slug);
  const ob = getChampionOddsFor(b.slug);
  // Fold in the per-fixture tactical matchup so this head-to-head line agrees
  // with the main prediction for style-clash fixtures (e.g. a low block vs a
  // possession side). Team-level proxies (rank/attack/defense) stay unchanged.
  const tac = getTacticalMatchup(a.slug, b.slug);
  // Same global confidence calibration as predictMatch / the MC sims, so the
  // head-to-head line never disagrees with the main prediction.
  const cal = gapCalibration(pa.elo + tac.a, pb.elo + tac.b);
  const neutral = matchProb(pa.elo + tac.a + cal.a, pb.elo + tac.b + cal.b, 0);
  const stronger = pa.elo === pb.elo ? null : pa.elo > pb.elo ? a : b;

  const row = (label: string, va: string, vb: string) => `• **${label}:** ${a.name} ${va} · ${b.name} ${vb}`;
  const lines: string[] = [];
  lines.push(`**${a.flag} ${a.name} vs ${b.flag} ${b.name} — side-by-side.**\n`);
  lines.push(row("Elo / strength", `${pa.elo} (#${pa.rank})`, `${pb.elo} (#${pb.rank})`));
  lines.push(row("Attack (proxy EG vs median)", pa.attack.toFixed(2), pb.attack.toFixed(2)));
  lines.push(row("Defense (proxy EGA vs median)", pa.defense.toFixed(2), pb.defense.toFixed(2)));
  if (oa && ob) lines.push(row("Champion probability", pct(oa.champion, 1), pct(ob.champion, 1)));
  lines.push(
    `\n**If they met on neutral ground:** ${a.name} ${pct(neutral.winA)} · draw ${pct(neutral.draw)} · ${b.name} ${pct(neutral.winB)}.`
  );
  lines.push(
    stronger
      ? `\n**Overall:** ${stronger.flag} **${stronger.name}** rates stronger on the model's scale${
          stronger.slug === a.slug
            ? pa.elo - pb.elo >= 60
              ? " by a clear margin"
              : " by a slim margin"
            : pb.elo - pa.elo >= 60
              ? " by a clear margin"
              : " by a slim margin"
        }. Ask "${a.name} vs ${b.name}" for the full match prediction with news impact.`
      : `\n**Overall:** dead level on the model's scale. Ask "${a.name} vs ${b.name}" for a full match prediction.`
  );

  const factors: StructuredFactor[] = [
    { label: `${a.name} Elo`, value: `${pa.elo} (#${pa.rank})`, weight: "high" },
    { label: `${b.name} Elo`, value: `${pb.elo} (#${pb.rank})`, weight: "high" },
    { label: `${a.name} attack/defense`, value: `${pa.attack.toFixed(2)} / ${pa.defense.toFixed(2)}`, weight: "medium" },
    { label: `${b.name} attack/defense`, value: `${pb.attack.toFixed(2)} / ${pb.defense.toFixed(2)}`, weight: "medium" },
    { label: "Neutral-ground result", value: `${pct(neutral.winA)} / ${pct(neutral.draw)} / ${pct(neutral.winB)}`, weight: "high" },
  ];

  return {
    explanation: lines.join("\n"),
    summary: stronger
      ? `${stronger.name} rates stronger (Elo ${Math.max(pa.elo, pb.elo)} vs ${Math.min(pa.elo, pb.elo)}); neutral-ground: ${a.name} ${pct(neutral.winA)} / draw ${pct(neutral.draw)} / ${b.name} ${pct(neutral.winB)}.`
      : `Even match-up on the model's scale (${pa.elo} vs ${pb.elo}).`,
    factors,
    probabilities: { teamAWin: neutral.winA, draw: neutral.draw, teamBWin: neutral.winB },
    rulesApplied: [],
    confidence: Math.round(Math.max(neutral.winA, neutral.winB) * 100),
    limitations: [
      "General comparison on a neutral field — host advantage and news impact apply only in the full match-prediction flow.",
    ],
  };
}

// ---------------------------------------------------------------------------
// MODEL EXPLANATION
// ---------------------------------------------------------------------------

export function buildModelExplanation() {
  const explanation = [
    `**How WorldCup Oracle Agent works.**`,
    ``,
    `• **Team strength:** every one of the 48 qualified teams carries a calibrated **Elo rating**; the three hosts get a +75 home bonus.`,
    `• **Match model:** Elo gaps feed a **Dixon-Coles bivariate Poisson** goal model (ρ = −0.13) that produces win/draw/loss probabilities and full scoreline grids.`,
    `• **Simulation:** each matchup is sampled **10,000 times** with a seeded Monte Carlo; tournament questions simulate the entire official 2026 format — 12 groups, FIFA tie-breakers, the 8 best third-placed teams, Annex C routing, and the R32→Final tree (validated across all 495 third-place combinations).`,
    `• **News layer:** stored \`team_news\` signals (live API if configured, otherwise clearly-labeled demo data) apply a **capped** probability nudge — high impact ≈ 4.5 pts, medium ≈ 2, max ±10 per team — always shown as base vs adjusted.`,
    `• **Discipline:** fair-play conduct points (yellow −1 … yellow+direct red −5) are modeled as a tie-breaker and a team-level suspension-risk signal.`,
    `• **Memory:** every session is saved to **MongoDB Atlas** (\`predictions\` + \`team_news\`) and recalled on /memory.`,
    `• **LLM layer (optional):** DeepSeek/Gemini classify intent and polish explanations — they **never** produce probabilities, news, or injuries.`,
    ``,
    `**Limitations:** no lineup/player-level data; form enters only through capped news signals; demo news is sample data; probabilities are calibrated estimates, not guarantees.`,
  ].join("\n");

  return {
    explanation,
    summary: "Elo → Dixon-Coles → 10,000-run Monte Carlo on the official 2026 format, with capped news adjustments, discipline awareness, MongoDB memory, and an optional LLM narration layer.",
    factors: [
      { label: "Team strength", value: "Calibrated Elo (48 teams, host +75)", weight: "high" },
      { label: "Match model", value: "Dixon-Coles bivariate Poisson (ρ=−0.13)", weight: "high" },
      { label: "Simulation", value: "10,000 seeded Monte Carlo runs", weight: "high" },
      { label: "News layer", value: "Capped ±10 pts/team, base vs adjusted", weight: "medium" },
      { label: "Discipline", value: "Fair-play points + suspension risk", weight: "low" },
      { label: "Memory", value: "MongoDB Atlas (predictions + team_news)", weight: "medium" },
    ] as StructuredFactor[],
    rulesApplied: [
      "Official 2026 format: 48 teams, 12 groups, top-2 + 8 best thirds, Annex C R32 routing",
    ],
    confidence: 100,
    limitations: [
      "No player/lineup-level data; news may be demo signals; estimates, not guarantees.",
    ],
  };
}
