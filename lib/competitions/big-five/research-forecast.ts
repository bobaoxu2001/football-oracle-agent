/**
 * Big Five research match forecasts.
 *
 * PIT-safe walk-forward Elo + Dixon-Coles on the canonical ledger.
 * Computed on read. Not frozen. Not production. Premier League is refused.
 */

import { getCompetition } from "@/lib/competitions/registry";
import { matchProb, scorelineGrid } from "@/lib/prediction-engine/elo";
import { isCompletedMatch, type CanonicalMatch } from "@/lib/match-ledger/types";
import {
  assertResearchForecastCompetition,
  BIG_FIVE_RESEARCH_PARAMS,
  RESEARCH_FORECAST_DISCLAIMER,
  RESEARCH_NOT_PRODUCTION_MODEL_VERSION,
  ResearchForecastError,
  type ResearchForecastCompetitionId,
} from "./research-params";
import { ratingOf, researchRatingsAsOf } from "./research-ratings";
import {
  evidenceLevelFromCount,
  type ResearchForecastBoard,
  type ResearchMatchForecast,
} from "./research-types";

const DEFAULT_UPCOMING_LIMIT = 12;

export function isResearchForecastCandidate(
  match: CanonicalMatch,
  asOfMs: number
): boolean {
  if (match.status !== "SCHEDULED") return false;
  if (!match.kickoffUtc) return false;
  const kickoffMs = Date.parse(match.kickoffUtc);
  if (!Number.isFinite(kickoffMs)) return false;
  if (kickoffMs <= asOfMs) return false;
  return Boolean(match.home.slug && match.away.slug);
}

export function forecastResearchMatch(input: {
  match: CanonicalMatch;
  universe: readonly CanonicalMatch[];
  asOf: string;
  computedAt?: string;
}): ResearchMatchForecast {
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new ResearchForecastError(
      `Invalid research forecast cutoff: ${input.asOf}`,
      "INVALID_CUTOFF",
      400
    );
  }

  const competition = assertResearchForecastCompetition(input.match.competition);
  if (!isResearchForecastCandidate(input.match, asOfMs)) {
    throw new ResearchForecastError(
      `${input.match.canonicalMatchId} is not a pre-kickoff research-forecast candidate at ${input.asOf}.`,
      "NOT_FORECASTABLE",
      409
    );
  }

  const params = BIG_FIVE_RESEARCH_PARAMS;
  const state = researchRatingsAsOf(
    input.universe,
    {
      asOf: input.asOf,
      competition,
      season: input.match.season,
      excludeMatchId: input.match.canonicalMatchId,
    },
    params
  );

  const eloHome = ratingOf(state, input.match.home.slug, params.meanElo);
  const eloAway = ratingOf(state, input.match.away.slug, params.meanElo);
  const goalOpts = { rho: params.dcRho, awayHomeShare: params.awayHomeShare };
  const probabilities = matchProb(eloHome, eloAway, params.homeAdvantage, goalOpts);
  const grid = scorelineGrid(eloHome, eloAway, params.homeAdvantage, goalOpts)
    .slice()
    .sort((a, b) => b.p - a.p || a.a - b.a || a.b - b.b);
  const top = grid[0];
  const computedAt = input.computedAt ?? input.asOf;
  const config = getCompetition(competition);

  return {
    support: "research",
    production: false,
    includedInProduction: false,
    modelVersion: params.modelVersion,
    notProductionModelVersion: RESEARCH_NOT_PRODUCTION_MODEL_VERSION,
    modelRole: "research",
    paramsOrigin: "labeled-domestic-prior",
    canonicalMatchId: input.match.canonicalMatchId,
    competition,
    competitionName: config.name,
    season: input.match.season,
    matchday: input.match.matchday,
    kickoffUtc: input.match.kickoffUtc as string,
    asOf: input.asOf,
    computedAt,
    home: {
      slug: input.match.home.slug,
      name: input.match.home.name,
      shortName: input.match.home.shortName,
      elo: eloHome,
      matchesPlayed: state.matchesPlayedSeason[input.match.home.slug] ?? 0,
    },
    away: {
      slug: input.match.away.slug,
      name: input.match.away.name,
      shortName: input.match.away.shortName,
      elo: eloAway,
      matchesPlayed: state.matchesPlayedSeason[input.match.away.slug] ?? 0,
    },
    probabilities: {
      home: probabilities.winA,
      draw: probabilities.draw,
      away: probabilities.winB,
    },
    expectedGoals: {
      home: probabilities.expectedGoalsA,
      away: probabilities.expectedGoalsB,
    },
    mostLikelyScoreline: `${top.a}–${top.b}`,
    topScorelines: grid.slice(0, 6).map((cell) => ({
      score: `${cell.a}–${cell.b}`,
      probability: cell.p,
    })),
    evidence: {
      completedMatchesUsed: state.matchesApplied,
      evidenceLevel: evidenceLevelFromCount(state.matchesApplied),
      lastAppliedMatchId: state.lastAppliedMatchId,
      lastAppliedKickoffUtc: state.lastAppliedKickoffUtc,
    },
    disclaimer: RESEARCH_FORECAST_DISCLAIMER,
  };
}

