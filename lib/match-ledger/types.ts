/**
 * Canonical Big Five match ledger — types.
 *
 * Layering (never collapse these):
 *
 *   RAW PROVIDER OBSERVATION   MatchObservation — append-only, keeps `raw`
 *          ↓
 *   CANONICAL MATCH DATA       CanonicalMatch — materialized fold of observations
 *          ↓
 *   TEMPORAL FEATURE STORE     lib/match-ledger/features — asOf-filtered
 *          ↓
 *   MODEL / PREDICTION         unchanged; consumes features, never raw payloads
 *
 * NULL DISCIPLINE. `null` means "this source did not supply the value", and is
 * never interchangeable with 0. A goalless match has `fullTimeHomeGoals: 0`;
 * a match whose provider exposes no shot data has `shots: null`. Aggregations
 * must skip nulls rather than coerce them.
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";

/** Ledger schema version. Bump when the canonical shape changes meaning. */
export const MATCH_LEDGER_SCHEMA_VERSION = "match-ledger-v1";

/**
 * Lifecycle status of a match in the ledger.
 * Only FINISHED matches are eligible as historical evidence.
 */
export const LEDGER_MATCH_STATUSES = [
  "SCHEDULED",
  "LIVE",
  "FINISHED",
  "POSTPONED",
  "SUSPENDED",
  "ABANDONED",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type LedgerMatchStatus = (typeof LEDGER_MATCH_STATUSES)[number];

export type MatchOutcome = "HOME" | "DRAW" | "AWAY";

/** A team as identified inside the ledger. */
export interface LedgerTeam {
  /** Stable slug. For the Premier League this is the existing club slug. */
  slug: string;
  /** Provider's numeric/string team id — the strongest identity anchor. */
  providerTeamId: string | null;
  /** Provider's canonical display name at observation time. */
  name: string;
  shortName: string | null;
  tla: string | null;
}

/**
 * Per-team match statistics. EVERY field is nullable on purpose — see the
 * NULL DISCIPLINE note above. `statsSource` on the section records which
 * provider produced them, because definitions differ between providers
 * (xG in particular is not comparable across vendors).
 */
export interface TeamMatchStatistics {
  possessionPct: number | null;
  totalShots: number | null;
  shotsOnTarget: number | null;
  shotsOffTarget: number | null;
  blockedShots: number | null;
  shotsInsideBox: number | null;
  shotsOutsideBox: number | null;
  expectedGoals: number | null;
  corners: number | null;
  offsides: number | null;
  fouls: number | null;
  yellowCards: number | null;
  redCards: number | null;
  goalkeeperSaves: number | null;
}

export function emptyTeamStatistics(): TeamMatchStatistics {
  return {
    possessionPct: null,
    totalShots: null,
    shotsOnTarget: null,
    shotsOffTarget: null,
    blockedShots: null,
    shotsInsideBox: null,
    shotsOutsideBox: null,
    expectedGoals: null,
    corners: null,
    offsides: null,
    fouls: null,
    yellowCards: null,
    redCards: null,
    goalkeeperSaves: null,
  };
}

/** True when a statistics block carries no value at all. */
export function statisticsAreEmpty(s: TeamMatchStatistics): boolean {
  return Object.values(s).every((v) => v === null);
}

export interface LineupPlayer {
  playerId: string | null;
  name: string;
  shirtNumber: number | null;
  position: string | null;
  /** Minutes played, when the provider reports them. */
  minutesPlayed: number | null;
}

export interface SubstitutionEvent {
  teamSlug: string;
  minute: number | null;
  playerOff: string | null;
  playerOn: string | null;
}

export interface GoalEvent {
  teamSlug: string;
  minute: number | null;
  scorer: string | null;
  assist: string | null;
  /** e.g. "REGULAR" | "PENALTY" | "OWN". Provider vocabulary, kept verbatim. */
  type: string | null;
}

export interface CardEvent {
  teamSlug: string;
  minute: number | null;
  player: string | null;
  card: "YELLOW" | "RED" | "SECOND_YELLOW" | null;
}

/** Injuries only when they appear in STRUCTURED match data — never inferred from prose. */
export interface InjuryEvent {
  teamSlug: string;
  player: string | null;
  minute: number | null;
  detail: string | null;
}

export interface TeamLineup {
  formation: string | null;
  startingXI: LineupPlayer[] | null;
  bench: LineupPlayer[] | null;
}

export interface MatchEvents {
  homeLineup: TeamLineup | null;
  awayLineup: TeamLineup | null;
  substitutions: SubstitutionEvent[] | null;
  goals: GoalEvent[] | null;
  cards: CardEvent[] | null;
  injuries: InjuryEvent[] | null;
}

export function emptyMatchEvents(): MatchEvents {
  return {
    homeLineup: null,
    awayLineup: null,
    substitutions: null,
    goals: null,
    cards: null,
    injuries: null,
  };
}

/**
 * Where a section of the record came from and when it was known.
 *
 * Provenance is recorded per SECTION (result / statistics / events) rather than
 * per scalar: one provider payload observed at one instant supplies a whole
 * section, so section-level provenance answers "where did this come from and
 * when was it known?" exactly, without a parallel map the size of the record.
 * The append-only observation log keeps the byte-level detail underneath.
 */
export interface SectionProvenance {
  source: string;
  providerMatchId: string | null;
  /** When OUR system observed the value. Always set. */
  observedAt: string;
  /** Provider's own last-modified stamp, when it publishes one. */
  providerUpdatedAt: string | null;
}

/**
 * One append-only observation of a match from one provider at one instant.
 * Observations are never edited; corrections arrive as later observations.
 */
export interface MatchObservation {
  observationId: string;
  schemaVersion: string;
  competition: BigFiveCompetitionId;
  season: string;
  /** Canonical, provider-independent fixture identity. */
  canonicalMatchId: string;
  providerMatchId: string | null;
  source: string;
  observedAt: string;
  providerUpdatedAt: string | null;

  matchday: number | null;
  stage: string | null;
  kickoffUtc: string | null;
  home: LedgerTeam;
  away: LedgerTeam;

  status: LedgerMatchStatus;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  fullTimeHomeGoals: number | null;
  fullTimeAwayGoals: number | null;
  outcome: MatchOutcome | null;

  homeStatistics: TeamMatchStatistics | null;
  awayStatistics: TeamMatchStatistics | null;
  events: MatchEvents | null;

  /** Unmodified provider payload. The audit trail of record. */
  raw: unknown;
}

/**
 * The materialized canonical record. Derived from observations — never the
 * primary write target, so history is not silently mutated.
 */
export interface CanonicalMatch {
  schemaVersion: string;
  canonicalMatchId: string;
  competition: BigFiveCompetitionId;
  season: string;
  matchday: number | null;
  stage: string | null;
  kickoffUtc: string | null;
  home: LedgerTeam;
  away: LedgerTeam;

  status: LedgerMatchStatus;
  halfTimeHomeGoals: number | null;
  halfTimeAwayGoals: number | null;
  fullTimeHomeGoals: number | null;
  fullTimeAwayGoals: number | null;
  outcome: MatchOutcome | null;

  /**
   * When the FINAL result first became known to us. This — not kickoff — is the
   * instant a completed match becomes admissible evidence for later fixtures.
   */
  resultObservedAt: string | null;

  homeStatistics: TeamMatchStatistics | null;
  awayStatistics: TeamMatchStatistics | null;
  events: MatchEvents | null;

  provenance: {
    result: SectionProvenance | null;
    statistics: SectionProvenance | null;
    events: SectionProvenance | null;
  };

  /** Every observation id folded into this record, oldest first. */
  observationIds: string[];
  observationCount: number;
  /** Distinct sources that contributed. */
  sources: string[];
  /** Set when a later observation changed an already-final score. */
  corrections: MatchCorrection[];
  firstObservedAt: string;
  lastObservedAt: string;
}

/** A provider correction to an already-final score. Detectable, never silent. */
export interface MatchCorrection {
  correctionId: string;
  detectedAt: string;
  source: string;
  previous: { home: number | null; away: number | null };
  corrected: { home: number | null; away: number | null };
  previousObservedAt: string;
}

/**
 * What a given source can actually supply. Published so the UI and the report
 * can distinguish "zero" from "this provider does not expose the field".
 */
export interface SourceCapability {
  source: string;
  tier: string;
  /** Fields the source supplies for a completed match. */
  provides: string[];
  /** Requested fields the source does NOT supply. Documented, not faked. */
  missing: string[];
  notes: string;
}

/** A completed match: the only kind admissible as historical evidence. */
export function isCompletedMatch(m: CanonicalMatch): boolean {
  return (
    m.status === "FINISHED" &&
    m.fullTimeHomeGoals !== null &&
    m.fullTimeAwayGoals !== null &&
    m.resultObservedAt !== null
  );
}

export function outcomeFromGoals(home: number, away: number): MatchOutcome {
  return home > away ? "HOME" : home < away ? "AWAY" : "DRAW";
}
