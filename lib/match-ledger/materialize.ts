/**
 * Fold append-only observations into a canonical match record.
 *
 * Pure and deterministic: same observation set → same CanonicalMatch, in any
 * input order and regardless of how many times an observation is replayed.
 * That is what makes repeated ops ticks safe.
 *
 * KEY SEMANTICS
 *
 *   resultObservedAt — the instant we FIRST learned a final score. It is the
 *     admissibility timestamp for temporal features, so it must not drift when
 *     a provider later re-states the same result. A genuine score CORRECTION is
 *     recorded in `corrections` instead of silently rewriting history.
 *
 *   statistics / events — last non-empty section wins. A provider that starts
 *     supplying shot data mid-season enriches the record; a provider that stops
 *     supplying it must not erase what we already stored.
 */

import type {
  CanonicalMatch,
  MatchCorrection,
  MatchObservation,
  SectionProvenance,
  TeamMatchStatistics,
} from "./types";
import { MATCH_LEDGER_SCHEMA_VERSION, statisticsAreEmpty } from "./types";

/** Deterministic order: by observation time, then by id to break ties. */
export function sortObservations(rows: MatchObservation[]): MatchObservation[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        a.observedAt.localeCompare(b.observedAt) ||
        a.observationId.localeCompare(b.observationId)
    );
}

/** Drop replayed observations. Identity is observationId. */
export function dedupeObservations(rows: MatchObservation[]): MatchObservation[] {
  const byId = new Map<string, MatchObservation>();
  for (const row of rows) {
    if (!byId.has(row.observationId)) byId.set(row.observationId, row);
  }
  return [...byId.values()];
}

function provenanceOf(obs: MatchObservation): SectionProvenance {
  return {
    source: obs.source,
    providerMatchId: obs.providerMatchId,
    observedAt: obs.observedAt,
    providerUpdatedAt: obs.providerUpdatedAt,
  };
}

function hasFinalScore(obs: MatchObservation): boolean {
  return (
    obs.status === "FINISHED" &&
    obs.fullTimeHomeGoals !== null &&
    obs.fullTimeAwayGoals !== null
  );
}

function nonEmptyStats(s: TeamMatchStatistics | null): boolean {
  return s !== null && !statisticsAreEmpty(s);
}

function eventsCarryAnything(obs: MatchObservation): boolean {
  const e = obs.events;
  if (!e) return false;
  return Boolean(
    e.homeLineup ||
      e.awayLineup ||
      (e.substitutions && e.substitutions.length) ||
      (e.goals && e.goals.length) ||
      (e.cards && e.cards.length) ||
      (e.injuries && e.injuries.length)
  );
}

/**
 * Materialize one match. All observations must share a canonicalMatchId.
 * Returns null for an empty set.
 */
