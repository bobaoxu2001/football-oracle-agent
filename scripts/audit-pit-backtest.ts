/**
 * Repository-backed strict PIT readiness audit.
 *
 * This inspects each nominal held-out row for the minimum provenance needed by
 * the isolated replay boundary. It intentionally emits no model-performance
 * headline while any candidate fails a material PIT gate.
 */

import fixturesDoc from "@/data/processed/premier-league/fixtures.json";

type HistoricalFixtureRow = Record<string, unknown> & {
  id?: string;
  season?: string;
  date?: string;
  division?: string;
  status?: string;
  homeSlug?: string;
  awaySlug?: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
};

type RejectionReason =
  | "missingResultAvailableAtOrFirstObservedHistory"
  | "missingKickoffAsKnownAndRescheduleHistory"
  | "missingPitSeasonMembershipSnapshot"
  | "missingPerFixtureReplayLineage"
  | "missingOutcome"
  | "sealedReplayUnavailable";

const rows = (fixturesDoc as unknown as { fixtures: HistoricalFixtureRow[] }).fixtures;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): boolean {
  return (
    nonEmptyString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function uniqueRows(input: HistoricalFixtureRow[]): HistoricalFixtureRow[] {
  const byId = new Map<string, HistoricalFixtureRow>();
  for (const row of input) {
    if (!nonEmptyString(row.id)) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function completedDivision(division: string): HistoricalFixtureRow[] {
  return uniqueRows(
    rows.filter(
      (row) =>
        row.division === division &&
        row.status === "completed" &&
        typeof row.homeGoals === "number" &&
        typeof row.awayGoals === "number"
    )
  );
}

function rejectionReasons(row: HistoricalFixtureRow): RejectionReason[] {
  const reasons: RejectionReason[] = [];

  const resultAvailableAt =
    row.resultFirstObservedAt ?? row.resultAvailableAt;
  if (!validTimestamp(resultAvailableAt)) {
    reasons.push("missingResultAvailableAtOrFirstObservedHistory");
  }

  const kickoffAsKnown = row.kickoffAtAsKnown ?? row.kickoffUtcAsKnown;
  const fixtureObservationAt =
    row.fixtureObservationAvailableAt ?? row.fixtureRetrievedAt;
  const fixtureObservationId = row.fixtureObservationId ?? row.scheduleRevisionId;
  if (
    !validTimestamp(kickoffAsKnown) ||
    !validTimestamp(fixtureObservationAt) ||
    !nonEmptyString(fixtureObservationId)
  ) {
    reasons.push("missingKickoffAsKnownAndRescheduleHistory");
  }

  if (
    !nonEmptyString(row.seasonMembershipSnapshotId) ||
    !validTimestamp(row.seasonMembershipAvailableAt)
  ) {
    reasons.push("missingPitSeasonMembershipSnapshot");
  }

  const sourceIds = row.sourceIds;
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length === 0 ||
    !sourceIds.every(nonEmptyString) ||
    !nonEmptyString(row.featureVersion) ||
    !nonEmptyString(row.modelVersion) ||
    !nonEmptyString(row.replayCodeVersion) ||
    !nonEmptyString(row.sourceContentHash)
  ) {
    reasons.push("missingPerFixtureReplayLineage");
  }

  if (typeof row.homeGoals !== "number" || typeof row.awayGoals !== "number") {
    reasons.push("missingOutcome");
  }

  return reasons;
}

const completedE0 = completedDivision("E0");
const completedE1 = completedDivision("E1");
const training = completedE0.filter(
  (row) => nonEmptyString(row.date) && row.date <= "2025-05-31"
);
const heldOut = completedE0.filter(
  (row) => nonEmptyString(row.date) && row.date >= "2025-08-01" && row.date <= "2026-06-01"
);

const audited = heldOut.map((row) => ({
  fixtureId: row.id as string,
  reasons: rejectionReasons(row),
}));
const rowLevelProvenanceCandidates = audited.filter((row) => row.reasons.length === 0);
// A field-presence gate is necessary but not sufficient. No historical row is
// called fully PIT-valid until a sealed predictor passes the replay admission
// boundary with the complete upstream observation tape.
const sealedReplayStatus = "NOT_IMPLEMENTED" as const;
const fullyPitValidFixtures = 0;
const partiallyReconstructable = audited.filter((row) => {
  const source = heldOut.find((candidate) => candidate.id === row.fixtureId);
  return Boolean(
    source &&
      nonEmptyString(source.id) &&
      nonEmptyString(source.date) &&
      nonEmptyString(source.homeSlug) &&
      nonEmptyString(source.awaySlug) &&
      typeof source.homeGoals === "number" &&
      typeof source.awayGoals === "number"
  );
});

const reasonCounts = Object.fromEntries(
  [
    "missingResultAvailableAtOrFirstObservedHistory",
    "missingKickoffAsKnownAndRescheduleHistory",
    "missingPitSeasonMembershipSnapshot",
    "missingPerFixtureReplayLineage",
    "missingOutcome",
    "sealedReplayUnavailable",
  ].map((reason) => [
    reason,
    reason === "sealedReplayUnavailable"
      ? heldOut.length
      : audited.filter((row) => row.reasons.includes(reason as RejectionReason)).length,
  ])
);

const verdict =
  fullyPitValidFixtures === 0
    ? "HISTORICAL BACKTEST NOT YET ADMISSIBLE"
    : "PIT CANDIDATES DETECTED — SEALED REPLAY AND REVIEW REQUIRED";

const report = {
  verdict,
  track: "HISTORICAL_REPLAY",
  existingArtifactLabel: "DATE-STRICT RESEARCH BENCHMARK — NOT VERIFIED PIT REPLAY",
  cohort: {
    historicalPremierLeagueFixtures: completedE0.length,
    historicalChampionshipFixtures: completedE1.length,
    modelTrainingFixtures: training.length,
    candidateHeldOutFixtures: heldOut.length,
    rowLevelProvenanceCandidates: rowLevelProvenanceCandidates.length,
    fullyPitValidFixtures,
    partiallyReconstructableFixtures: partiallyReconstructable.length,
    rejectedFixtures: heldOut.length - fullyPitValidFixtures,
  },
  overlappingRejectionReasons: reasonCounts,
  fieldsInspectedPerFixture: {
    resultKnowledge: [
      "resultFirstObservedAt",
      "resultAvailableAt",
    ],
    fixtureKnowledge: [
      "kickoffAtAsKnown",
      "kickoffUtcAsKnown",
      "fixtureObservationAvailableAt",
      "fixtureRetrievedAt",
      "fixtureObservationId",
      "scheduleRevisionId",
    ],
    seasonMembership: ["seasonMembershipSnapshotId", "seasonMembershipAvailableAt"],
    lineage: [
      "sourceIds",
      "sourceContentHash",
      "featureVersion",
      "modelVersion",
      "replayCodeVersion",
    ],
  },
  temporalContract: {
    production: "input.availableAt <= cutoffAt <= generatedAt < kickoffAt",
    historicalReplay:
      "input.availableAt <= cutoffAt < kickoffAtAsKnown; replayExecutedAt is retained separately and never presented as historical issuance",
  },
  performanceMetrics: null,
  sealedReplayStatus,
  performanceStatus:
    fullyPitValidFixtures === 0
      ? "WITHHELD_NO_PIT_VALID_FIXTURES"
      : "WITHHELD_PENDING_SEALED_REPLAY_AND_REVIEW",
  productionLedgerWrites: 0,
};

console.log(JSON.stringify(report, null, 2));
