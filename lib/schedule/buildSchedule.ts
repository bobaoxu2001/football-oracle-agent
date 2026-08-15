/**
 * Deterministic World Cup 2026 schedule built from recorded tournament data.
 * Group pairings come from the draw; knockout structure comes from the official
 * bracket seed. Verified live-cache rows take precedence over recorded entries.
 */

import { GROUPS, getTeam } from "@/lib/seed/world-cup-2026-groups";
import {
  BRACKET_2026,
  positionLabel,
  type Round,
} from "@/lib/competitions/world-cup/bracket-2026";
import { ALL_MATCH_RESULTS } from "@/lib/seed/recorded-match-results";
import type { ManualMatchResult } from "@/lib/seed/manual-match-results";
import type { LiveFixture } from "@/lib/live-sports/types";

export interface ScheduleRow {
  stage: string;
  group?: string;
  matchNo?: number;
  teamA: string;
  teamB: string;
  slugA?: string;
  slugB?: string;
  date: string;
  venue: string;
  status: "Scheduled" | "Finished" | "Live" | "TBA" | "Unknown";
  teamASlot?: string;
  teamBSlot?: string;
  score?: string;
  goalsA?: number;
  goalsB?: number;
  resultSource?: "live" | "manual";
  /** Knockout shootout winner when the displayed score is level. */
  advanced?: string;
}

export interface GroupFixtures {
  group: string;
  rows: ScheduleRow[];
}

const RR_PAIRS: [number, number][] = [
  [0, 1],
  [2, 3],
  [0, 2],
  [1, 3],
  [0, 3],
  [1, 2],
];

export function buildGroupFixtures(): GroupFixtures[] {
  return GROUPS.map((g) => ({
    group: g.name,
    rows: RR_PAIRS.map(([i, j]) => {
      const a = getTeam(g.teams[i]);
      const b = getTeam(g.teams[j]);
      return {
        stage: `Group ${g.name}`,
        group: g.name,
        teamA: `${a.flag} ${a.name}`,
        teamB: `${b.flag} ${b.name}`,
        slugA: a.slug,
        slugB: b.slug,
        date: "TBA",
        venue: "TBA",
        status: "Scheduled" as const,
      };
    }),
  }));
}

const ROUND_LABEL: Record<Round, string> = {
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  Final: "Final",
};

export function buildKnockoutFixtures(): ScheduleRow[] {
  return BRACKET_2026.map((m) => ({
    stage: ROUND_LABEL[m.round] ?? m.round,
    matchNo: m.no,
    teamA: positionLabel(m.home),
    teamB: positionLabel(m.away),
    date: "TBA",
    venue: "TBA",
    status: "TBA" as const,
  }));
}

const FINISHED = new Set(["FINISHED", "AWARDED", "FT", "AET", "PEN"]);
const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE", "1H", "2H", "HT", "ET"]);
const SCHEDULED = new Set(["SCHEDULED", "TIMED", "NS"]);

function liveStatus(s: string): ScheduleRow["status"] {
  if (FINISHED.has(s)) return "Finished";
  if (LIVE.has(s)) return "Live";
  if (SCHEDULED.has(s)) return "Scheduled";
  return "Unknown";
}

function teamLabel(slug: string | null): string {
  if (!slug) return "TBA";
  try {
    const t = getTeam(slug);
    return `${t.flag} ${t.name}`;
  } catch {
    return "TBA";
  }
}

/** Merge verified cached fixtures into group rows. */
export function mergeLiveIntoGroups(
  groups: GroupFixtures[],
  fixtures: LiveFixture[]
): GroupFixtures[] {
  if (!fixtures.length) return groups;
  const byPair = new Map<string, LiveFixture>();
  for (const f of fixtures) {
    if (!f.homeSlug || !f.awaySlug) continue;
    byPair.set([f.homeSlug, f.awaySlug].sort().join("|"), f);
  }

  return groups.map((g) => ({
    group: g.group,
    rows: g.rows.map((r) => {
      if (!r.slugA || !r.slugB) return r;
      const f = byPair.get([r.slugA, r.slugB].sort().join("|"));
      if (!f) return r;

      const status = liveStatus(f.status);
      const hasGoals =
        typeof f.goalsHome === "number" && typeof f.goalsAway === "number";
      const flipped = f.homeSlug === r.slugB;
      const goalsA = hasGoals
        ? flipped
          ? f.goalsAway!
          : f.goalsHome!
        : undefined;
      const goalsB = hasGoals
        ? flipped
          ? f.goalsHome!
          : f.goalsAway!
        : undefined;

      return {
        ...r,
        date: f.date || "TBA",
        status,
        score: hasGoals ? `${goalsA}–${goalsB}` : undefined,
        goalsA,
        goalsB,
        resultSource: hasGoals ? ("live" as const) : undefined,
      };
    }),
  }));
}

/**
 * Merge recorded GROUP results into the group rows. Knockout results are
 * deliberately filtered out so a later cross-stage rematch can never overwrite
 * a group-stage score. Verified live rows always retain precedence.
 */
