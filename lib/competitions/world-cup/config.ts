import type { CompetitionConfig } from "../types";

export const WORLD_CUP_CONFIG: CompetitionConfig = {
  id: "world-cup",
  name: "FIFA World Cup 2026",
  country: null,
  competitionType: "tournament",
  footballDataCode: "WC",
  apiFootballLeagueId: 1,
  teamKind: "nation",
  seasonFormat: { teams: 48, matchdays: 3, homeAndAway: false },
  allowsDraw: true, // group stage; knockout sampled with allowDraw=false
  homeAdvantageMode: "host-nations",
  standingsRules: {
    pointsForWin: 3,
    pointsForDraw: 1,
    pointsForLoss: 0,
    tiebreakers: ["points", "gd", "gf", "h2h", "fair-play"],
  },
  simulationMode: "tournament-bracket",
};
