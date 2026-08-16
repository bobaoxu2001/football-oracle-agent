/**
 * Current Premier League field and remaining-fixture helpers.
 *
 * Production uses the official CompetitionSeason + ingested fixtures when
 * the data gate is not blocked. The generated double round-robin remains
 * only as a test/synthetic fallback.
 */

import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { clubSlugsInSeason, completedPremierLeagueFixtures, fixturesForSeason } from "./data";
import { tableFromResults, type PlayedResult } from "./standings";
import type { RemainingFixture } from "./simulate";
import { evaluateDataGate } from "./data-gate";
import { liveCompetitionSeason, liveFixtures } from "./fixture-store";
import { canonicalizeFixtureStatus } from "./ingest";

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
  const gate = evaluateDataGate();
  const live = liveCompetitionSeason();
  if (gate.status !== "DATA_BLOCKED" && live && live.clubIds.length === live.expectedClubCount) {
    return [...live.clubIds];
  }
  const current = fixturesForSeason(PREMIER_LEAGUE_CURRENT_SEASON);
  if (current.length >= 20) return clubSlugsInSeason(PREMIER_LEAGUE_CURRENT_SEASON);
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
  dataSource: "REAL_2026_27_DATA" | "SYNTHETIC_PRESEASON_DATA";
} {
  const season = PREMIER_LEAGUE_CURRENT_SEASON;
  const gate = evaluateDataGate();
  const live = liveFixtures();
  if (gate.status !== "DATA_BLOCKED" && live.length > 0) {
    const clubSlugs = currentPremierLeagueField();
    const played: PlayedResult[] = live
      .filter((f) => {
        const st = canonicalizeFixtureStatus(f.status);
        return st === "FINISHED" && f.homeGoals !== null && f.awayGoals !== null;
      })
      .map((f) => ({
        homeSlug: f.homeSlug,
        awaySlug: f.awaySlug,
        homeGoals: f.homeGoals as number,
        awayGoals: f.awayGoals as number,
      }));
    const remaining: RemainingFixture[] = live
      .filter((f) => {
        const st = canonicalizeFixtureStatus(f.status);
        return st === "SCHEDULED" || st === "LIVE";
      })
      .map((f) => ({ homeSlug: f.homeSlug, awaySlug: f.awaySlug }));
    return { season, clubSlugs, played, remaining, dataSource: "REAL_2026_27_DATA" };
  }
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
    return { season, clubSlugs, played, remaining, dataSource: "REAL_2026_27_DATA" };
  }
  const clubSlugs = currentPremierLeagueField();
  return {
    season,
    clubSlugs,
    played: [],
    remaining: generateRoundRobin(clubSlugs),
    dataSource: "SYNTHETIC_PRESEASON_DATA",
  };
}
