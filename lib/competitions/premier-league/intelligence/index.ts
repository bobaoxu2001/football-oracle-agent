export {
  INTELLIGENCE_TEMPORAL_RULE,
  KILL_RESISTANCE_HEURISTIC_VERSION,
  MATCH_INTELLIGENCE_SCHEMA_VERSION,
  PLAYER_IMPORTANCE_HEURISTIC_VERSION,
  TACTICAL_MATCHUP_HEURISTIC_VERSION,
} from "./types";
export type {
  AbsenceImpact,
  DeclaredPlayerProfile,
  DeclaredScheduleFacts,
  DeclaredTeamArchetype,
  IntelligenceStance,
  MatchIntelligenceInput,
  MatchupDimension,
  PlayerAvailabilityAssessment,
  PlayerImportanceProfile,
  PremierLeagueMatchIntelligenceReport,
  ReplacementCompatibilityAssessment,
  UnitIntegrityAssessment,
} from "./types";
export { deriveMatchIntelligence, emptyMatchIntelligence } from "./derive";
export { buildPlayerImportance } from "./importance";
export { assessAvailability, mapAvailabilityState } from "./availability";
export { assessReplacement } from "./replacement";
export { assessUnits } from "./units";
export { assessMatchups } from "./matchup";
export { assessOpponentExperience } from "./opponent-type";
export { assessKillResistance } from "./kill-resistance";
export { legallyAvailable } from "./evidence";
export {
  API_FOOTBALL_AUTH_HEADER,
  API_FOOTBALL_BASE_URL,
  API_FOOTBALL_EPL_LEAGUE_ID,
  API_FOOTBALL_ENV_NAME,
  AVAILABLE_AT_POLICY,
  ProviderProbeBlockedError,
  apiFootballAuthorizationState,
  assertLiveProbeAuthorized,
  firstObservedAvailableAt,
  mapProviderFixtureToCanonical,
  refuseLiveApiFootballProbe,
} from "./provider-gate";
export type { CanonicalFixtureMapResult, ProviderAuthorizationState } from "./provider-gate";
