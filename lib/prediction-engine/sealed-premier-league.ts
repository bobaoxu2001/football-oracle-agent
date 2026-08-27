/**
 * Store-free Premier League prediction core.
 *
 * Runtime dependency allowlist:
 *   - `./elo`: deterministic Elo -> Dixon-Coles probability mathematics.
 *   - `../competitions/premier-league/provenance/canonical`: canonical JSON,
 *     content hashing, timestamp normalization, and detached deep freezing.
 *   - `../competitions/premier-league/provenance/manifest`: pure integrity
 *     assertions for the already-resolved immutable records.
 *
 * Deliberately prohibited here: fixture/rating/model stores, databases,
 * environment variables, filesystem access, network access, and clocks. The
 * caller must resolve every football-semantic input before crossing this
 * boundary. Production and replay can therefore share this exact function.
 */

import { matchProb, scorelineGrid } from "./elo";
import {
  canonicalSha256,
  cloneFrozen,
  normalizeTimestamp,
  requireNonEmpty,
  type Sha256Hash,
} from "@/lib/competitions/premier-league/provenance/canonical";
import {
  assertFrozenRatingStateIntegrity,
  assertImmutableModelBundleIntegrity,
} from "@/lib/competitions/premier-league/provenance/manifest";
import type {
  FrozenRatingStatePayload,
  FrozenRatingStateSnapshot,
  ImmutableModelBundle,
} from "@/lib/competitions/premier-league/provenance/types";
import type { MatchPrediction, ModelFactor } from "@/lib/types";

export const SEALED_PREMIER_LEAGUE_SCHEMA_VERSION =
  "pl-sealed-predictor-v1" as const;

export const SEALED_PREMIER_LEAGUE_STAGES = [
  "PRESEASON",
  "EARLY",
  "T7D",
  "T24H",
  "T2H",
  "T60M",
  "FINAL_PREKICK",
] as const;

export type SealedPremierLeagueStage =
  (typeof SEALED_PREMIER_LEAGUE_STAGES)[number];

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Exact fixture identity and display values consumed by the prediction. */
export interface SealedPremierLeagueFixture {
  readonly competition: "premier-league";
  readonly season: string;
  readonly fixtureId: string;
  readonly homeSlug: string;
  readonly awaySlug: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  /** The current production model is defined only for true home fixtures. */
  readonly venue: "home";
}

/** Complete content-addressed state supplied by the resolver; never rebuilt here. */
export type SealedPremierLeagueRatingStatePayload = FrozenRatingStatePayload;
export type SealedPremierLeagueRatingState = FrozenRatingStateSnapshot;

/** Full structural parameters frozen into the immutable model bundle. */
export interface SealedPremierLeagueModelParameters {
  readonly competition: "premier-league";
  readonly modelVersion: string;
  readonly homeAdvantage: number;
  readonly dcRho: number;
  readonly drawBias: number;
  readonly goalScale: number;
  readonly baseGoals: number;
  readonly awayHomeShare: number;
  readonly kFactor: number;
  readonly fittedAt: string;
  readonly trainingWindow: {
    readonly from: string;
    readonly to: string;
  };
  readonly notes: string;
}

/** Exact content-addressed model record supplied by the resolver. */
export type SealedPremierLeagueModelBundle = ImmutableModelBundle;

export interface SealedPremierLeaguePredictionInput {
  readonly fixture: SealedPremierLeagueFixture;
  readonly stage: SealedPremierLeagueStage;
  readonly cutoffAt: string;
  readonly generatedAt: string;
  readonly kickoffAtAsKnown: string;
  readonly modelVersion: string;
  readonly ratingState: SealedPremierLeagueRatingState;
  readonly modelBundle: SealedPremierLeagueModelBundle;
}

export interface SealedPremierLeagueScorelineCell {
  readonly a: number;
  readonly b: number;
  readonly p: number;
}

