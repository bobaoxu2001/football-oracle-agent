export type {
  CompetitionId,
  CompetitionType,
  TeamKind,
  HomeAdvantageMode,
  SimulationMode,
  FootballDataCode,
  Tiebreaker,
  VenueSide,
  SeasonFormat,
  StandingsRules,
  CompetitionConfig,
} from "./types";
export { COMPETITION_IDS } from "./types";
export {
  DEFAULT_COMPETITION_ID,
  getCompetition,
  listCompetitions,
  isCompetitionId,
  resolveCompetitionId,
} from "./registry";
export { WORLD_CUP_CONFIG } from "./world-cup/config";
export { PREMIER_LEAGUE_CONFIG, PREMIER_LEAGUE_CURRENT_SEASON } from "./premier-league/config";
