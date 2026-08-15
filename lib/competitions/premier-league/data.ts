/**
 * Premier League historical fixtures — processed JSON from football-data.co.uk.
 *
 * Source provenance lives in data/sources.json. Unplayed / postponed rows
 * (missing goals) are stored as status=postponed and never enter ratings.
 */

import type { Fixture } from "@/lib/identity/types";
import processed from "@/data/processed/premier-league/fixtures.json";
import { resolveClubSlug } from "./clubs";

export interface RawFdMatch {
  season: string;
  date: string;
  home: string;
  away: string;
  homeGoals: number | null;
  awayGoals: number | null;
  division: "E0" | "E1";
}

let _cache: Fixture[] | null = null;

export function loadPremierLeagueFixtures(): Fixture[] {
  if (_cache) return _cache;
  const rows = (processed as { fixtures?: Array<{
    id: string;
    season: string;
    date: string;
    homeSlug: string;
    awaySlug: string;
    homeGoals: number | null;
    awayGoals: number | null;
    status: Fixture["status"];
    division?: string;
  }> }).fixtures ?? [];
  _cache = rows
    .filter((f) => !f.division || f.division === "E0")
    .map((f) => ({
      id: f.id,
      competition: "premier-league" as const,
      season: f.season,
      date: f.date,
      homeSlug: f.homeSlug,
      awaySlug: f.awaySlug,
      homeGoals: f.homeGoals,
      awayGoals: f.awayGoals,
      status: f.status,
      venue: "home" as const,
    }));
  return _cache;
}

export function completedPremierLeagueFixtures(season?: string): Fixture[] {
  return loadPremierLeagueFixtures().filter(
    (f) =>
      f.status === "completed" &&
      f.homeGoals !== null &&
      f.awayGoals !== null &&
      (!season || f.season === season)
  );
}

export function fixturesForSeason(season: string): Fixture[] {
  return loadPremierLeagueFixtures().filter((f) => f.season === season);
}

export function clubSlugsInSeason(season: string): string[] {
  const slugs = new Set<string>();
  for (const f of fixturesForSeason(season)) {
    slugs.add(f.homeSlug);
    slugs.add(f.awaySlug);
  }
  return [...slugs].sort();
}

export function parseFootballDataDate(raw: string): string | null {
  // dd/mm/yyyy or dd/mm/yy
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = Number(yyyy) >= 70 ? `19${yyyy}` : `20${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}

export function mapFootballDataTeam(name: string): string | null {
  return resolveClubSlug(name);
}

export function fixtureKey(season: string, date: string, home: string, away: string): string {
  return `${season}:${date}:${home}:${away}`;
}

export function isDuplicateFixture(seen: Set<string>, f: Fixture): boolean {
  const k = fixtureKey(f.season, f.date, f.homeSlug, f.awaySlug);
  if (seen.has(k)) return true;
  seen.add(k);
  return false;
}
