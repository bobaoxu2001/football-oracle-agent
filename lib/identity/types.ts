import type { CompetitionId, VenueSide } from "@/lib/competitions/types";

/** A club as a durable organisation — not a season-specific squad. */
export interface Club {
  /** Stable identity. Same as slug; never a display-name string. */
  clubId?: string;
  slug: string;
  name: string;
  shortName: string;
  /** Official football-data.co.uk / API names. */
  officialNames: string[];
  aliases: string[];
  /** Optional 3-letter code (ARS, LIV, …). */
  code?: string;
}

export type ClubSeasonEntry = "stayed" | "promoted" | "relegated-in" | "unknown";
export type PromotionStatus = "continuing" | "promoted" | "relegated";

/** A club's participation in one competition season. */
export interface ClubSeason {
  clubId?: string;
  clubSlug: string;
  canonicalName?: string;
  shortName?: string;
  competition: CompetitionId;
  season: string; // "2025-26"
  division: "premier-league" | "championship" | "other";
  /** How the club entered this season. */
  entry: ClubSeasonEntry;
  previousCompetition?: string;
  previousSeason?: string;
  promotionStatus?: PromotionStatus;
  aliases?: string[];
}

export type VerificationStatus = "VERIFIED" | "SOURCE_CONFLICT" | "PROVISIONAL" | "STALE";
export type SeasonStatus = "upcoming" | "in_progress" | "completed";
export type ScheduleCompleteness = "complete" | "partial";

/**
 * Kickoff-time certainty. Independent of whether a timestamp exists.
 *
 * CONFIRMED — exact kickoff externally/officially confirmed (non-default slot).
 * PROVISIONAL — a schedule exists but broadcast/rescheduling may move kickoff.
 * DEFAULT — official fixture release supplied a conventional 15:00/20:00 slot.
 * TBD — exact time unavailable.
 */
export type KickoffCertainty = "CONFIRMED" | "PROVISIONAL" | "DEFAULT" | "TBD";

export interface CompetitionSeason {
  competition: CompetitionId;
  season: string;
  startDate: string;
  endDate: string;
  status: SeasonStatus;
  clubIds: string[];
  /** @deprecated use clubIds — kept so older callers still compile */
  clubSlugs?: string[];
  expectedClubCount: number;
  fixtureCount: number;
  source: string;
  retrievedAt: string;
  verifiedAt: string;
  dataVersion: string;
  verificationStatus: VerificationStatus;
  /** Independent sources the membership/fixtures were checked against. */
  verifiedAgainst?: string[];
  /** Document or artifact that records the independent check. */
  verificationArtifact?: string;
  scheduleCompleteness: ScheduleCompleteness;
  continuingClubIds: string[];
  promotedClubIds: string[];
  relegatedClubIds: string[];
}

export type FixtureStatus =
  | "SCHEDULED"
  | "LIVE"
  | "FINISHED"
  | "POSTPONED"
  | "CANCELLED"
  | "SUSPENDED"
  | "scheduled"
  | "completed"
  | "postponed";

export interface Fixture {
  id: string;
  competition: CompetitionId;
  season: string;
  date: string; // YYYY-MM-DD scheduled match date in source timezone
  /** Explicit scheduled calendar date. Same as date; kept so date ≠ confirmed kickoff. */
  scheduledDate?: string;
  kickoff?: string | null; // ISO UTC if known
  kickoffUtc?: string | null;
  kickoffLocal?: string | null;
  timezone?: string | null;
  kickoffCertainty?: KickoffCertainty;
  homeSlug: string;
  awaySlug: string;
  homeClubId?: string;
  awayClubId?: string;
  homeGoals: number | null;
  awayGoals: number | null;
  status: FixtureStatus;
  venue: VenueSide;
  venueName?: string | null;
  matchday?: number | null;
  source?: string;
  sourceId?: string;
  sourceFixtureId?: string;
  retrievedAt?: string;
  sourceUpdatedAt?: string | null;
  verificationStatus?: VerificationStatus;
  resultSource?: string;
  finishedAt?: string | null;
  statusUpdatedAt?: string | null;
}

export interface TeamIdentity {
  slug: string;
  name: string;
  kind: "club" | "nation";
  flagOrCrest?: string;
}