export function mergeManualIntoGroups(groups: GroupFixtures[]): GroupFixtures[] {
  const groupResults = ALL_MATCH_RESULTS.filter((m) => m.group.length === 1);
  if (!groupResults.length) return groups;

  const byPair = new Map(
    groupResults.map((m) => [[m.teamA, m.teamB].sort().join("|"), m])
  );

  return groups.map((g) => ({
    group: g.group,
    rows: g.rows.map((r) => {
      if (!r.slugA || !r.slugB || r.resultSource === "live") return r;
      const m = byPair.get([r.slugA, r.slugB].sort().join("|"));
      if (!m) return r;

      const flipped = m.teamA === r.slugB;
      const goalsA = flipped ? m.scoreB : m.scoreA;
      const goalsB = flipped ? m.scoreA : m.scoreB;
      return {
        ...r,
        date: r.date !== "TBA" ? r.date : m.date || r.date,
        status: "Finished" as const,
        score: `${goalsA}–${goalsB}`,
        goalsA,
        goalsB,
        resultSource: "manual" as const,
      };
    }),
  }));
}

function isKnockoutEntry(m: ManualMatchResult): boolean {
  return m.group.length > 1;
}

/** Resolve the side that advanced; shootout draws use the explicit field. */
export function knockoutWinner(m: ManualMatchResult): string | undefined {
  if (m.advances) return m.advances;
  if (m.scoreA > m.scoreB) return m.teamA;
  if (m.scoreB > m.scoreA) return m.teamB;
  return undefined;
}

/**
 * Build the knockout bracket and fold recorded winners forward round by round.
 * `resolvedR32` supplies the actual qualified teams after the group stage.
 */
export function bracketColumns(
  resolvedR32?: Map<number, { home: string; away: string }>,
  recordedResults: ManualMatchResult[] = ALL_MATCH_RESULTS
): { round: string; matches: ScheduleRow[] }[] {
  const koByPair = new Map(
    recordedResults
      .filter(isKnockoutEntry)
      .map((m) => [[m.teamA, m.teamB].sort().join("|"), m])
  );
  const winners: Record<number, string> = {};

  const rows: ScheduleRow[] = BRACKET_2026.map((bm) => {
    const base: ScheduleRow = {
      stage: ROUND_LABEL[bm.round] ?? bm.round,
      matchNo: bm.no,
      teamA: positionLabel(bm.home),
      teamB: positionLabel(bm.away),
      date: "TBA",
      venue: "TBA",
      status: "TBA",
    };

    let home: string | undefined;
    let away: string | undefined;
    if (bm.round === "R32") {
      const resolved = resolvedR32?.get(bm.no);
      home = resolved?.home;
      away = resolved?.away;
    } else {
      home = bm.home.kind === "winnerOf" ? winners[bm.home.match] : undefined;
      away = bm.away.kind === "winnerOf" ? winners[bm.away.match] : undefined;
    }

    if (!home && !away) return base;

    const row: ScheduleRow = {
      ...base,
      teamASlot: base.teamA,
      teamBSlot: base.teamB,
      teamA: home ? teamLabel(home) : base.teamA,
      teamB: away ? teamLabel(away) : base.teamB,
      slugA: home,
      slugB: away,
      status: "Scheduled",
    };
    if (!home || !away) return row;

    const result = koByPair.get([home, away].sort().join("|"));
    if (!result) return row;

    const flipped = result.teamA === away;
    const goalsA = flipped ? result.scoreB : result.scoreA;
    const goalsB = flipped ? result.scoreA : result.scoreB;
    const winner = knockoutWinner(result);
    if (winner) winners[bm.no] = winner;

    return {
      ...row,
      date: result.date || "TBA",
      status: "Finished",
      score: `${goalsA}–${goalsB}`,
      goalsA,
      goalsB,
      resultSource: "manual",
      advanced: winner && goalsA === goalsB ? teamLabel(winner) : undefined,
    };
  });

  const order = [
    "Round of 32",
    "Round of 16",
    "Quarter-final",
    "Semi-final",
    "Final",
  ];
  return order.map((round) => ({
    round,
    matches: rows.filter((r) => r.stage === round),
  }));
}

export interface LiveScheduleRow extends ScheduleRow {
  goals: string;
}

/** Map cached fixtures to display rows. */
export function mapLiveFixtures(fixtures: LiveFixture[]): LiveScheduleRow[] {
  const rows: LiveScheduleRow[] = fixtures.map((f) => ({
    stage: f.round || "Fixture",
    teamA: teamLabel(f.homeSlug),
    teamB: teamLabel(f.awaySlug),
    slugA: f.homeSlug ?? undefined,
    slugB: f.awaySlug ?? undefined,
    date: f.date || "TBA",
    venue: "TBA",
    status: liveStatus(f.status),
    goals:
      typeof f.goalsHome === "number" && typeof f.goalsAway === "number"
        ? `${f.goalsHome}–${f.goalsAway}`
        : "",
  }));
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
