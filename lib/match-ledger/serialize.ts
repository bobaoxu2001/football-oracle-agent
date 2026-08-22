/**
 * Canonical match → API/UI shape.
 *
 * DISPLAY RULE. Only statistics actually present in the canonical record are
 * emitted in `statistics`. Fields the source does not supply are named in
 * `unavailableStatistics` instead, so the UI can say "not provided by this
 * source" rather than rendering a fabricated 0. `statisticsSource` names the
 * provider, because statistic definitions — xG above all — are not comparable
 * across vendors.
 *
 * This layer is also the boundary that keeps raw provider payloads out of the
 * view: nothing here forwards `raw`.
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import type { CanonicalMatch, TeamMatchStatistics } from "./types";
import { isCompletedMatch } from "./types";
import { teamMatchLines } from "./features";

/** Display order and labels for the statistics the ledger models. */
const STAT_FIELDS: { key: keyof TeamMatchStatistics; label: string; unit?: string }[] = [
  { key: "expectedGoals", label: "xG" },
  { key: "possessionPct", label: "Possession", unit: "%" },
  { key: "totalShots", label: "Shots" },
  { key: "shotsOnTarget", label: "Shots on target" },
  { key: "shotsOffTarget", label: "Shots off target" },
  { key: "blockedShots", label: "Blocked shots" },
  { key: "shotsInsideBox", label: "Shots inside box" },
  { key: "shotsOutsideBox", label: "Shots outside box" },
  { key: "corners", label: "Corners" },
  { key: "offsides", label: "Offsides" },
  { key: "fouls", label: "Fouls" },
  { key: "yellowCards", label: "Yellow cards" },
  { key: "redCards", label: "Red cards" },
  { key: "goalkeeperSaves", label: "Goalkeeper saves" },
];

export interface SerializedStatistic {
  key: string;
  label: string;
  unit: string | null;
  home: number;
  away: number;
}

export interface SerializedPrediction {
  modelVersion: string;
  predictionStage: string;
  /** The prediction's own cutoff — its feature-availability boundary. */
  asOf: string;
  home: number;
  draw: number;
  away: number;
  settled: boolean;
  brier: number | null;
  rps: number | null;
  logLoss: number | null;
  topPickCorrect: boolean | null;
}

export interface SerializedMatch {
  canonicalMatchId: string;
  competition: BigFiveCompetitionId;
  competitionName: string;
  season: string;
  matchday: number | null;
  kickoffUtc: string | null;
  status: string;
  home: { slug: string; name: string; shortName: string | null };
  away: { slug: string; name: string; shortName: string | null };
  score: {
    fullTime: { home: number | null; away: number | null };
    halfTime: { home: number | null; away: number | null };
  };
  result: string | null;
  completed: boolean;
  resultObservedAt: string | null;
  /** Only statistics actually recorded. Never padded with zeros. */
  statistics: SerializedStatistic[];
  /** Requested statistics this record does not have. */
  unavailableStatistics: string[];
  statisticsSource: string | null;
  hasEvents: boolean;
  sources: string[];
  observationCount: number;
  corrections: number;
  prediction: SerializedPrediction | null;
}

