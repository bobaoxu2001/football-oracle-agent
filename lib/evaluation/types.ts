export interface HistoricalMatch {
  id?: string;
  date: string;
  season?: string;
  homeSlug: string;
  awaySlug: string;
  homeGoals: number;
  awayGoals: number;
  competition?: string;
  neutral?: boolean;
}

export interface BacktestPrediction {
  winHome: number;
  draw: number;
  winAway: number;
  expectedGoalsHome: number;
  expectedGoalsAway: number;
  mostLikelyScore: { home: number; away: number };
}

export type Outcome = "home" | "draw" | "away";

export interface BacktestResult {
  match: HistoricalMatch;
  prediction: BacktestPrediction;
  asOf: string;
  dataCutoff: string;
  modelVersion: string;
  actual: Outcome;
  predicted: Outcome;
  correct1x2: boolean;
  exactScore: boolean;
  top3Score: boolean;
  probAssignedToActual: number;
}

export interface CalibrationBin {
  bucket: string;
  predictedMean: number;
  empiricalRate: number;
  count: number;
}

export interface BacktestMetrics {
  matches: number;
  accuracy1x2: number;
  logLoss: number;
  brierScore: number;
  rps: number;
  /** Pooled classwise reliability MAE (5 equal-width bins, 3 classes). Not ECE. */
  pooledReliabilityMae: number;
  /** Standard confidence ECE: binned by max probability, hit = top-pick correct. */
  confidenceEce: number;
  /** Alias of pooledReliabilityMae for older callers. */
  calibrationError: number;
  calibrationTable: CalibrationBin[];
  confidenceEceTable: CalibrationBin[];
  exactScoreAccuracy: number;
  top3ScoreAccuracy: number;
  avgDrawPred: number;
  actualDrawRate: number;
}

export interface BacktestOptions {
  burnIn?: number;
  kFactor?: number;
  homeAdvantage?: number;
  rho?: number;
  awayHomeShare?: number;
  seedRatings?: Record<string, number>;
  mode?: "rolling" | "frozen";
  freezeAfter?: string;
  label?: string;
  modelVersion?: string;
  /** When set, only matches with date >= this ISO date are scored. */
  evaluateFrom?: string;
  /** When set, only matches with date <= this ISO date are scored. */
  evaluateTo?: string;
  /** Optional Championship/feeder ratings keyed by club slug (as-of season start). */
  feederRatingsBySeason?: Record<string, Record<string, number>>;
  /**
   * When true, walk Championship results as feeder priors for newly promoted
   * clubs. Default false so the Phase 1 held-out benchmark stays frozen.
   */
  useChampionshipFeeder?: boolean;
}

export interface BacktestRun {
  label: string;
  options: BacktestOptions;
  results: BacktestResult[];
  metrics: BacktestMetrics;
  trainingWindow?: { from: string; to: string };
  heldOut?: { from: string; to: string };
}
