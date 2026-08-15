/**
 * Walk-forward Premier League Elo.
 *
 * Season initialization is delegated to initializeSeasonRatings.
 * Championship feeder ratings are wired for clubs that were not in the
 * previous Premier League field. 2026-27 promoted sides are not invented.
 */

import type { Fixture } from "@/lib/identity/types";
import {
  DEFAULT_CLUB_ELO,
  baseK,
  earlySeasonKScale,
  expectedScore,
  gMult,
} from "@/lib/prediction-engine/rating-core";
import { initializeSeasonRatings } from "@/lib/prediction-engine/season-init";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import { completedPremierLeagueFixtures, clubSlugsInSeason } from "./data";
import { championshipRatingsAsOf } from "./championship";

export interface RatingState {
  ratings: Record<string, number>;
  matchesPlayedSeason: Record<string, number>;
  season: string | null;
  clubSlugs: string[];
}

export function emptyRatingState(): RatingState {
  return { ratings: {}, matchesPlayedSeason: {}, season: null, clubSlugs: [] };
}

export function ratingOf(state: RatingState, slug: string): number {
  return state.ratings[slug] ?? DEFAULT_CLUB_ELO;
}

export function applySeasonBoundary(
  state: RatingState,
  nextSeason: string,
  nextClubSlugs: string[],
  asOf: string
): void {
  const init = initializeSeasonRatings({
    previousPlRatings: state.ratings,
    previousPlClubSlugs: state.clubSlugs,
    newSeasonClubSlugs: nextClubSlugs,
    feederRatings: championshipRatingsAsOf(asOf),
  });
  state.ratings = init.ratings;
  state.matchesPlayedSeason = {};
  state.season = nextSeason;
  state.clubSlugs = [...nextClubSlugs];
}

export function applyFixtureToRatings(state: RatingState, f: Fixture, kFactor?: number): void {
  if (f.status !== "completed" || f.homeGoals === null || f.awayGoals === null) return;
  if (state.season !== f.season) {
    const slugs = clubSlugsInSeason(f.season);
    if (slugs.length === 0) slugs.push(f.homeSlug, f.awaySlug);
    applySeasonBoundary(state, f.season, slugs, f.date);
  }

  const params = loadPremierLeagueParams();
  const ha = f.venue === "neutral" ? 0 : params.homeAdvantage;
  const ra = ratingOf(state, f.homeSlug);
  const rb = ratingOf(state, f.awaySlug);
  const playedH = state.matchesPlayedSeason[f.homeSlug] ?? 0;
  const playedA = state.matchesPlayedSeason[f.awaySlug] ?? 0;
  const kBase = kFactor ?? params.kFactor ?? baseK("premier league");
  const k =
    kBase *
    gMult(f.homeGoals - f.awayGoals) *
    ((earlySeasonKScale(playedH) + earlySeasonKScale(playedA)) / 2);
  const exp = expectedScore(ra, rb, ha);
  const sc = f.homeGoals > f.awayGoals ? 1 : f.homeGoals < f.awayGoals ? 0 : 0.5;
  const delta = k * (sc - exp);
  state.ratings[f.homeSlug] = ra + delta;
  state.ratings[f.awaySlug] = rb - delta;
  state.matchesPlayedSeason[f.homeSlug] = playedH + 1;
  state.matchesPlayedSeason[f.awaySlug] = playedA + 1;
}

/**
 * Ratings as of a cutoff (exclusive). Only completed fixtures with
 * date < asOf are applied. Same-date fixtures on asOf are excluded.
 */
export function ratingsAsOf(asOf: string, fixtures?: Fixture[]): RatingState {
  const state = emptyRatingState();
  const all = (fixtures ?? completedPremierLeagueFixtures())
    .filter((f) => f.status === "completed" && f.date < asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const f of all) applyFixtureToRatings(state, f);
  return state;
}

export function ratingsAfterAll(fixtures?: Fixture[]): RatingState {
  const state = emptyRatingState();
  const all = (fixtures ?? completedPremierLeagueFixtures())
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const f of all) applyFixtureToRatings(state, f);
  return state;
}
