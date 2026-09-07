import type { ResearchForecastCompetitionId } from "./research-params";

export type ResearchEvidenceLevel = "PRIOR_ONLY" | "THIN" | "SEASON_STARTED";

export interface ResearchTeamRef {
  slug: string;
  name: string;
  shortName: string | null;
  elo: number;
  matchesPlayed: number;
}

export interface ResearchMatchForecast {
  support: "research";
  production: false;
  includedInProduction: false;
  modelVersion: "big-five-research-v0.1.0";
  notProductionModelVersion: string;
  modelRole: "research";
  paramsOrigin: "labeled-domestic-prior";
  canonicalMatchId: string;
  competition: ResearchForecastCompetitionId;
  competitionName: string;
  season: string;
  matchday: number | null;
  kickoffUtc: string;
  asOf: string;
  computedAt: string;
  home: ResearchTeamRef;
  away: ResearchTeamRef;
  probabilities: {
    home: number;
    draw: number;
    away: number;
  };
  expectedGoals: {
    home: number;
    away: number;
  };
  mostLikelyScoreline: string;
  topScorelines: { score: string; probability: number }[];
  evidence: {
    completedMatchesUsed: number;
    evidenceLevel: ResearchEvidenceLevel;
    lastAppliedMatchId: string | null;
    lastAppliedKickoffUtc: string | null;
  };
  disclaimer: string;
}

export interface ResearchForecastBoard {
  support: "research";
  production: false;
  includedInProduction: false;
  modelVersion: "big-five-research-v0.1.0";
  notProductionModelVersion: string;
  paramsOrigin: "labeled-domestic-prior";
  competition: ResearchForecastCompetitionId;
  competitionName: string;
  season: string;
  asOf: string;
  computedAt: string;
  ledgerLastIngestAt: string | null;
  completedMatchesInLedger: number;
  evidenceLevel: ResearchEvidenceLevel;
  upcomingCount: number;
  matches: ResearchMatchForecast[];
  disclaimer: string;
}

export function evidenceLevelFromCount(completedMatchesUsed: number): ResearchEvidenceLevel {
  if (completedMatchesUsed <= 0) return "PRIOR_ONLY";
  if (completedMatchesUsed < 20) return "THIN";
  return "SEASON_STARTED";
}
