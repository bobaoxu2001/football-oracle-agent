/**
 * Competition configuration — the single place league/tournament differences live.
 *
 * Prediction, simulation, and the agent read a CompetitionConfig rather than
 * branching on raw competition codes ("PL", "WC") throughout the codebase.
 */

export const COMPETITION_IDS = [
  "world-cup",
  "premier-league",
  "la-liga",
  "bundesliga",
  "serie-a",
  "ligue-1",
] as const;
export type CompetitionId = (typeof COMPETITION_IDS)[number];

/**
 * The five domestic leagues the 2026-27 match ledger tracks.
 *
 * World Cup is deliberately excluded: it is a tournament plugin with a
 * different simulation mode, not a league season.
 */
export const BIG_FIVE_COMPETITION_IDS = [
  "premier-league",
  "la-liga",
  "bundesliga",
  "serie-a",
  "ligue-1",
] as const;
export type BigFiveCompetitionId = (typeof BIG_FIVE_COMPETITION_IDS)[number];

export function isBigFiveCompetitionId(value: string): value is BigFiveCompetitionId {
  return (BIG_FIVE_COMPETITION_IDS as readonly string[]).includes(value);
}

export type CompetitionType = "tournament" | "league";
export type TeamKind = "nation" | "club";
export type HomeAdvantageMode = "host-nations" | "true-home-away";
export type SimulationMode = "tournament-bracket" | "league-table";
/** football-data.org v4 competition codes. */
export type FootballDataCode = "WC" | "PL" | "PD" | "BL1" | "SA" | "FL1";
export type Tiebreaker = "points" | "gd" | "gf" | "h2h" | "fair-play";
export type VenueSide = "home" | "away" | "neutral";

export interface SeasonFormat {
  /** Typical number of clubs / nations in the competition field. */
  teams: number;
  /** Scheduled matchdays in a full season (38 for PL; unused for WC knockout). */
  matchdays: number;
  homeAndAway: boolean;
}

export interface StandingsRules {
  pointsForWin: number;
  pointsForDraw: number;
  pointsForLoss: number;
  /** Applied in order after points. Premier League: GD then GF. */
  tiebreakers: Tiebreaker[];
}

export interface CompetitionConfig {
  id: CompetitionId;
  name: string;
  country: string | null;
  competitionType: CompetitionType;
  footballDataCode: FootballDataCode;
  apiFootballLeagueId: number;
  teamKind: TeamKind;
  seasonFormat: SeasonFormat;
  allowsDraw: boolean;
  homeAdvantageMode: HomeAdvantageMode;
  standingsRules: StandingsRules;
  simulationMode: SimulationMode;
}
