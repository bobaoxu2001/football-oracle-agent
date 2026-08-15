/** Shared domain types for World Cup AI Lab. */

export type MatchStage =
  | "group"
  | "round-of-32"
  | "round-of-16"
  | "quarter-final"
  | "semi-final"
  | "final";

export type MatchStatus = "scheduled" | "live" | "completed";

export interface GeneratedMatch {
  id: string; // stable, deterministic e.g. "M-A-1"
  stage: MatchStage;
  groupName: string | null;
  matchday: number | null; // 1–3 for group stage
  teamA: string; // team slug
  teamB: string; // team slug
  // Official schedule fields — null until verified FIFA data is seeded into
  // lib/seed/world-cup-2026-schedule.ts. See TODOs there. Never faked.
  matchNumber: number | null; // official FIFA match number (1–104)
  matchDate: string | null; // ISO kickoff datetime (UTC)
  stadium: string | null; // venue name
  city: string | null;
  country: string | null; // host country: USA / Canada / Mexico
  status: MatchStatus;
}

export type ConfidenceLevel = "Low" | "Moderate" | "High" | "Very High";
export type UpsetRisk = "Low" | "Elevated" | "High";

export interface MatchPrediction {
  matchId: string;
  teamA: string;
  teamB: string;
  teamAWinProbability: number;
  drawProbability: number;
  teamBWinProbability: number;
  expectedGoalsA: number;
  expectedGoalsB: number;
  expectedScore: string; // e.g. "1.8 – 1.1"
  mostLikelyScoreline: string; // e.g. "2–1"
  confidenceLevel: ConfidenceLevel;
  confidenceScore: number; // 0–100
  upsetRisk: UpsetRisk;
  eloA: number; // base Elo, team A (unchanged for back-compat)
  eloB: number; // base Elo, team B
  /** Base → squad-stability → verified-news → adjusted Elo, per team. */
  eloBreakdown: { a: EloBreakdown; b: EloBreakdown };
  /** Top scorelines by model probability (premium). */
  topScorelines: { score: string; prob: number }[];
  /** Human-readable model factors (drivers behind the numbers). */
  factors: ModelFactor[];
  /** V5.1 match-type classification (Fade / Trust / Narrow / Coin-flip). */
  matchType?: MatchTypeClassification;
  modelSummary: string; // short free-preview line
  fullReport: string; // full AI-generated explanation (premium)
  /** Engine identity. Required for league snapshots; optional on legacy WC cards. */
  modelVersion?: string;
  /** Date the prediction was computed as-of (YYYY-MM-DD). */
  asOf?: string;
  competition?: "world-cup" | "premier-league";
}

/** V5.1 match archetype, derived from the favourite's edge, kill power and the underdog's resistance. */
export type MatchTypeCode = "A" | "B" | "C" | "D";
export interface MatchTypeClassification {
  code: MatchTypeCode;
  /** e.g. "Trust Favourite". */
  label: string;
  /** One-line why, referencing the signals that drove it. */
  rationale: string;
}

export interface ModelFactor {
  label: string;
  detail: string;
  weight: "high" | "medium" | "low";
}

/** Per-team Elo transparency: base → capped adjustments → adjusted rating. */
export interface EloBreakdown {
  base: number;
  /** K=60 Elo delta accumulated from completed tournament results. */
  completedResultsAdjustment?: number;
  squadStabilityAdjustment: number; // capped Squad Stability Signal
  verifiedNewsAdjustment: number; // capped verified-news signal (±25 max)
  /** Capped, shrunk confederation tournament-form signal (±20 max). */
  tournamentFormAdjustment?: number;
  /** Per-fixture tactical style-clash nudge (±30 max); opponent-dependent. */
  tacticalMatchupAdjustment?: number;
  /** Per-fixture confirmed pre-match intelligence (±35 max); opponent-dependent. */
  intelligenceAdjustment?: number;
  /** Round-2 bounce-back: motivation/reversion for a stumbled quality side vs a weaker foe (0–25). */
  bounceBackAdjustment?: number;
  /** Final-round rotation risk: capped negative nudge when a team's place is settled (−45…0). */
  matchStakesAdjustment?: number;
  adjusted: number; // base + adjustments (what the goal model uses)
}

export interface PricingTier {
  id: TierId;
  name: string;
  priceCents: number;
  tagline: string;
  features: string[];
  matchCredits: number; // unlock credits granted
  fullAccess: boolean;
  highlight?: boolean;
}

export type TierId = "single" | "pack5" | "full";

export interface ChampionOdds {
  slug: string;
  name: string;
  flag: string;
  elo: number;
  champion: number;
  final: number;
  semiFinal: number;
  quarterFinal: number;
  roundOf16: number;
  roundOf32: number;
}

export interface GroupSimRow {
  slug: string;
  name: string;
  flag: string;
  elo: number;
  winGroup: number; // P(finish 1st)
  advance: number; // P(top 2)
  expectedPoints: number;
}

export type InsightKind = "favorite" | "coinflip" | "upset";

export interface MatchInsight {
  matchId: string;
  kind: InsightKind;
  headline: string;
  groupName: string | null;
  teamA: string;
  teamB: string;
  flagA: string;
  flagB: string;
  nameA: string;
  nameB: string;
  favProb: number; // strongest single-outcome probability
  drawProb: number;
  underdogProb: number;
  confidenceLevel: ConfidenceLevel;
  upsetRisk: UpsetRisk;
}

export interface MatchInsights {
  topFavorites: MatchInsight[];
  coinFlips: MatchInsight[];
  upsetWatch: MatchInsight[];
}

export interface BracketTeamRef {
  slug: string;
  name: string;
  flag: string;
}

export interface BracketTie {
  id: string;
  stage: MatchStage;
  teamA: BracketTeamRef | null;
  teamB: BracketTeamRef | null;
  winner: string | null; // slug
  winnerProb: number; // model probability the winner advances
}

export interface BracketRound {
  stage: MatchStage;
  label: string;
  ties: BracketTie[];
}

export interface ProjectedBracket {
  rounds: BracketRound[];
  champion: BracketTeamRef | null;
}

export interface HeadToHead {
  teamA: string;
  teamB: string;
  neutral: MatchPrediction;
  /** Same fixture but with each side hosting (for context). */
  aHome: { winA: number; draw: number; winB: number };
  bHome: { winA: number; draw: number; winB: number };
}
