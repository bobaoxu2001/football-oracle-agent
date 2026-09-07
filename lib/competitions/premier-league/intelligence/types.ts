/**
 * Premier League Match Intelligence V1 contracts.
 *
 * Layer B only. Never a production probability. Never mutates LIVE_OOS.
 */

export const MATCH_INTELLIGENCE_SCHEMA_VERSION = "pl-match-intelligence-v1" as const;
export const PLAYER_IMPORTANCE_HEURISTIC_VERSION = "pl-player-importance-v0.1.0-heuristic" as const;
export const TACTICAL_MATCHUP_HEURISTIC_VERSION = "pl-tactical-matchup-v0.1.0-heuristic" as const;
export const KILL_RESISTANCE_HEURISTIC_VERSION = "pl-kill-resistance-v0.1.0-heuristic" as const;
export const INTELLIGENCE_TEMPORAL_RULE = "availableAt <= contextCutoffAt" as const;

export const INTELLIGENCE_CONTEXT_STAGES = [
  "EARLY_PREMATCH",
  "PRE_LINEUP",
  "CONFIRMED_LINEUP",
] as const;
export type IntelligenceContextStage = (typeof INTELLIGENCE_CONTEXT_STAGES)[number];

export const EVIDENCE_SOURCE_TIERS = [
  "OFFICIAL_COMPETITION",
  "CONFIRMED_LINEUP",
  "MANAGER_AVAILABILITY",
  "REPUTABLE_TEAM_REPORTER",
  "REPUTABLE_SPORTS_REPORTING",
  "AGGREGATOR",
  "SPECULATION",
  "SYNTHETIC_TEST",
  "UNDECLARED",
] as const;
export type EvidenceSourceTier = (typeof EVIDENCE_SOURCE_TIERS)[number];