export interface SealedPremierLeaguePredictionArtifactCore {
  readonly schemaVersion: typeof SEALED_PREMIER_LEAGUE_SCHEMA_VERSION;
  /** Hash of every normalized, frozen semantic input below. */
  readonly frozenInputHash: Sha256Hash;
  readonly fixture: SealedPremierLeagueFixture;
  readonly stage: SealedPremierLeagueStage;
  readonly cutoffAt: string;
  readonly generatedAt: string;
  readonly kickoffAtAsKnown: string;
  readonly modelVersion: string;
  readonly ratingState: SealedPremierLeagueRatingState;
  readonly modelBundle: SealedPremierLeagueModelBundle;
  /** Exact parameter fields read by this predictor, detached from the bundle. */
  readonly consumedParameters: SealedPremierLeagueModelParameters;
  readonly elo: {
    readonly home: number;
    readonly away: number;
  };
  readonly probabilities: {
    readonly home: number;
    readonly draw: number;
    readonly away: number;
  };
  readonly expectedGoals: {
    readonly home: number;
    readonly away: number;
  };
  /** Complete normalized 9 x 9 grid, descending by probability. */
  readonly scorelineGrid: readonly SealedPremierLeagueScorelineCell[];
}

export interface SealedPremierLeaguePredictionArtifact
  extends SealedPremierLeaguePredictionArtifactCore {
  /** Deterministic replay/output identity for the complete artifact core. */
  readonly replayHash: Sha256Hash;
}

