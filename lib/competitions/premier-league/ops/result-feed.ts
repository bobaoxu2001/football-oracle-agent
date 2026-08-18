/**
 * Result ingestion and verification.
 *
 * LIVE / HALFTIME / unverified scores never settle.
 * Settlement requires VERIFIED_FINAL.
 * Two live sources that disagree on the full-time score → CONFLICT.
 */

import type { Fixture } from "@/lib/identity/types";
import { canonicalizeFixtureStatus } from "../ingest";
import type {
  DataConflict,
  MatchStatus,
  ResultObservation,
  ResultVerification,
  ResultVerificationStatus,
  SettlementCorrection,
  SourceObservation,
} from "./types";
import { LIVE_SOURCES } from "./sources";
import { appendJsonl, readJsonl, rewriteJsonl, unlinkIfExists } from "./jsonl";
import { resultObservationPath, resultVerificationPath, settlementCorrectionPath } from "./paths";
import { applyFixturePatch } from "../fixture-store";

const TRUSTED_RESULT_SOURCES = new Set<string>([...LIVE_SOURCES, "test-primary", "test-secondary"]);

export function settlementPolicy(status: MatchStatus): "settle-if-verified" | "no-settlement" {
  return status === "FINISHED" ? "settle-if-verified" : "no-settlement";
}

function loadObs(): ResultObservation[] {
  return readJsonl<ResultObservation>(resultObservationPath());
}

export function clearResultFeedForTests(): void {
  unlinkIfExists(resultObservationPath());
  unlinkIfExists(resultVerificationPath());
  unlinkIfExists(settlementCorrectionPath());
}

export function persistResultObservation(obs: ResultObservation): ResultObservation {
  const existing = loadObs();
  if (existing.some((e) => e.observationId === obs.observationId)) return obs;
  appendJsonl(resultObservationPath(), obs);
  return obs;
}

function stripResultRaw(row: ResultObservation): ResultObservation {
  return { ...row, raw: null };
}

/** Latest result observation per fixture+source. Prevents the same 16 MB leak after matches finish. */
export function compactResultObservations(rows: ResultObservation[]): ResultObservation[] {
  const byKey = new Map<string, ResultObservation>();
  for (const row of rows) {
    const key = `${row.source}::${row.fixtureId}`;
    const prev = byKey.get(key);
    if (!prev || prev.retrievedAt <= row.retrievedAt) byKey.set(key, stripResultRaw(row));
  }
  return [...byKey.values()].sort(
    (a, b) => a.retrievedAt.localeCompare(b.retrievedAt) || a.fixtureId.localeCompare(b.fixtureId)
  );
}

export function compactPersistedResultObservations(): void {
  rewriteJsonl(resultObservationPath(), compactResultObservations(loadObs()));
}

export function observationsFromSources(
  rows: SourceObservation[],
  fixtureId?: string
): ResultObservation[] {
  const out: ResultObservation[] = [];
  for (const row of rows) {
    if (!row.fixtureId) continue;
    if (fixtureId && row.fixtureId !== fixtureId) continue;
    const n = row.normalized;
    if (n.status === "SCHEDULED" && n.homeGoals === null) continue;
    out.push({
      observationId: `result::${row.observationId}`,
      fixtureId: row.fixtureId,
      source: row.source,
      sourceFixtureId: row.sourceFixtureId,
      retrievedAt: row.retrievedAt,
      matchStatus: n.status,
      homeGoals: n.homeGoals,
      awayGoals: n.awayGoals,
      resultTimestamp: row.sourceUpdatedAt,
      raw: row.raw,
    });
  }
  return out;
}

function latestPerSource(rows: ResultObservation[]): ResultObservation[] {
  const by = new Map<string, ResultObservation>();
  for (const row of rows) {
    const prev = by.get(row.source);
    if (!prev || prev.retrievedAt <= row.retrievedAt) by.set(row.source, row);
  }
  return [...by.values()];
}

