import type { PredictionStage } from "@/lib/snapshots/types";
import type {
  MatchAvailabilityContext,
  MatchLineupContext,
  OverallLineupStatus,
} from "@/lib/competitions/premier-league/context";

export type ContextSnapshotStatus = "RECORDED" | "NOT_RECORDED" | "MISSING";

export interface ContextEvidenceView {
  evidenceId: string;
  kind: string;
  entityId: string;
  teamSlug: string | null;
  observedAt: string;
  fetchedAt: string;
  availableAt: string;
  confidence: number;
  rawEvidenceHash: string;
  source: { name: string; recordId: string; url: string | null };
  usedInForecast: boolean;
  lineupStatus: string | null;
  availabilityStatus: string | null;
}

export interface MatchContextView {
  status: ContextSnapshotStatus;
  contextId: string | null;
  schemaVersion: string | null;
  cutoffAt: string | null;
  generatedAt: string | null;
  forecastSnapshotKey: string | null;
  lineup: MatchLineupContext | null;
  availability: MatchAvailabilityContext | null;
  evidence: ContextEvidenceView[];
  evidenceCounts: {
    total: number;
    usedInForecast: number;
    informationalOnly: number;
  };
  latestEvidenceAt: string | null;
  note: string;
}

export interface ContextChangeSummary {
  type:
    | "EVIDENCE_ADDED"
    | "EVIDENCE_REMOVED"
    | "FORECAST_USAGE_CHANGED"
    | "LINEUP_CHANGED"
    | "AVAILABILITY_CHANGED"
    | "KICKOFF_CHANGED";
  teamSlug: string | null;
  entityId: string | null;
  evidenceId: string | null;
  before: unknown;
  after: unknown;
  availableAt: string | null;
  usedInForecast: boolean | null;
}

export interface MatchContextComparison {
  status: "COMPARED" | "NOT_RECORDED" | "MISSING";
  fromContextId: string | null;
  toContextId: string | null;
  changes: ContextChangeSummary[];
  causalAttribution: "not-established";
  causalNote: string;
}

export interface ProbabilityPair {
  over: number;
  under: number;
}

export interface TeamTotalMarkets {
  over05: number;
  under05: number;
  over15: number;
  under15: number;
  over25: number;
  under25: number;
}

export interface ExactScoreProbability {
  homeGoals: number;
  awayGoals: number;
  probability: number;
}

export interface ForecastProvenance {
  modelVersion: string;
  modelRole: "production";
  generatedAt: string;
  cutoffAt: string;
  competition: "premier-league";
  season: string;
  predictionStage: PredictionStage;
  evaluationClass: "LIVE_OOS";
  trainingWindow: { from: string; to: string } | null;
  inputsUsed: string[];
  inputSnapshots: Record<string, unknown>;
  dataFreshness: {
    fixtureRetrievedAt: string | null;
    ratingStateAsOf: string;
    latestInputAt: string;
  };
  immutableForecastId: string;
  scoreDistributionArtifact:
    | "frozen-full-matrix"
    | "reconstructed-from-frozen-lambdas-and-rho";
  reconstructionNote: string | null;
  contextSnapshotId: string | null;
  contextSnapshotSchemaVersion: string | null;
  contextSnapshotCutoffAt: string | null;
  contextSnapshotGeneratedAt: string | null;
  contextTemporalRule: string | null;
  lineupStatus: OverallLineupStatus | "NOT_RECORDED";
  lineupAvailableAt: string | null;
  contextEvidenceCounts: {
    total: number;
    usedInForecast: number;
    informationalOnly: number;
  };
  contextUsedInForecastEvidenceIds: string[];
}

export interface MatchForecast {
  matchId: string;
  competition: "premier-league";
  season: string;
  home: { slug: string; name: string };
  away: { slug: string; name: string };
  kickoffUtc: string;
  generatedAt: string;
  cutoffAt: string;
  modelVersion: string;
  modelRole: "production";
  expectedGoals: {
    home: number;
    away: number;
    total: number;
  };
  result: {
    homeWin: number;
    draw: number;
    awayWin: number;
  };
  totals: {
    over05: number;
    under05: number;
    over15: number;
    under15: number;
    over25: number;
    under25: number;
    over35: number;
    under35: number;
    over45: number;
    under45: number;
  };
  btts: { yes: number; no: number };
  doubleChance: {
    homeOrDraw: number;
    homeOrAway: number;
    drawOrAway: number;
  };
  drawNoBet: { home: number; away: number };
  teamTotals: {
    home: TeamTotalMarkets;
    away: TeamTotalMarkets;
  };
  exactScores: ExactScoreProbability[];
  topScores: ExactScoreProbability[];
  scoreMatrix: number[][];
  uncertainty: {
    normalizedEntropy: number;
    topTwoSeparation: number;
    separationLabel: "low" | "moderate" | "high";
  };
  provenance: ForecastProvenance;
}

export interface ForecastTimelinePoint {
  forecastId: string;
  cutoffAt: string;
  generatedAt: string;
  kickoffAtFreeze: string | null;
  validForCurrentKickoff: boolean;
  predictionStage: PredictionStage;
  modelVersion: string;
  result: MatchForecast["result"];
  over25: number;
  bttsYes: number;
  expectedGoalsTotal: number;
  contextSnapshotId: string | null;
}

export interface ForecastComparison {
  oldForecastId: string;
  newForecastId: string;
  fromCutoff: string;
  toCutoff: string;
  probabilityChanges: {
    homeWin: number;
    draw: number;
    awayWin: number;
    over25: number;
    bttsYes: number;
  };
  expectedGoalsChanges: {
    home: number;
    away: number;
    total: number;
  };
  inputChanges: Array<{ key: string; before: unknown; after: unknown }>;
  contextChanges: ContextChangeSummary[];
  contextComparisonStatus: MatchContextComparison["status"];
  fromContextId: string | null;
  toContextId: string | null;
  modelVersionChanged: boolean;
  cutoffChanged: boolean;
  causalAttribution: "not-established";
  causalNote: string;
}

export interface MatchIntelligence {
  match: {
    id: string;
    competition: "premier-league";
    season: string;
    home: { slug: string; name: string };
    away: { slug: string; name: string };
    kickoffUtc: string;
    status: string;
  };
  forecast: MatchForecast;
  freshness: ForecastFreshness;
  timeline: ForecastTimelinePoint[];
  comparison: ForecastComparison | null;
  contextComparison: MatchContextComparison | null;
  context: {
    atForecast: MatchContextView;
    latest: MatchContextView;
    news: Array<{
      team: string;
      title: string;
      summary: string;
      category: string;
      sourceName: string;
      sourceUrl: string;
      availableAt: string;
      usedInForecast: false;
    }>;
    availability: {
      supported: false;
      items: [];
      note: string;
    };
    tactics: {
      supported: false;
      items: [];
      note: string;
    };
    temporalRule: "availableAt <= cutoffAt";
  };
  audit: ForecastProvenance;
}

export interface ForecastFreshness {
  status: "fresh" | "stale";
  ageHours: number;
  note: string;
}

export interface UpcomingMatchForecast {
  match: MatchIntelligence["match"];
  forecast: MatchForecast;
  freshness: ForecastFreshness;
}