export function serializeMatchForApi(
  match: CanonicalMatch,
  extra: { settlement?: SettlementRecord | null; snapshot?: PredictionSnapshot | null } = {}
): SerializedMatch {
  const statistics: SerializedStatistic[] = [];
  const unavailable: string[] = [];
  for (const field of STAT_FIELDS) {
    const home = match.homeStatistics?.[field.key] ?? null;
    const away = match.awayStatistics?.[field.key] ?? null;
    // Both sides must be present for a comparison row to mean anything.
    if (home !== null && away !== null) {
      statistics.push({
        key: String(field.key),
        label: field.label,
        unit: field.unit ?? null,
        home,
        away,
      });
    } else {
      unavailable.push(field.label);
    }
  }

  const settlement = extra.settlement ?? null;
  const snapshot = extra.snapshot ?? null;
  let prediction: SerializedPrediction | null = null;
  if (settlement) {
    prediction = {
      modelVersion: settlement.modelVersion,
      predictionStage: String(settlement.predictionStage),
      // The snapshot's asOf is the authoritative cutoff; fall back to the
      // settlement key, which embeds it, rather than to settledAt (post-result).
      asOf: snapshot?.asOf ?? settlement.snapshotUniqueKey.split("::").pop() ?? settlement.settledAt,
      home: settlement.predicted.home,
      draw: settlement.predicted.draw,
      away: settlement.predicted.away,
      settled: true,
      brier: settlement.brier,
      rps: settlement.rps,
      logLoss: settlement.logLoss,
      topPickCorrect: settlement.topPickCorrect,
    };
  } else if (snapshot) {
    prediction = {
      modelVersion: snapshot.modelVersion,
      predictionStage: String(snapshot.predictionStage),
      asOf: snapshot.asOf,
      home: snapshot.homeProbability,
      draw: snapshot.drawProbability,
      away: snapshot.awayProbability,
      settled: false,
      brier: null,
      rps: null,
      logLoss: null,
      topPickCorrect: null,
    };
  }

  return {
    canonicalMatchId: match.canonicalMatchId,
    competition: match.competition,
    competitionName: getCompetition(match.competition).name,
    season: match.season,
    matchday: match.matchday,
    kickoffUtc: match.kickoffUtc,
    status: match.status,
    home: { slug: match.home.slug, name: match.home.name, shortName: match.home.shortName },
    away: { slug: match.away.slug, name: match.away.name, shortName: match.away.shortName },
    score: {
      fullTime: { home: match.fullTimeHomeGoals, away: match.fullTimeAwayGoals },
      halfTime: { home: match.halfTimeHomeGoals, away: match.halfTimeAwayGoals },
    },
    result: match.outcome,
    completed: isCompletedMatch(match),
    resultObservedAt: match.resultObservedAt,
    statistics,
    unavailableStatistics: unavailable,
    statisticsSource: match.provenance.statistics?.source ?? null,
    hasEvents: match.events !== null,
    sources: match.sources,
    observationCount: match.observationCount,
    corrections: match.corrections.length,
    prediction,
  };
}

export interface SerializedTeamSeason {
  teamSlug: string;
  teamName: string;
  competition: BigFiveCompetitionId;
  competitionName: string;
  season: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  pointsPerMatch: number | null;
  home: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  away: { played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number };
  /** Most recent first. */
  recent: {
    canonicalMatchId: string;
    kickoffUtc: string | null;
    matchday: number | null;
    venue: "home" | "away";
    opponentSlug: string;
    goalsFor: number;
    goalsAgainst: number;
    outcome: "W" | "D" | "L";
  }[];
  /** Chronological W/D/L, oldest first. */
  form: string;
}

function venueSplit(lines: ReturnType<typeof teamMatchLines>, venue: "home" | "away") {
  const rows = lines.filter((l) => l.venue === venue);
  return {
    played: rows.length,
    wins: rows.filter((r) => r.outcome === "W").length,
    draws: rows.filter((r) => r.outcome === "D").length,
    losses: rows.filter((r) => r.outcome === "L").length,
    goalsFor: rows.reduce((s, r) => s + r.goalsFor, 0),
    goalsAgainst: rows.reduce((s, r) => s + r.goalsAgainst, 0),
  };
}

/**
 * A team's current-season record, read from the canonical ledger.
 * `matches` must already be admissibility-filtered by the caller when the view
 * is time-sensitive; the team pages pass "everything completed so far".
 */
export function serializeTeamSeason(
  matches: CanonicalMatch[],
  teamSlug: string,
  competition: BigFiveCompetitionId,
  season: string
): SerializedTeamSeason {
  const scoped = matches.filter(
    (m) => m.competition === competition && m.season === season && isCompletedMatch(m)
  );
  const lines = teamMatchLines(scoped, teamSlug);
  const wins = lines.filter((l) => l.outcome === "W").length;
  const draws = lines.filter((l) => l.outcome === "D").length;
  const losses = lines.filter((l) => l.outcome === "L").length;
  const goalsFor = lines.reduce((s, l) => s + l.goalsFor, 0);
  const goalsAgainst = lines.reduce((s, l) => s + l.goalsAgainst, 0);
  const points = wins * 3 + draws;
  const named = scoped.find((m) => m.home.slug === teamSlug || m.away.slug === teamSlug);
  const teamName =
    named?.home.slug === teamSlug ? named.home.name : named?.away.name ?? teamSlug;

  return {
    teamSlug,
    teamName,
    competition,
    competitionName: getCompetition(competition).name,
    season,
    played: lines.length,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    points,
    pointsPerMatch: lines.length ? points / lines.length : null,
    home: venueSplit(lines, "home"),
    away: venueSplit(lines, "away"),
    recent: lines
      .slice()
      .reverse()
      .map((l) => ({
        canonicalMatchId: l.canonicalMatchId,
        kickoffUtc: l.kickoffUtc,
        matchday: l.matchday,
        venue: l.venue,
        opponentSlug: l.opponentSlug,
        goalsFor: l.goalsFor,
        goalsAgainst: l.goalsAgainst,
        outcome: l.outcome,
      })),
    form: lines.map((l) => l.outcome).join(""),
  };
}
