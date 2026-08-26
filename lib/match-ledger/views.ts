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
import {
  effectiveSnapshotGeneratedAt,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import { listCanonicalMatches } from "./store";
import { isCompletedMatch, type CanonicalMatch } from "./types";
import {
  isPublicProductionSnapshotForMatch,
  serializeMatchForApi,
  serializeTeamSeason,
  type SerializedMatch,
  type SerializedTeamSeason,
} from "./serialize";
import { FOOTBALL_DATA_CAPABILITY } from "./providers/football-data";
import { productionModelVersion } from "@/lib/competitions/premier-league/shadow/track";

/**
 * The latest canonical production prediction valid for this completed match.
 *
 * Eligibility is deliberately stricter than a simple `asOf < kickoff` check:
 * it includes production/evaluation/competition isolation, current kickoff
 * identity, actual generation time, deterministic stage windows and recorded
 * input-cutoff evidence. Invalid immutable rows remain in their audit stores;
 * they simply cannot be attached to a public canonical-match row.
 */
export function latestPreKickoffSnapshot(
  snapshots: readonly PredictionSnapshot[],
  match: CanonicalMatch
): PredictionSnapshot | null {
  const eligible = snapshots
    .filter((snapshot) => isPublicProductionSnapshotForMatch(match, snapshot))
    .sort(
      (a, b) =>
        a.asOf.localeCompare(b.asOf) ||
        effectiveSnapshotGeneratedAt(a).localeCompare(effectiveSnapshotGeneratedAt(b)) ||
        a.provenance.uniqueKey.localeCompare(b.provenance.uniqueKey)
    );
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

function snapshotsByFixture(
  competition: BigFiveCompetitionId,
  season: string
): Map<string, PredictionSnapshot[]> {
  const out = new Map<string, PredictionSnapshot[]>();
  // Production forecasts are Premier League-only. Do not even enumerate the
  // PL store for another league: canonical ids are namespaced by convention,
  // but public isolation must not depend on that convention remaining unique.
  if (competition !== "premier-league") return out;
  let rows: PredictionSnapshot[] = [];
  try {
    rows = listLiveSnapshots({ season, evaluationClass: "LIVE_OOS" });
  } catch {
    return out;
  }
  for (const s of rows) {
    // Match history is a production surface. A challenger frozen later (or
    // earlier) must never win the generic "latest before kickoff" selection.
    if (
      s.competition !== "premier-league" ||
      s.season !== season ||
      s.evaluationClass !== "LIVE_OOS" ||
      s.modelVersion !== productionModelVersion()
    ) {
      continue;
    }
    const list = out.get(s.fixtureId);
    if (list) list.push(s);
    else out.set(s.fixtureId, [s]);
  }
  return out;
}

function settlementsByFixture(
  competition: BigFiveCompetitionId,
  season: string
): Map<string, SettlementRecord[]> {
  const out = new Map<string, SettlementRecord[]>();
  if (competition !== "premier-league") return out;
  let rows: SettlementRecord[] = [];
  try {
    rows = loadSettlements();
  } catch {
    return out;
  }
  for (const r of rows) {
    if (
      r.season !== season ||
      r.evaluationClass !== "LIVE_OOS" ||
      r.modelVersion !== productionModelVersion()
    ) {
      continue;
    }
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
  const snapshot = latestPreKickoffSnapshot(snaps.get(match.canonicalMatchId) ?? [], match);
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
  const snaps = snapshotsByFixture(competition, season);
  const settled = settlementsByFixture(competition, season);

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
  const snaps = snapshotsByFixture(competition, season);
  const settled = settlementsByFixture(competition, season);
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
