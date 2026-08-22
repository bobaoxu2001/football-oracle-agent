/**
 * Big Five domestic league configurations.
 *
 * These reuse the existing CompetitionConfig contract rather than introducing a
 * second league abstraction. Premier League keeps its own config module because
 * the Phase 1/2A production model, ratings and frozen tape are already built on
 * it; the four added leagues are ledger-only for now (see docs/BIG_FIVE_LEDGER.md).
 *
 * Tiebreakers are the real published rules and DO differ:
 *   • England / Germany / France — goal difference before head-to-head
 *   • Spain / Italy              — head-to-head before goal difference
 * They are recorded because standings are competition-scoped, not shared.
 */

import type { CompetitionConfig } from "../types";

export const LA_LIGA_CONFIG: CompetitionConfig = {
  id: "la-liga",
  name: "La Liga",
  country: "Spain",
  competitionType: "league",
  footballDataCode: "PD",
  apiFootballLeagueId: 140,
  teamKind: "club",
  seasonFormat: { teams: 20, matchdays: 38, homeAndAway: true },
  allowsDraw: true,
  homeAdvantageMode: "true-home-away",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    // RFEF: points → head-to-head → goal difference → goals scored.
    tiebreakers: ["points", "h2h", "gd", "gf"],
  },
  simulationMode: "league-table",
};

export const BUNDESLIGA_CONFIG: CompetitionConfig = {
  id: "bundesliga",
  name: "Bundesliga",
  country: "Germany",
  competitionType: "league",
  footballDataCode: "BL1",
  apiFootballLeagueId: 78,
  teamKind: "club",
  seasonFormat: { teams: 18, matchdays: 34, homeAndAway: true },
  allowsDraw: true,
  homeAdvantageMode: "true-home-away",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    // DFL: points → goal difference → goals scored → head-to-head.
    tiebreakers: ["points", "gd", "gf", "h2h"],
  },
  simulationMode: "league-table",
};

export const SERIE_A_CONFIG: CompetitionConfig = {
  id: "serie-a",
  name: "Serie A",
  country: "Italy",
  competitionType: "league",
  footballDataCode: "SA",
  apiFootballLeagueId: 135,
  teamKind: "club",
  seasonFormat: { teams: 20, matchdays: 38, homeAndAway: true },
  allowsDraw: true,
  homeAdvantageMode: "true-home-away",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    // Lega Serie A: points → head-to-head → goal difference → goals scored.
    tiebreakers: ["points", "h2h", "gd", "gf"],
  },
  simulationMode: "league-table",
};

export const LIGUE_1_CONFIG: CompetitionConfig = {
  id: "ligue-1",
  name: "Ligue 1",
  country: "France",
  competitionType: "league",
  footballDataCode: "FL1",
  apiFootballLeagueId: 61,
  teamKind: "club",
  seasonFormat: { teams: 18, matchdays: 34, homeAndAway: true },
  allowsDraw: true,
  homeAdvantageMode: "true-home-away",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    // LFP: points → goal difference → goals scored.
    tiebreakers: ["points", "gd", "gf"],
  },
  simulationMode: "league-table",
};

/** Season label shared by the 2026-27 Big Five ledger. */
export const BIG_FIVE_CURRENT_SEASON = "2026-27";

/**
 * football-data.org indexes a season by its START year, so 2026-27 is
 * `season=2026`. Derived, never hard-coded per competition.
 */
export function seasonStartYear(season: string): number {
  const year = Number(season.slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error(`Invalid season label: ${season}`);
  }
  return year;
}