export interface SealedPremierLeaguePredictionResult {
  readonly prediction: DeepReadonly<MatchPrediction>;
  readonly artifact: DeepReadonly<SealedPremierLeaguePredictionArtifact>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function probabilityParameter(value: unknown, label: string): number {
  const normalized = finite(value, label);
  if (normalized < -1 || normalized > 1) {
    throw new Error(`${label} must be between -1 and 1`);
  }
  return normalized;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function normalizedFixture(
  fixture: SealedPremierLeagueFixture
): SealedPremierLeagueFixture {
  if (!fixture || typeof fixture !== "object") {
    throw new Error("fixture is required");
  }
  if (fixture.competition !== "premier-league") {
    throw new Error("sealed predictor only accepts premier-league fixtures");
  }
  if (fixture.venue !== "home") {
    throw new Error("sealed production predictor requires a true home fixture");
  }
  const homeSlug = requireNonEmpty(fixture.homeSlug, "fixture.homeSlug");
  const awaySlug = requireNonEmpty(fixture.awaySlug, "fixture.awaySlug");
  if (homeSlug === awaySlug) throw new Error("homeSlug and awaySlug must differ");
  return {
    competition: "premier-league",
    season: requireNonEmpty(fixture.season, "fixture.season"),
    fixtureId: requireNonEmpty(fixture.fixtureId, "fixture.fixtureId"),
    homeSlug,
    awaySlug,
    homeTeam: requireNonEmpty(fixture.homeTeam, "fixture.homeTeam"),
    awayTeam: requireNonEmpty(fixture.awayTeam, "fixture.awayTeam"),
    venue: "home",
  };
}

function normalizedRatingState(
  ratingState: SealedPremierLeagueRatingState,
  fixture: SealedPremierLeagueFixture,
  requestedModelVersion: string,
  cutoffAt: string
): SealedPremierLeagueRatingState {
  if (!ratingState || typeof ratingState !== "object") {
    throw new Error("ratingState is required");
  }
  assertFrozenRatingStateIntegrity(ratingState);
  const normalized = cloneFrozen(ratingState);
  if (normalized.season !== fixture.season || normalized.state.season !== fixture.season) {
    throw new Error("rating state season does not match fixture season");
  }
  if (normalized.modelVersion !== requestedModelVersion) {
    throw new Error("rating state model version does not match requested modelVersion");
  }
  if (
    !normalized.state.clubSlugs.includes(fixture.homeSlug) ||
    !normalized.state.clubSlugs.includes(fixture.awaySlug)
  ) {
    throw new Error("rating state membership does not contain both fixture clubs");
  }
  if (Date.parse(normalized.asOf) > Date.parse(cutoffAt)) {
    throw new Error("rating state asOf must not be after forecast cutoff");
  }
  if (Date.parse(normalized.availableAt) > Date.parse(cutoffAt)) {
    throw new Error("rating state became available after forecast cutoff");
  }
  return normalized;
}

function normalizedParameters(
  parameterPayload: unknown,
  modelVersion: string
): SealedPremierLeagueModelParameters {
  const parameters = plainRecord(
    parameterPayload,
    "modelBundle.parameterPayload"
  );
  if (parameters.competition !== "premier-league") {
    throw new Error("model parameters must be Premier League scoped");
  }
  if (parameters.modelVersion !== modelVersion) {
    throw new Error("model parameter version does not match requested modelVersion");
  }
  const trainingWindow = plainRecord(
    parameters.trainingWindow,
    "parameters.trainingWindow"
  );
  const normalized: SealedPremierLeagueModelParameters = {
    competition: "premier-league",
    modelVersion,
    homeAdvantage: finite(parameters.homeAdvantage, "parameters.homeAdvantage"),
    dcRho: probabilityParameter(parameters.dcRho, "parameters.dcRho"),
    drawBias: finite(parameters.drawBias, "parameters.drawBias"),
    goalScale: finite(parameters.goalScale, "parameters.goalScale"),
    baseGoals: finite(parameters.baseGoals, "parameters.baseGoals"),
    awayHomeShare: finite(
      parameters.awayHomeShare,
      "parameters.awayHomeShare"
    ),
    kFactor: finite(parameters.kFactor, "parameters.kFactor"),
    fittedAt: requireNonEmpty(parameters.fittedAt, "parameters.fittedAt"),
    trainingWindow: {
      from: requireNonEmpty(
        trainingWindow.from,
        "parameters.trainingWindow.from"
      ),
      to: requireNonEmpty(
        trainingWindow.to,
        "parameters.trainingWindow.to"
      ),
    },
    notes: requireNonEmpty(parameters.notes, "parameters.notes"),
  };

  // `matchProb` and `scorelineGrid` encode these two fitted mapping constants
  // as the current production defaults. Fail closed if a future bundle changes
  // them until the pure math API accepts them explicitly. Silently accepting a
  // different value would make the model bundle claim inputs it did not use.
  if (normalized.baseGoals !== 1.35 || normalized.goalScale !== 350) {
    throw new Error(
      "sealed predictor supports baseGoals=1.35 and goalScale=350 only"
    );
  }
  if (normalized.drawBias !== 1) {
    throw new Error("sealed predictor supports drawBias=1 only");
  }
  return normalized;
}

function normalizedModelBundle(
  bundle: SealedPremierLeagueModelBundle,
  requestedModelVersion: string,
  cutoffAt: string
): {
  bundle: SealedPremierLeagueModelBundle;
  parameters: SealedPremierLeagueModelParameters;
} {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("modelBundle is required");
  }
  assertImmutableModelBundleIntegrity(bundle);
  const normalized = cloneFrozen(bundle);
  const modelVersion = requireNonEmpty(
    requestedModelVersion,
    "modelVersion"
  );
  if (normalized.modelVersion !== modelVersion) {
    throw new Error("model bundle version does not match requested modelVersion");
  }
  const parameters = normalizedParameters(
    normalized.parameterPayload,
    modelVersion
  );
  if (Date.parse(normalized.availableAt) > Date.parse(cutoffAt)) {
    throw new Error("model bundle became available after forecast cutoff");
  }
  if (Date.parse(normalized.trainingCutoff) >= Date.parse(cutoffAt)) {
    throw new Error("model training cutoff must be strictly before forecast cutoff");
  }
  return { bundle: normalized, parameters };
}

function confidenceFrom(topProbability: number): {
  level: MatchPrediction["confidenceLevel"];
  score: number;
} {
  const score = Math.round(topProbability * 100);
  const level =
    score >= 62
      ? "Very High"
      : score >= 50
        ? "High"
        : score >= 40
          ? "Moderate"
          : "Low";
  return { level, score };
}

function upsetFrom(homeWin: number, awayWin: number): MatchPrediction["upsetRisk"] {
  const underdog = Math.min(homeWin, awayWin);
  if (underdog >= 0.3) return "High";
  if (underdog >= 0.2) return "Elevated";
  return "Low";
}

function assertProbabilityVector(home: number, draw: number, away: number): void {
  const values = [home, draw, away];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("sealed prediction probabilities must be finite values in [0, 1]");
  }
  const total = home + draw + away;
  if (Math.abs(total - 1) > 1e-12) {
    throw new Error(`sealed prediction probabilities sum to ${total}, not 1`);
  }
}

