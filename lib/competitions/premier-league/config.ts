import type { CompetitionConfig } from "../types";

export const PREMIER_LEAGUE_CONFIG: CompetitionConfig = {
  id: "premier-league",
  name: "Premier League",
  country: "England",
  competitionType: "league",
  footballDataCode: "PL",
  apiFootballLeagueId: 39,
  teamKind: "club",
  seasonFormat: { teams: 20, matchdays: 38, homeAndAway: true },
  allowsDraw: true,
  homeAdvantageMode: "true-home-away",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    // Official PL: points → goal difference → goals scored. H2H is not used.
    tiebreakers: ["points", "gd", "gf"],
  },
  simulationMode: "league-table",
};

export const PREMIER_LEAGUE_CURRENT_SEASON = "2026-27";
