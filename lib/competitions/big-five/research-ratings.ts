/**
 * Walk-forward Elo for Big Five research forecasts.
 *
 * Ratings are competition-scoped and as-of filtered through admissibleMatches().
 * A completed match may move ratings only when resultObservedAt <= asOf and
 * kickoffUtc < asOf, and never for the fixture being predicted.
 */

import { admissibleMatches, type FeatureCutoff } from "@/lib/match-ledger/features";
import { isCompletedMatch, type CanonicalMatch } from "@/lib/match-ledger/types";
import {
  earlySeasonKScale,
  expectedScore,
  gMult,
} from "@/lib/prediction-engine/rating-core";
import {
  assertResearchForecastCompetition,
  type BigFiveResearchParams,
} from "./research-params";

export interface ResearchRatingState {
  ratings: Record<string, number>;
  matchesPlayedSeason: Record<string, number>;
  matchesApplied: number;
  lastAppliedKickoffUtc: string | null;
  lastAppliedMatchId: string | null;
}

export function clubSlugsInUniverse(matches: readonly CanonicalMatch[]): string[] {
  const slugs = new Set<string>();
  for (const match of matches) {
    slugs.add(match.home.slug);
    slugs.add(match.away.slug);
  }
  return [...slugs].sort();
}

export function emptyResearchRatingState(
  clubSlugs: readonly string[],
  meanElo: number
): ResearchRatingState {
  const ratings: Record<string, number> = {};
  const matchesPlayedSeason: Record<string, number> = {};
  for (const slug of clubSlugs) {
    ratings[slug] = meanElo;
    matchesPlayedSeason[slug] = 0;
  }
  return {
    ratings,
    matchesPlayedSeason,
    matchesApplied: 0,
    lastAppliedKickoffUtc: null,
    lastAppliedMatchId: null,
  };
}

export function ratingOf(
  state: ResearchRatingState,
  slug: string,
  meanElo: number
): number {
  return state.ratings[slug] ?? meanElo;
}

export function applyCompletedMatchToRatings(
  state: ResearchRatingState,
  match: CanonicalMatch,
  params: BigFiveResearchParams
): void {
  if (!isCompletedMatch(match)) return;
  const homeGoals = match.fullTimeHomeGoals;
  const awayGoals = match.fullTimeAwayGoals;
  if (homeGoals === null || awayGoals === null) return;

  const ra = ratingOf(state, match.home.slug, params.meanElo);
  const rb = ratingOf(state, match.away.slug, params.meanElo);
  const playedH = state.matchesPlayedSeason[match.home.slug] ?? 0;
  const playedA = state.matchesPlayedSeason[match.away.slug] ?? 0;
  const k =
    params.kFactor *
    gMult(homeGoals - awayGoals) *
    ((earlySeasonKScale(playedH) + earlySeasonKScale(playedA)) / 2);
  const expected = expectedScore(ra, rb, params.homeAdvantage);
  const score = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
  const delta = k * (score - expected);
  state.ratings[match.home.slug] = ra + delta;
  state.ratings[match.away.slug] = rb - delta;
  state.matchesPlayedSeason[match.home.slug] = playedH + 1;
  state.matchesPlayedSeason[match.away.slug] = playedA + 1;
  state.matchesApplied += 1;
  state.lastAppliedKickoffUtc = match.kickoffUtc;
  state.lastAppliedMatchId = match.canonicalMatchId;
}

/**
 * Ratings knowable at `cutoff.asOf` inside one competition-season.
 * The universe of club slugs includes scheduled fixtures so unplayed clubs
 * exist at the mean rather than being invented at predict time.
 */
export function researchRatingsAsOf(
  matches: readonly CanonicalMatch[],
  cutoff: FeatureCutoff,
  params: BigFiveResearchParams
): ResearchRatingState {
  assertResearchForecastCompetition(cutoff.competition);
  const universe = matches.filter(
    (match) => match.competition === cutoff.competition && match.season === cutoff.season
  );
  const state = emptyResearchRatingState(clubSlugsInUniverse(universe), params.meanElo);
  const admissible = admissibleMatches([...matches], cutoff).sort(
    (a, b) =>
      (a.kickoffUtc ?? "").localeCompare(b.kickoffUtc ?? "") ||
      a.canonicalMatchId.localeCompare(b.canonicalMatchId)
  );
  for (const match of admissible) {
    applyCompletedMatchToRatings(state, match, params);
  }
  return state;
}