export function verifyFixtureResult(
  fixtureId: string,
  observations: ResultObservation[],
  nowIso: string
): ResultVerification {
  const latest = latestPerSource(observations.filter((o) => o.fixtureId === fixtureId));
  const trusted = latest.filter((o) => TRUSTED_RESULT_SOURCES.has(o.source));
  const sources = trusted.map((o) => o.source);

  const live = trusted.filter((o) => o.matchStatus === "LIVE");
  const finished = trusted.filter(
    (o) => o.matchStatus === "FINISHED" && o.homeGoals !== null && o.awayGoals !== null
  );
  const postponed = trusted.filter((o) =>
    ["POSTPONED", "CANCELLED", "SUSPENDED", "ABANDONED"].includes(o.matchStatus)
  );

  if (finished.length >= 2) {
    const a = finished[0];
    const disagree = finished.some((f) => f.homeGoals !== a.homeGoals || f.awayGoals !== a.awayGoals);
    if (disagree) {
      return {
        fixtureId,
        status: "CONFLICT",
        matchStatus: "FINISHED",
        homeGoals: null,
        awayGoals: null,
        sources,
        verifiedAt: null,
        conflictReason: finished.map((f) => `${f.source}=${f.homeGoals}-${f.awayGoals}`).join("; "),
        updatedAt: nowIso,
      };
    }
    return {
      fixtureId,
      status: "VERIFIED_FINAL",
      matchStatus: "FINISHED",
      homeGoals: a.homeGoals,
      awayGoals: a.awayGoals,
      sources,
      verifiedAt: nowIso,
      conflictReason: null,
      updatedAt: nowIso,
    };
  }

  if (finished.length === 1 && live.length === 0 && postponed.length === 0) {
    const a = finished[0];
    const othersOpen = trusted.some(
      (o) => o.source !== a.source && o.matchStatus === "SCHEDULED"
    );
    if (othersOpen && trusted.length > 1) {
      return {
        fixtureId,
        status: "PROVISIONAL",
        matchStatus: "FINISHED",
        homeGoals: a.homeGoals,
        awayGoals: a.awayGoals,
        sources,
        verifiedAt: null,
        conflictReason: null,
        updatedAt: nowIso,
      };
    }
    return {
      fixtureId,
      status: "VERIFIED_FINAL",
      matchStatus: "FINISHED",
      homeGoals: a.homeGoals,
      awayGoals: a.awayGoals,
      sources,
      verifiedAt: nowIso,
      conflictReason: null,
      updatedAt: nowIso,
    };
  }

  if (finished.length === 1 && (live.length > 0 || postponed.length > 0)) {
    return {
      fixtureId,
      status: "PROVISIONAL",
      matchStatus: finished[0].matchStatus,
      homeGoals: finished[0].homeGoals,
      awayGoals: finished[0].awayGoals,
      sources,
      verifiedAt: null,
      conflictReason: null,
      updatedAt: nowIso,
    };
  }

  if (live.length) {
    return {
      fixtureId,
      status: "UNVERIFIED",
      matchStatus: "LIVE",
      homeGoals: live[0].homeGoals,
      awayGoals: live[0].awayGoals,
      sources,
      verifiedAt: null,
      conflictReason: null,
      updatedAt: nowIso,
    };
  }

  if (postponed.length) {
    return {
      fixtureId,
      status: "UNVERIFIED",
      matchStatus: postponed[0].matchStatus,
      homeGoals: null,
      awayGoals: null,
      sources,
      verifiedAt: null,
      conflictReason: null,
      updatedAt: nowIso,
    };
  }

  return {
    fixtureId,
    status: "UNVERIFIED",
    matchStatus: trusted[0]?.matchStatus ?? "SCHEDULED",
    homeGoals: null,
    awayGoals: null,
    sources,
    verifiedAt: null,
    conflictReason: null,
    updatedAt: nowIso,
  };
}

export function persistVerification(v: ResultVerification): ResultVerification {
  const existing = loadVerifications().filter((e) => e.fixtureId !== v.fixtureId);
  existing.push(v);
  rewriteJsonl(resultVerificationPath(), existing);
  return v;
}

export function loadVerifications(): ResultVerification[] {
  const rows = readJsonl<ResultVerification>(resultVerificationPath());
  const by = new Map<string, ResultVerification>();
  for (const row of rows) by.set(row.fixtureId, row);
  return [...by.values()];
}

export function getVerification(fixtureId: string): ResultVerification | null {
  return loadVerifications().find((v) => v.fixtureId === fixtureId) ?? null;
}

export function resultConflicts(): DataConflict[] {
  return loadVerifications()
    .filter((v) => v.status === "CONFLICT")
    .map((v) => ({
      kind: "result-score" as const,
      fixtureId: v.fixtureId,
      sources: v.sources,
      detail: v.conflictReason ?? "score conflict",
      recordedAt: v.updatedAt,
    }));
}