export function buildResearchForecastBoard(input: {
  competition: ResearchForecastCompetitionId;
  season: string;
  asOf: string;
  matches: readonly CanonicalMatch[];
  limit?: number;
  ledgerLastIngestAt?: string | null;
  computedAt?: string;
}): ResearchForecastBoard {
  const competition = assertResearchForecastCompetition(input.competition);
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new ResearchForecastError(
      `Invalid research forecast cutoff: ${input.asOf}`,
      "INVALID_CUTOFF",
      400
    );
  }

  const universe = input.matches.filter(
    (match) => match.competition === competition && match.season === input.season
  );
  const completedMatchesInLedger = universe.filter(isCompletedMatch).length;

  const upcoming = universe
    .filter((match) => isResearchForecastCandidate(match, asOfMs))
    .sort(
      (a, b) =>
        (a.kickoffUtc ?? "").localeCompare(b.kickoffUtc ?? "") ||
        a.canonicalMatchId.localeCompare(b.canonicalMatchId)
    );

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_UPCOMING_LIMIT, 40));
  const computedAt = input.computedAt ?? input.asOf;
  const selected = upcoming.slice(0, limit);
  const matches = selected.map((match) =>
    forecastResearchMatch({
      match,
      universe,
      asOf: input.asOf,
      computedAt,
    })
  );

  return {
    support: "research",
    production: false,
    includedInProduction: false,
    modelVersion: BIG_FIVE_RESEARCH_PARAMS.modelVersion,
    notProductionModelVersion: RESEARCH_NOT_PRODUCTION_MODEL_VERSION,
    paramsOrigin: "labeled-domestic-prior",
    competition,
    competitionName: getCompetition(competition).name,
    season: input.season,
    asOf: input.asOf,
    computedAt,
    ledgerLastIngestAt: input.ledgerLastIngestAt ?? null,
    completedMatchesInLedger,
    evidenceLevel: evidenceLevelFromCount(completedMatchesInLedger),
    upcomingCount: upcoming.length,
    matches,
    disclaimer: RESEARCH_FORECAST_DISCLAIMER,
  };
}

export function researchForecastForMatchId(input: {
  matchId: string;
  competition: ResearchForecastCompetitionId;
  season: string;
  asOf: string;
  matches: readonly CanonicalMatch[];
  computedAt?: string;
}): ResearchMatchForecast {
  const match = input.matches.find((row) => row.canonicalMatchId === input.matchId);
  if (!match) {
    throw new ResearchForecastError(
      `Unknown research fixture: ${input.matchId}.`,
      "UNKNOWN_MATCH",
      404
    );
  }
  if (match.competition !== input.competition || match.season !== input.season) {
    throw new ResearchForecastError(
      `Fixture ${input.matchId} is not in ${input.competition} ${input.season}.`,
      "UNKNOWN_MATCH",
      404
    );
  }
  return forecastResearchMatch({
    match,
    universe: input.matches,
    asOf: input.asOf,
    computedAt: input.computedAt,
  });
}