/**
 * Predict solely from detached, content-verified inputs.
 *
 * Given the same input, this function returns the same probabilities, complete
 * scoreline grid, artifact, and replayHash. It performs no persistence.
 */
export function predictPremierLeagueFromFrozenInputs(
  input: SealedPremierLeaguePredictionInput
): SealedPremierLeaguePredictionResult {
  if (!input || typeof input !== "object") {
    throw new Error("sealed Premier League prediction input is required");
  }
  if (!SEALED_PREMIER_LEAGUE_STAGES.includes(input.stage)) {
    throw new Error(`unsupported sealed prediction stage: ${String(input.stage)}`);
  }
  const fixture = normalizedFixture(input.fixture);
  const cutoffAt = normalizeTimestamp(input.cutoffAt, "cutoffAt");
  const generatedAt = normalizeTimestamp(input.generatedAt, "generatedAt");
  const kickoffAtAsKnown = normalizeTimestamp(
    input.kickoffAtAsKnown,
    "kickoffAtAsKnown"
  );
  if (Date.parse(cutoffAt) > Date.parse(generatedAt)) {
    throw new Error("cutoffAt must not be after generatedAt");
  }
  if (Date.parse(generatedAt) >= Date.parse(kickoffAtAsKnown)) {
    throw new Error("generatedAt must be strictly before kickoffAtAsKnown");
  }
  const modelVersion = requireNonEmpty(input.modelVersion, "modelVersion");
  const ratingState = normalizedRatingState(
    input.ratingState,
    fixture,
    modelVersion,
    cutoffAt
  );
  const normalizedBundle = normalizedModelBundle(
    input.modelBundle,
    modelVersion,
    cutoffAt
  );
  const { bundle: modelBundle, parameters: params } = normalizedBundle;

  const frozenInput = cloneFrozen({
    fixture,
    stage: input.stage,
    cutoffAt,
    generatedAt,
    kickoffAtAsKnown,
    modelVersion,
    ratingState,
    modelBundle,
  });
  const frozenInputHash = canonicalSha256(frozenInput);
  const eloHome = ratingState.state.ratings[fixture.homeSlug] ?? 1500;
  const eloAway = ratingState.state.ratings[fixture.awaySlug] ?? 1500;
  const goalOptions = {
    rho: params.dcRho,
    awayHomeShare: params.awayHomeShare,
  };

  // These are the exact calls used by the existing production league engine.
  const probabilities = matchProb(
    eloHome,
    eloAway,
    params.homeAdvantage,
    goalOptions
  );
  const grid: SealedPremierLeagueScorelineCell[] = scorelineGrid(
    eloHome,
    eloAway,
    params.homeAdvantage,
    goalOptions
  )
    .slice()
    .sort((left, right) =>
      right.p - left.p || left.a - right.a || left.b - right.b
    )
    .map((cell) => ({ a: cell.a, b: cell.b, p: cell.p }));

  assertProbabilityVector(
    probabilities.winA,
    probabilities.draw,
    probabilities.winB
  );
  if (grid.length !== 81) {
    throw new Error(`sealed scoreline grid must contain 81 cells (observed ${grid.length})`);
  }
  const gridTotal = grid.reduce((sum, cell) => sum + cell.p, 0);
  if (Math.abs(gridTotal - 1) > 1e-12) {
    throw new Error(`sealed scoreline grid sums to ${gridTotal}, not 1`);
  }

  const top = grid[0];
  const topProbability = Math.max(
    probabilities.winA,
    probabilities.draw,
    probabilities.winB
  );
  const confidence = confidenceFrom(topProbability);
  const favouriteName =
    probabilities.winA >= probabilities.winB
      ? fixture.homeTeam
      : fixture.awayTeam;
  const favouriteProbability = Math.max(
    probabilities.winA,
    probabilities.winB
  );
  const factors: ModelFactor[] = [
    {
      label: "Elo strength",
      detail: `${fixture.homeTeam} ${Math.round(eloHome)} vs ${fixture.awayTeam} ${Math.round(eloAway)} (as-of ${cutoffAt}, walk-forward only).`,
      weight: Math.abs(eloHome - eloAway) >= 80 ? "high" : "medium",
    },
    {
      label: "True home advantage",
      detail: `${fixture.homeTeam} receive +${params.homeAdvantage} Elo as the home side. Not a World Cup host-nation bonus.`,
      weight: "medium",
    },
    {
      label: "Goal expectation (Dixon-Coles)",
      detail: `Model projects ${probabilities.expectedGoalsA.toFixed(2)} expected goals for ${fixture.homeTeam} and ${probabilities.expectedGoalsB.toFixed(2)} for ${fixture.awayTeam}. λ is mapped from Elo, not shot-based xG. ρ = ${params.dcRho}.`,
      weight: "medium",
    },
    {
      label: "Model version",
      detail: `${modelVersion} · training window ${params.trainingWindow.from} → ${params.trainingWindow.to} · fitted ${params.fittedAt}.`,
      weight: "low",
    },
    {
      label: "Inputs in use",
      detail:
        "League-strength baseline, home advantage, season-transition priors and Dixon-Coles score model. Not used: market odds, injuries, lineups, transfers, or shot-based xG.",
      weight: "low",
    },
  ];
  const prediction: MatchPrediction = {
    matchId: fixture.fixtureId,
    teamA: fixture.homeSlug,
    teamB: fixture.awaySlug,
    teamAWinProbability: probabilities.winA,
    drawProbability: probabilities.draw,
    teamBWinProbability: probabilities.winB,
    expectedGoalsA: probabilities.expectedGoalsA,
    expectedGoalsB: probabilities.expectedGoalsB,
    expectedScore: `${probabilities.expectedGoalsA.toFixed(1)} – ${probabilities.expectedGoalsB.toFixed(1)}`,
    mostLikelyScoreline: `${top.a}–${top.b}`,
    confidenceLevel: confidence.level,
    confidenceScore: confidence.score,
    upsetRisk: upsetFrom(probabilities.winA, probabilities.winB),
    eloA: eloHome,
    eloB: eloAway,
    eloBreakdown: {
      a: {
        base: eloHome,
        squadStabilityAdjustment: 0,
        verifiedNewsAdjustment: 0,
        adjusted: eloHome,
      },
      b: {
        base: eloAway,
        squadStabilityAdjustment: 0,
        verifiedNewsAdjustment: 0,
        adjusted: eloAway,
      },
    },
    topScorelines: grid.slice(0, 6).map((cell) => ({
      score: `${cell.a}–${cell.b}`,
      prob: cell.p,
    })),
    factors,
    modelSummary:
      favouriteProbability >= 0.45
        ? `${favouriteName} favoured at ${(favouriteProbability * 100).toFixed(0)}% — ${confidence.level.toLowerCase()} model confidence.`
        : `Even Premier League matchup — ${favouriteName} ${(
            favouriteProbability * 100
          ).toFixed(0)}%, draw ${(probabilities.draw * 100).toFixed(0)}%.`,
    fullReport: `${fixture.homeTeam} (home) vs ${fixture.awayTeam}. Closed-form Dixon-Coles 1X2 from walk-forward Elo. Model ${modelVersion}. Probability estimate, not a guaranteed outcome.`,
    modelVersion,
    asOf: cutoffAt,
    competition: "premier-league",
  };

  const artifactCore: SealedPremierLeaguePredictionArtifactCore = {
    schemaVersion: SEALED_PREMIER_LEAGUE_SCHEMA_VERSION,
    frozenInputHash,
    ...frozenInput,
    consumedParameters: params,
    elo: { home: eloHome, away: eloAway },
    probabilities: {
      home: probabilities.winA,
      draw: probabilities.draw,
      away: probabilities.winB,
    },
    expectedGoals: {
      home: probabilities.expectedGoalsA,
      away: probabilities.expectedGoalsB,
    },
    scorelineGrid: grid,
  };
  const artifact: SealedPremierLeaguePredictionArtifact = {
    ...artifactCore,
    replayHash: canonicalSha256(artifactCore),
  };

  return cloneFrozen({ prediction, artifact }) as SealedPremierLeaguePredictionResult;
}
