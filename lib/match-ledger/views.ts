/**
 * Read models for the match-history UI and API.
 *
 * Joins the canonical ledger to the frozen prediction snapshots and their
 * settlements. The join is read-only in both directions: nothing here can write
 * a snapshot, and the probabilities shown are always the frozen pre-kickoff
 * ones, never a recomputation.
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { loadSettlements, type SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { listCanonicalMatches } from "./store";
import { isCompletedMatch, type CanonicalMatch } from "./types";
import { serializeMatchForApi, serializeTeamSeason, type SerializedMatch, type SerializedTeamSeason } from "./serialize";
import { FOOTBALL_DATA_CAPABILITY } from "./providers/football-data";

/**
 * The prediction that was frozen closest to kickoff WITHOUT crossing it.
 *
 * "Closest before kickoff" is the honest choice for a match card: it is the
 * model's final pre-match view. A snapshot at or after kickoff is never
 * eligible, so a post-hoc row could not be displayed as a pre-match call.
 */
export function latestPreKickoffSnapshot(
  snapshots: PredictionSnapshot[],
  kickoffUtc: string | null
): PredictionSnapshot | null {
  if (!kickoffUtc) return null;
  const kickoffMs = Date.parse(kickoffUtc);
  if (!Number.isFinite(kickoffMs)) return null;
  const eligible = snapshots
    .filter((s) => {
      const asOf = Date.parse(s.asOf);
      return Number.isFinite(asOf) && asOf < kickoffMs;
    })
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  return eligible[eligible.length - 1] ?? null;
}

export interface MatchweekGroup {
  matchday: number | null;
  matches: SerializedMatch[];
}

export interface MatchHistoryView {
  competition: BigFiveCompetitionId;
  competitionName: string;
  season: string;
  completedCount: number;
  /** Grouped by matchweek, newest matchweek first. */
  matchweeks: MatchweekGroup[];
  /** What the source can and cannot supply, for honest empty states. */
  capability: typeof FOOTBALL_DATA_CAPABILITY;
}

function snapshotsByFixture(season: string): Map<string, PredictionSnapshot[]> {
  const out = new Map<string, PredictionSnapshot[]>();
  let rows: PredictionSnapshot[] = [];
  try {
    rows = listLiveSnapshots({ season });
  } catch {
    return out;
  }
  for (const s of rows) {
    const list = out.get(s.fixtureId);
    if (list) list.push(s);
    else out.set(s.fixtureId, [s]);
  }
  return out;
}

function settlementsByFixture(): Map<string, SettlementRecord[]> {
  const out = new Map<string, SettlementRecord[]>();
  let rows: SettlementRecord[] = [];
  try {
    rows = loadSettlements();
  } catch {
    return out;
  }
  for (const r of rows) {
    const list = out.get(r.fixtureId);
    if (list) list.push(r);
    else out.set(r.fixtureId, [r]);
  }
  return out;
}

/** Serialize one match with whatever prediction/settlement exists for it. */
function joinOne(
  match: CanonicalMatch,
  snaps: Map<string, PredictionSnapshot[]>,
  settled: Map<string, SettlementRecord[]>
): SerializedMatch {
  const snapshot = latestPreKickoffSnapshot(snaps.get(match.canonicalMatchId) ?? [], match.kickoffUtc);
  const settlements = settled.get(match.canonicalMatchId) ?? [];
  const settlement =
    (snapshot
      ? settlements.find((s) => s.snapshotUniqueKey === snapshot.provenance.uniqueKey)
      : null) ?? null;
  return serializeMatchForApi(match, { snapshot, settlement });
}

export async function matchHistoryView(
  competition: BigFiveCompetitionId,
  season: string
): Promise<MatchHistoryView> {
  const all = await listCanonicalMatches({ competition, season });
  const completed = all.filter(isCompletedMatch);
  const snaps = snapshotsByFixture(season);
  const settled = settlementsByFixture();

  const byMatchday = new Map<number | null, SerializedMatch[]>();
  for (const m of completed) {
    const row = joinOne(m, snaps, settled);
    const list = byMatchday.get(m.matchday);
    if (list) list.push(row);
    else byMatchday.set(m.matchday, [row]);
  }

  const matchweeks: MatchweekGroup[] = [...byMatchday.entries()]
    .map(([matchday, matches]) => ({
      matchday,
      matches: matches.sort((a, b) => (a.kickoffUtc ?? "").localeCompare(b.kickoffUtc ?? "")),
    }))
    .sort((a, b) => (b.matchday ?? -1) - (a.matchday ?? -1));

  return {
    competition,
    competitionName: getCompetition(competition).name,
    season,
    completedCount: completed.length,
    matchweeks,
    capability: FOOTBALL_DATA_CAPABILITY,
  };
}

export interface TeamSeasonView extends SerializedTeamSeason {
  recentMatches: SerializedMatch[];
}

export async function teamSeasonView(
  competition: BigFiveCompetitionId,
  season: string,
  teamSlug: string
): Promise<TeamSeasonView | null> {
  const all = await listCanonicalMatches({ competition, season });
  const completed = all.filter(isCompletedMatch);
  const played = completed.filter((m) => m.home.slug === teamSlug || m.away.slug === teamSlug);
  if (!played.length) return null;
  const snaps = snapshotsByFixture(season);
  const settled = settlementsByFixture();
  const base = serializeTeamSeason(completed, teamSlug, competition, season);
  return {
    ...base,
    recentMatches: played
      .slice()
      .reverse()
      .map((m) => joinOne(m, snaps, settled)),
  };
}

/** Every team with at least one completed match, for index pages. */
export async function teamsWithMatches(
  competition: BigFiveCompetitionId,
  season: string
): Promise<{ slug: string; name: string; played: number }[]> {
  const completed = (await listCanonicalMatches({ competition, season })).filter(isCompletedMatch);
  const byTeam = new Map<string, { slug: string; name: string; played: number }>();
  for (const m of completed) {
    for (const side of [m.home, m.away]) {
      const prev = byTeam.get(side.slug);
      if (prev) prev.played += 1;
      else byTeam.set(side.slug, { slug: side.slug, name: side.name, played: 1 });
    }
  }
  return [...byTeam.values()].sort((a, b) => a.name.localeCompare(b.name));
}