export const VERIFICATION_STATES = [
  "VERIFIED",
  "CORROBORATED",
  "UNCONFIRMED",
  "CONFLICTED",
  "SPECULATIVE",
  "UNKNOWN",
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const CONFIDENCE_BANDS = ["LOW", "MEDIUM", "HIGH"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const AVAILABILITY_STATES = [
  "AVAILABLE",
  "EXPECTED_START",
  "EXPECTED_BENCH",
  "DOUBTFUL",
  "LIMITED",
  "SUSPENDED",
  "INJURED",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type IntelligenceAvailabilityState = (typeof AVAILABILITY_STATES)[number];

export const SPINE_ROLES = [
  "GOALKEEPER",
  "CENTER_BACK",
  "DEFENSIVE_MIDFIELDER",
  "PROGRESSION_MIDFIELDER",
  "MAIN_CREATOR",
  "PRIMARY_FINISHER",
  "OTHER",
] as const;
export type SpineRole = (typeof SPINE_ROLES)[number];

export const ABSENCE_IMPACTS = [
  "NEGLIGIBLE",
  "LOW",
  "MODERATE",
  "HIGH",
  "STRUCTURAL",
  "UNKNOWN",
] as const;
export type AbsenceImpact = (typeof ABSENCE_IMPACTS)[number];

export const UNIT_STATES = [
  "INTACT",
  "MINOR_ROTATION",
  "PARTIALLY_DISRUPTED",
  "STRUCTURALLY_DISRUPTED",
  "UNKNOWN",
] as const;
export type UnitIntegrityState = (typeof UNIT_STATES)[number];

export const UNIT_KINDS = [
  "GOALKEEPER_CB_PAIR",
  "CB_PAIR",
  "LEFT_FLANK",
  "RIGHT_FLANK",
  "MIDFIELD_PIVOT",
  "MIDFIELD_TRIANGLE",
  "CREATOR_FINISHER",
  "FRONT_THREE",
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const MATCHUP_LEVELS = ["LOW", "MODERATE", "HIGH", "UNKNOWN"] as const;
export type MatchupLevel = (typeof MATCHUP_LEVELS)[number];

export const OPPONENT_ARCHETYPES = [
  "HIGH_PRESS",
  "LOW_BLOCK",
  "POSSESSION_DOMINANT",
  "DIRECT_TRANSITION",
  "AERIAL_SET_PIECE_HEAVY",
  "HIGH_DEFENSIVE_LINE",
  "DEEP_DEFENSIVE_LINE",
  "AGGRESSIVE_FULLBACK_OVERLOAD",
  "NARROW_CENTRAL_OVERLOAD",
  "COUNTERATTACKING_UNDERDOG",
] as const;
export type OpponentArchetype = (typeof OPPONENT_ARCHETYPES)[number];

export const STANCE_VALUES = [
  "SUPPORTS_CHAMPION",
  "CHALLENGES_CHAMPION",
  "NEUTRAL",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type IntelligenceStance = (typeof STANCE_VALUES)[number];

export const STATEMENT_CLASSES = ["FACT", "NARRATIVE", "UNKNOWN"] as const;
export type StatementClass = (typeof STATEMENT_CLASSES)[number];

export interface IntelligenceEvidenceRef {
  evidenceId: string | null;
  sourceName: string;
  sourceTier: EvidenceSourceTier;
  observedAt: string | null;
  fetchedAt: string | null;
  availableAt: string | null;
  legallyAvailable: boolean;
  verification: VerificationState;
  statementClass: StatementClass;
  note: string;
}

export interface PlayerImportanceProfile {
  playerId: string;
  teamSlug: string;
  displayName: string;
  spineRole: SpineRole;
  minutesShare: number | null;
  startShare: number | null;
  attackingRole: number | null;
  creativeRole: number | null;
  progressionRole: number | null;
  defensiveRole: number | null;
  setPieceRole: number | null;
  roleScarcity: number | null;
  replacementGap: number | null;
  importanceScore: number | null;
  evidenceCompleteness: number;
  confidence: ConfidenceBand;
  heuristicVersion: typeof PLAYER_IMPORTANCE_HEURISTIC_VERSION;
  componentsUsed: string[];
  caveat: string;
}

export interface PlayerAvailabilityAssessment {
  playerId: string;
  teamSlug: string;
  displayName: string;
  state: IntelligenceAvailabilityState;
  spineRole: SpineRole;
  occupiesSpine: boolean;
  importance: PlayerImportanceProfile | null;
  absenceImpact: AbsenceImpact;
  impactScore: number | null;
  replacement: ReplacementCompatibilityAssessment | null;
  evidence: IntelligenceEvidenceRef;
}

export interface ReplacementCompatibilityAssessment {
  starterId: string;
  replacementId: string | null;
  replacementName: string | null;
  samePositionalArchetype: boolean | null;
  formationCanRemain: boolean | null;
  possessionStructureChanges: boolean | null;
  pressingStructureChanges: boolean | null;
  defensiveCoverageChanges: boolean | null;
  transitionThreatChanges: boolean | null;
  setPieceHierarchyChanges: boolean | null;
  anotherKeyPlayerForcedRoleChange: boolean | null;
  rawPlayerLoss: AbsenceImpact;
  systemDisruption: AbsenceImpact;
  note: string;
}

export interface UnitIntegrityAssessment {
  kind: UnitKind;
  teamSlug: string;
  state: UnitIntegrityState;
  expectedStarters: number;
  availableExpectedStarters: number | null;
  replacementCount: number | null;
  forcedRoleChanges: number | null;
  note: string;
}

export interface MatchupDimension {
  id:
    | "HIGH_LINE_VS_PACE"
    | "PRESS_VS_BUILD_UP"
    | "LOW_BLOCK_VS_CHANCE_CREATION"
    | "WIDE_LEFT"
    | "WIDE_RIGHT"
    | "CENTRAL_MIDFIELD"
    | "AERIAL_SET_PIECE"
    | "TRANSITION"
    | "FINISHER_VS_DEFENCE"
    | "GAME_STATE";
  level: MatchupLevel;
  favors: "home" | "away" | "neither" | "unknown";
  sterilePossessionRisk: boolean;
  firstGoalLeverage: "HOME_OPENS" | "AWAY_OPENS" | "COMPACT_SURVIVES" | "UNKNOWN" | null;
  note: string;
}

export interface OpponentTypeExperience {
  teamSlug: string;
  opponentArchetype: OpponentArchetype | null;
  observations: number | null;
  solvedTacticalProblem: boolean | null;
  note: string;
  evidenceCompleteness: number;
}

export interface KillResistanceAssessment {
  teamSlug: string;
  role: "favorite" | "underdog" | "even";
  killIndex: number | null;
  resistanceIndex: number | null;
  components: { label: string; value: number | null }[];
  heuristicVersion: typeof KILL_RESISTANCE_HEURISTIC_VERSION;
  caveat: string;
}

export interface MotivationScheduleContext {
  teamSlug: string;
  titleRace: boolean | null;
  europeanQualificationRace: boolean | null;
  relegationRisk: boolean | null;
  daysRest: number | null;
  fixtureCongestion: boolean | null;
  midweekEuropean: boolean | null;
  derby: boolean | null;
  likelyRotation: boolean | null;
  note: string;
  evidenceCompleteness: number;
}

export interface SourceConflict {
  subjectId: string;
  field: string;
  left: string;
  right: string;
  note: string;
}

export interface PremierLeagueMatchIntelligenceReport {
  schemaVersion: typeof MATCH_INTELLIGENCE_SCHEMA_VERSION;
  intelligenceId: string;
  competition: "premier-league";
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  contextStage: IntelligenceContextStage;
  contextCutoffAt: string;
  generatedAt: string;
  temporalRule: typeof INTELLIGENCE_TEMPORAL_RULE;
  productionForecastId: string | null;
  productionModelVersion: "pl-live-v0.2.0";
  includedInChampionProbability: false;
  sourceAuthorization: "NONE_CONFIGURED" | "PARTIAL" | "SYNTHETIC_TEST";
  lineupState: "CONFIRMED" | "EXPECTED" | "LINEUP_UNCERTAIN";
  availability: PlayerAvailabilityAssessment[];
  units: UnitIntegrityAssessment[];
  matchups: MatchupDimension[];
  opponentExperience: OpponentTypeExperience[];
  killResistance: KillResistanceAssessment[];
  motivation: MotivationScheduleContext[];
  conflicts: SourceConflict[];
  excludedAfterCutoffCount: number;
  stance: IntelligenceStance;
  intelligenceConfidence: ConfidenceBand;
  disclaimer: string;
}

export interface DeclaredPlayerProfile {
  playerId: string;
  teamSlug: string;
  displayName: string;
  spineRole: SpineRole;
  minutesShare?: number | null;
  startShare?: number | null;
  attackingRole?: number | null;
  creativeRole?: number | null;
  progressionRole?: number | null;
  defensiveRole?: number | null;
  setPieceRole?: number | null;
  roleScarcity?: number | null;
  replacementGap?: number | null;
  replacementId?: string | null;
  replacementName?: string | null;
  samePositionalArchetype?: boolean | null;
  formationCanRemain?: boolean | null;
  possessionStructureChanges?: boolean | null;
  pressingStructureChanges?: boolean | null;
  defensiveCoverageChanges?: boolean | null;
  transitionThreatChanges?: boolean | null;
  setPieceHierarchyChanges?: boolean | null;
  anotherKeyPlayerForcedRoleChange?: boolean | null;
  synthetic?: boolean;
}

export interface DeclaredTeamArchetype {
  teamSlug: string;
  archetypes: OpponentArchetype[];
  lineHeight: MatchupLevel | null;
  recoverySpeed: MatchupLevel | null;
  pressIntensity: MatchupLevel | null;
  pressResistance: MatchupLevel | null;
  chanceCreation: MatchupLevel | null;
  sterilePossessionRisk: boolean | null;
  wideThreatLeft: MatchupLevel | null;
  wideThreatRight: MatchupLevel | null;
  centralControl: MatchupLevel | null;
  aerialAttack: MatchupLevel | null;
  aerialDefence: MatchupLevel | null;
  setPieceDelivery: MatchupLevel | null;
  transitionAttack: MatchupLevel | null;
  restDefence: MatchupLevel | null;
  boxThreat: MatchupLevel | null;
  finishing: MatchupLevel | null;
  compactness: MatchupLevel | null;
  priorVsArchetype?: Partial<Record<OpponentArchetype, { observations: number; solved: boolean }>>;
  synthetic?: boolean;
}

export interface DeclaredScheduleFacts {
  teamSlug: string;
  titleRace?: boolean | null;
  europeanQualificationRace?: boolean | null;
  relegationRisk?: boolean | null;
  daysRest?: number | null;
  fixtureCongestion?: boolean | null;
  midweekEuropean?: boolean | null;
  derby?: boolean | null;
  rotatedInComparableSpot?: boolean | null;
  synthetic?: boolean;
}

export interface MatchIntelligenceInput {
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffAt: string;
  contextCutoffAt: string;
  generatedAt: string;
  productionForecastId: string | null;
  contextSnapshot: {
    contextId: string;
    cutoffAt: string;
    lineupOverall: "NONE" | "EXPECTED" | "CONFIRMED" | "PARTIAL";
    evidence: Array<{
      evidenceId: string;
      kind: string;
      entityId: string;
      teamSlug: string | null;
      observedAt: string;
      fetchedAt: string;
      availableAt: string;
      sourceName: string;
      availabilityStatus: string | null;
      lineupStatus: string | null;
      payload?: Record<string, unknown> | null;
      usedInForecast: boolean;
    }>;
  } | null;
  players?: DeclaredPlayerProfile[];
  archetypes?: DeclaredTeamArchetype[];
  schedule?: DeclaredScheduleFacts[];
  sourceAuthorization?: PremierLeagueMatchIntelligenceReport["sourceAuthorization"];
}
