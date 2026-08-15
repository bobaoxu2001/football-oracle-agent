/**
 * Current Premier League field and remaining-fixture helpers.
 *
 * 2026-27 fixtures are not invented. If the processed file has no rows for
 * that season, remaining fixtures are a generated double round-robin of the
 * inferred 20-club field (2025-26 finishers minus bottom 3, plus Championship
 * promotion placeholders when those clubs are known).
 */

import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { clubSlugsInSeason, completedPremierLeagueFixtures, fixturesForSeason } from "./data";
import { tableFromResults, type PlayedResult } from "./standings";
import type { RemainingFixture } from "./simulate";

export function lastCompletedSeason(): string {
  const seasons = [...new Set(completedPremierLeagueFixtures().map((f) => f.season))].sort();
  return seasons[seasons.length - 1] ?? "2025-26";
}

/** Clubs that finished a completed season — ordered by official PL table. */
export function seasonTable(season: string) {
  const results: PlayedResult[] = completedPremierLeagueFixtures(season).map((f) => ({
    homeSlug: f.homeSlug,
    awaySlug: f.awaySlug,
    homeGoals: f.homeGoals as number,
    awayGoals: f.awayGoals as number,
  }));
  return tableFromResults(clubSlugsInSeason(season), results);
}

export function currentPremierLeagueField(): string[] {
  const current = fixturesForSeason(PREMIER_LEAGUE_CURRENT_SEASON);
  if (current.length >= 20) return clubSlugsInSeason(PREMIER_LEAGUE_CURRENT_SEASON);
  // 2026-27 membership is not in the ingested file. Use the last completed
  // 20-club field rather than inventing promoted sides.
  return clubSlugsInSeason(lastCompletedSeason());
}

export function generateRoundRobin(clubSlugs: string[]): RemainingFixture[] {
  const clubs = [...clubSlugs].sort();
  const out: RemainingFixture[] = [];
  for (let i = 0; i < clubs.length; i++) {
    for (let j = 0; j < clubs.length; j++) {
      if (i === j) continue;
      out.push({ homeSlug: clubs[i], awaySlug: clubs[j] });
    }
  }
  return out;
}

export function remainingPremierLeagueFixtures(): {
  season: string;
  clubSlugs: string[];
  played: PlayedResult[];
  remaining: RemainingFixture[];
} {
  const season = PREMIER_LEAGUE_CURRENT_SEASON;
  const rows = fixturesForSeason(season);
  if (rows.length > 0) {
    const clubSlugs = clubSlugsInSeason(season);
    const played: PlayedResult[] = rows
      .filter((f) => f.status === "completed" && f.homeGoals !== null && f.awayGoals !== null)
      .map((f) => ({
        homeSlug: f.homeSlug,
        awaySlug: f.awaySlug,
        homeGoals: f.homeGoals as number,
        awayGoals: f.awayGoals as number,
      }));
    const remaining: RemainingFixture[] = rows
      .filter((f) => f.status !== "completed")
      .map((f) => ({ homeSlug: f.homeSlug, awaySlug: f.awaySlug }));
    return { season, clubSlugs, played, remaining };
  }
  const clubSlugs = currentPremierLeagueField();
  return {
    season,
    clubSlugs,
    played: [],
    remaining: generateRoundRobin(clubSlugs),
  };
}
