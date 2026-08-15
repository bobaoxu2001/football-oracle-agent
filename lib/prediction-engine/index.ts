export {
  predictMatch,
  simulateGroup,
  simulateTournament,
  getChampionProbabilities,
  getChampionOddsFor,
  generateMatchExplanation,
  STAGE_KEYS,
  type TournamentResult,
} from "./engine";
export { ELO_RATINGS, getRating, HOME_ADVANTAGE } from "./ratings";
export {
  computeRatingUpdates,
  getUpdatedRating,
  getResultDelta,
  ratingUpdatesMeta,
  type CompletedResult,
  type RatingUpdates,
} from "./ratingUpdates";
export {
  AVAILABILITY_ADJUSTMENTS,
  SQUAD_STABILITY_CAP,
  VALUE_TO_ELO,
  ROLE_WEIGHTS,
  entryDelta,
  getAvailabilityAdjustments,
  getAvailabilityDelta,
  getEffectiveRating,
  availabilityMeta,
  type AvailabilityAdjustment,
  type PlayerRole,
} from "./availabilityAdjustments";
export {
  TEAM_STYLES,
  NEUTRAL_STYLE,
  TACTICAL_CLASH_WEIGHT,
  TACTICAL_CAP,
  getStyle,
  getTacticalMatchup,
  tacticalMatchupMeta,
  type TacticalStyle,
  type TacticalMatchup,
} from "./tacticalMatchups";
export {
  GROUP_DRAW_BOOST,
  DRAW_CEIL,
  LOWBLOCK_DRAW_WEIGHT,
  isGroupFixture,
  drawMultiplierFor,
  inflateDraw,
  applyDrawPropensity,
  drawPropensityMeta,
  type DrawAdjusted,
} from "@/lib/competitions/world-cup/drawPropensity";
export {
  getBounceBack,
  bounceBackDelta,
  bounceBackMeta,
  QUALITY_FLOOR,
  GAP_FLOOR,
  BOUNCE_CAP,
} from "@/lib/competitions/world-cup/bounceBack";
export {
  classifyStakes,
  matchStakesDelta,
  getMatchStakes,
  getMatchStakesState,
  describeStakes,
  matchStakesMeta,
  ROTATION_ELO,
  ROTATION_CAP,
  ROTATION_LEAD,
  ROTATION_WEIGHT,
  DEFAULT_ROTATION_TENDENCY,
  type StakesState,
} from "@/lib/competitions/world-cup/matchStakes";
export {
  projectSeeding,
  knockoutPath,
  quarterFields,
  describePath,
  type Seeding,
  type KnockoutPath,
  type PathStep,
  type QuarterField,
} from "@/lib/competitions/world-cup/bracketPath";
export {
  classifyMatchType,
  COINFLIP_FAV_CEIL,
  ELITE_KILL,
  BLUNT_KILL,
  ELITE_RESISTANCE,
  type MatchTypeInput,
} from "./matchType";
export {
  PRE_MATCH_INTEL,
  INTEL_CAP,
  intelEloImpact,
  getFixtureIntel,
  getIntelDelta,
  getConfirmedIntel,
  getIntelUncertainty,
  preMatchIntelligenceMeta,
  intelTeamName,
  type PreMatchIntel,
  type IntelStatus,
  type IntelType,
} from "./preMatchIntelligence";
export {
  FORM_SENSITIVITY,
  FORM_SHRINK_PRIOR,
  FORM_CAP,
  computeConfederationForm,
  getConfederationDelta,
  confederationFormMeta,
  type ConfederationFormRow,
} from "@/lib/competitions/world-cup/confederationForm";
export {
  matchProb,
  matchProbFromGoals,
  sampleMatch,
  sampleFromGrid,
  expectedScore,
  expectedGoals,
  scorelineGrid,
  scorelineGridFromGoals,
  mulberry32,
} from "./elo";
export {
  GAP_SCALE,
  GAP_CAL_CAP,
  gapCalibration,
  type GapCalibration,
} from "./confidenceCalibration";
export {
  getCompletedFixture,
  hasBeenPlayed,
  completedFixtureNote,
  type CompletedFixture,
} from "./completedFixtures";