export function ingestAndVerifyResults(input: {
  fixtures: Fixture[];
  observations: SourceObservation[];
  now: string;
  persistFixturePatches?: boolean;
}): {
  verifications: ResultVerification[];
  conflicts: DataConflict[];
  verifiedFinal: ResultVerification[];
} {
  const resultObs = observationsFromSources(input.observations);
  for (const obs of resultObs) persistResultObservation(obs);
  compactPersistedResultObservations();
  const stored = loadObs();
  const fixtureIds = new Set(stored.map((o) => o.fixtureId));
  const verifications: ResultVerification[] = [];
  for (const id of fixtureIds) {
    const v = verifyFixtureResult(id, stored, input.now);
    persistVerification(v);
    verifications.push(v);
    if (input.persistFixturePatches && v.status === "VERIFIED_FINAL" && v.homeGoals !== null && v.awayGoals !== null) {
      const fixture = input.fixtures.find((f) => f.id === id);
      if (fixture && canonicalizeFixtureStatus(fixture.status) !== "FINISHED") {
        try {
          applyFixturePatch(id, {
            status: "FINISHED",
            homeGoals: v.homeGoals,
            awayGoals: v.awayGoals,
            resultSource: v.sources.join("+"),
            finishedAt: v.verifiedAt,
            statusUpdatedAt: input.now,
          }, input.now);
        } catch {
          /* fixture store may be isolated / missing in unit tests */
        }
      }
    } else if (input.persistFixturePatches && (v.matchStatus === "POSTPONED" || v.matchStatus === "CANCELLED" || v.matchStatus === "SUSPENDED" || v.matchStatus === "ABANDONED" || v.matchStatus === "LIVE")) {
      try {
        applyFixturePatch(id, {
          status: v.matchStatus,
          statusUpdatedAt: input.now,
        }, input.now);
      } catch {
        /* ignore */
      }
    }
  }
  const conflicts = verifications
    .filter((v) => v.status === "CONFLICT")
    .map((v) => ({
      kind: "result-score" as const,
      fixtureId: v.fixtureId,
      sources: v.sources,
      detail: v.conflictReason ?? "score conflict",
      recordedAt: v.updatedAt,
    }));
  return {
    verifications,
    conflicts,
    verifiedFinal: verifications.filter((v) => v.status === "VERIFIED_FINAL"),
  };
}

export function recordSettlementCorrection(input: {
  snapshotUniqueKey: string;
  fixtureId: string;
  previousScore: { home: number; away: number };
  reportedScore: { home: number; away: number };
  reason: string;
  recordedAt: string;
}): SettlementCorrection {
  const row: SettlementCorrection = {
    correctionId: `corr::${input.snapshotUniqueKey}::${input.recordedAt}`,
    snapshotUniqueKey: input.snapshotUniqueKey,
    fixtureId: input.fixtureId,
    recordedAt: input.recordedAt,
    reason: input.reason,
    previousScore: input.previousScore,
    reportedScore: input.reportedScore,
    ratingsTouched: false,
  };
  appendJsonl(settlementCorrectionPath(), row);
  return row;
}

export function loadSettlementCorrections(): SettlementCorrection[] {
  return readJsonl<SettlementCorrection>(settlementCorrectionPath());
}

export function maybeCorrectResult(input: {
  fixtureId: string;
  previous: ResultVerification;
  incoming: ResultVerification;
  now: string;
}): SettlementCorrection[] {
  if (input.previous.status !== "VERIFIED_FINAL" || input.incoming.status !== "VERIFIED_FINAL") return [];
  if (input.previous.homeGoals === input.incoming.homeGoals && input.previous.awayGoals === input.incoming.awayGoals) {
    return [];
  }
  return [
    recordSettlementCorrection({
      snapshotUniqueKey: `fixture::${input.fixtureId}`,
      fixtureId: input.fixtureId,
      previousScore: { home: input.previous.homeGoals ?? 0, away: input.previous.awayGoals ?? 0 },
      reportedScore: { home: input.incoming.homeGoals ?? 0, away: input.incoming.awayGoals ?? 0 },
      reason: "source later reported a different full-time score; original settlement not mutated; ratings not re-applied",
      recordedAt: input.now,
    }),
  ];
}

export function canSettleVerification(v: ResultVerification): boolean {
  return (
    v.status === "VERIFIED_FINAL" &&
    v.matchStatus === "FINISHED" &&
    v.homeGoals !== null &&
    v.awayGoals !== null
  );
}