export function materializeMatch(input: MatchObservation[]): CanonicalMatch | null {
  const rows = sortObservations(dedupeObservations(input));
  if (!rows.length) return null;

  const first = rows[0];
  const last = rows[rows.length - 1];
  const canonicalMatchId = first.canonicalMatchId;
  if (rows.some((r) => r.canonicalMatchId !== canonicalMatchId)) {
    throw new Error(
      `materializeMatch received mixed match ids (${canonicalMatchId} vs others)`
    );
  }

  // ── Result: latest observation wins, but the FIRST final score fixes the
  //    admissibility instant and any later disagreement is a correction.
  let resultObs: MatchObservation | null = null;
  let resultObservedAt: string | null = null;
  let finalHome: number | null = null;
  let finalAway: number | null = null;
  const corrections: MatchCorrection[] = [];
  let lastFinalObservedAt: string | null = null;

  for (const obs of rows) {
    if (hasFinalScore(obs)) {
      if (resultObservedAt === null) {
        resultObservedAt = obs.observedAt;
        finalHome = obs.fullTimeHomeGoals;
        finalAway = obs.fullTimeAwayGoals;
      } else if (
        obs.fullTimeHomeGoals !== finalHome ||
        obs.fullTimeAwayGoals !== finalAway
      ) {
        corrections.push({
          correctionId: `corr::${canonicalMatchId}::${obs.observationId}`,
          detectedAt: obs.observedAt,
          source: obs.source,
          previous: { home: finalHome, away: finalAway },
          corrected: { home: obs.fullTimeHomeGoals, away: obs.fullTimeAwayGoals },
          previousObservedAt: lastFinalObservedAt ?? resultObservedAt,
        });
        finalHome = obs.fullTimeHomeGoals;
        finalAway = obs.fullTimeAwayGoals;
      }
      lastFinalObservedAt = obs.observedAt;
      resultObs = obs;
    } else if (resultObs === null) {
      // Pre-final states still describe the fixture (kickoff, matchday, teams).
      resultObs = obs;
    }
  }

  // The newest observation defines the current lifecycle status; a match that
  // was FINISHED and is later reported ABANDONED must reflect that.
  const statusObs = last;
  const useFinal = hasFinalScore(statusObs) || (resultObservedAt !== null && statusObs.status === "FINISHED");

  // ── Statistics: last observation that actually carried any.
  let homeStats: TeamMatchStatistics | null = null;
  let awayStats: TeamMatchStatistics | null = null;
  let statsProvenance: SectionProvenance | null = null;
  for (const obs of rows) {
    if (nonEmptyStats(obs.homeStatistics) || nonEmptyStats(obs.awayStatistics)) {
      homeStats = obs.homeStatistics;
      awayStats = obs.awayStatistics;
      statsProvenance = provenanceOf(obs);
    }
  }

  // ── Events: last observation that actually carried any.
  let events: CanonicalMatch["events"] = null;
  let eventsProvenance: SectionProvenance | null = null;
  for (const obs of rows) {
    if (eventsCarryAnything(obs)) {
      events = obs.events;
      eventsProvenance = provenanceOf(obs);
    }
  }

  const sources = [...new Set(rows.map((r) => r.source))].sort();

  return {
    schemaVersion: MATCH_LEDGER_SCHEMA_VERSION,
    canonicalMatchId,
    competition: last.competition,
    season: last.season,
    matchday: last.matchday ?? resultObs?.matchday ?? null,
    stage: last.stage ?? null,
    kickoffUtc: last.kickoffUtc ?? resultObs?.kickoffUtc ?? null,
    home: last.home,
    away: last.away,
    status: last.status,
    halfTimeHomeGoals: useFinal ? statusObs.halfTimeHomeGoals ?? resultObs?.halfTimeHomeGoals ?? null : last.halfTimeHomeGoals,
    halfTimeAwayGoals: useFinal ? statusObs.halfTimeAwayGoals ?? resultObs?.halfTimeAwayGoals ?? null : last.halfTimeAwayGoals,
    fullTimeHomeGoals: useFinal ? finalHome : last.fullTimeHomeGoals,
    fullTimeAwayGoals: useFinal ? finalAway : last.fullTimeAwayGoals,
    outcome: useFinal && finalHome !== null && finalAway !== null
      ? finalHome > finalAway
        ? "HOME"
        : finalHome < finalAway
          ? "AWAY"
          : "DRAW"
      : last.outcome,
    // Only a match that is CURRENTLY final carries an admissibility instant.
    // An abandoned/annulled match loses it, and with it its evidence status.
    resultObservedAt: statusObs.status === "FINISHED" ? resultObservedAt : null,
    homeStatistics: homeStats,
    awayStatistics: awayStats,
    events,
    provenance: {
      result: resultObs ? provenanceOf(resultObs) : null,
      statistics: statsProvenance,
      events: eventsProvenance,
    },
    observationIds: rows.map((r) => r.observationId),
    observationCount: rows.length,
    sources,
    corrections,
    firstObservedAt: first.observedAt,
    lastObservedAt: last.observedAt,
  };
}

/** Materialize every match in a mixed observation stream. */
export function materializeAll(rows: MatchObservation[]): CanonicalMatch[] {
  const byMatch = new Map<string, MatchObservation[]>();
  for (const row of rows) {
    const list = byMatch.get(row.canonicalMatchId);
    if (list) list.push(row);
    else byMatch.set(row.canonicalMatchId, [row]);
  }
  const out: CanonicalMatch[] = [];
  for (const list of byMatch.values()) {
    const m = materializeMatch(list);
    if (m) out.push(m);
  }
  return out.sort(
    (a, b) =>
      (a.kickoffUtc ?? "").localeCompare(b.kickoffUtc ?? "") ||
      a.canonicalMatchId.localeCompare(b.canonicalMatchId)
  );
}
