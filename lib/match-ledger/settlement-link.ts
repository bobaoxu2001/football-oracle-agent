/**
 * Ledger → settlement bridge.
 *
 * Reuses the existing Phase 2A settlement pipeline (settleFixture) rather than
 * adding a second one. A completed ledger match is projected into the Fixture
 * shape that pipeline already understands, and settlement links it to whatever
 * frozen pre-match snapshots exist for that fixture id.
 *
 * WHY THIS IS SAFE TO RUN ALONGSIDE THE EXISTING RESULT FEED
 * Both paths converge on persistSettlement, which is first-write-wins keyed by
 * snapshotUniqueKey. Settling the same snapshot twice returns the original row
 * unchanged; it never rewrites a settled result and never double-counts.
 *
 * WHY THIS CANNOT CHANGE A PREDICTION
 * Settlement writes a SettlementRecord — a separate append-only artifact that
 * references a snapshot by its immutable unique key. It has no write path back
 * into the snapshot store. The probabilities being scored are the frozen ones.
 */

import type { Fixture } from "@/lib/identity/types";
import { canSettle, settleFixture, type SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import type { CanonicalMatch } from "./types";
import { isCompletedMatch } from "./types";

/**
 * Project a completed ledger match into the Fixture shape settlement expects.
 * Returns null when the match is not settleable.
 */
export function fixtureFromCanonicalMatch(match: CanonicalMatch): Fixture | null {
  if (!isCompletedMatch(match)) return null;
  return {
    id: match.canonicalMatchId,
    competition: match.competition,
    season: match.season,
    date: (match.kickoffUtc ?? match.resultObservedAt ?? "").slice(0, 10),
    kickoff: match.kickoffUtc,
    kickoffUtc: match.kickoffUtc,
    homeSlug: match.home.slug,
    awaySlug: match.away.slug,
    homeGoals: match.fullTimeHomeGoals,
    awayGoals: match.fullTimeAwayGoals,
    status: "FINISHED",
    venue: "home",
    matchday: match.matchday,
    source: match.provenance.result?.source ?? "match-ledger",
    sourceFixtureId: match.provenance.result?.providerMatchId ?? undefined,
    resultSource: match.sources.join("+"),
    finishedAt: match.resultObservedAt,
  };
}

export interface LedgerSettlementReport {
  competition: BigFiveCompetitionId;
  completedMatches: number;
  matchesAttempted: number;
  settlementsWritten: number;
  /** Matches with no frozen pre-match snapshot — expected for ledger-only leagues. */
  matchesWithoutSnapshots: number;
  errors: string[];
}

/**
 * Settle every completed ledger match for a competition.
 *
 * A match with no frozen snapshot is NOT an error: the four leagues added in
 * this phase are ledger-only and have no production model, so they legitimately
 * have nothing to settle. That count is reported rather than hidden.
 */
export function settleCompletedMatches(input: {
  competition: BigFiveCompetitionId;
  matches: CanonicalMatch[];
  settledAt?: string;
}): LedgerSettlementReport {
  const settledAt = input.settledAt ?? new Date().toISOString();
  const completed = input.matches.filter(
    (m) => m.competition === input.competition && isCompletedMatch(m)
  );
  const report: LedgerSettlementReport = {
    competition: input.competition,
    completedMatches: completed.length,
    matchesAttempted: 0,
    settlementsWritten: 0,
    matchesWithoutSnapshots: 0,
    errors: [],
  };

  for (const match of completed) {
    const fixture = fixtureFromCanonicalMatch(match);
    if (!fixture || !canSettle(fixture)) continue;
    report.matchesAttempted += 1;
    try {
      const rows: SettlementRecord[] = settleFixture(fixture, settledAt, {
        evaluationClass: "LIVE_OOS",
        verificationId: `ledger::${match.canonicalMatchId}::${match.resultObservedAt ?? settledAt}`,
      });
      if (!rows.length) report.matchesWithoutSnapshots += 1;
      report.settlementsWritten += rows.length;
    } catch (err) {
      report.errors.push(`${match.canonicalMatchId}: ${(err as Error).message}`);
    }
  }
  return report;
}
