import type { CompetitionId, VenueSide } from "@/lib/competitions/types";

/** A club as a durable organisation — not a season-specific squad. */
export interface Club {
  slug: string;
  name: string;
  shortName: string;
  /** Official football-data.co.uk / API names. */
  officialNames: string[];
  aliases: string[];
  /** Optional 3-letter code (ARS, LIV, …). */
  code?: string;
}

/** A club's participation in one competition season. */
export interface ClubSeason {
  clubSlug: string;
  competition: CompetitionId;
  season: string; // "2025-26"
  division: "premier-league" | "championship" | "other";
  /** How the club entered this season. */
  entry: "stayed" | "promoted" | "relegated-in" | "unknown";
}

export interface CompetitionSeason {
  competition: CompetitionId;
  season: string;
  clubSlugs: string[];
}

export interface Fixture {
  id: string;
  competition: CompetitionId;
  season: string;
  date: string; // YYYY-MM-DD
  kickoff?: string | null; // ISO if known
  homeSlug: string;
  awaySlug: string;
  homeGoals: number | null;
  awayGoals: number | null;
  status: "scheduled" | "completed" | "postponed";
  venue: VenueSide;
  matchday?: number | null;
  sourceId?: string;
}

export interface TeamIdentity {
  slug: string;
  name: string;
  kind: "club" | "nation";
  flagOrCrest?: string;
}
