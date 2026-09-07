import { createHash } from "node:crypto";
import type { Fixture } from "@/lib/identity/types";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { jobsForFixture, listJobs } from "@/lib/competitions/premier-league/ops/job-ledger";
import type { PredictionJob } from "@/lib/competitions/premier-league/ops/types";
import {
  evaluateFixtureForecastFreshness,
  validateProductionForecastSnapshot,
  type ForecastFreshnessSnapshotInput,
} from "@/lib/competitions/premier-league/ops/production-freshness";
import {
  getFrozenMatchContext,
  listFrozenMatchContexts,
} from "@/lib/competitions/premier-league/ops/context-snapshots";
import { productionModelVersion } from "@/lib/competitions/premier-league/shadow/track";
import { deriveMatchIntelligence } from "@/lib/competitions/premier-league/intelligence";
import {
  diffMatchContexts,
  MATCH_CONTEXT_SCHEMA_VERSION,
  MATCH_CONTEXT_TEMPORAL_RULE,
  type MatchContextSnapshot,
} from "@/lib/competitions/premier-league/context";
import {
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import { assertForecastInvariants, deriveForecastMath, scoreMatrixFromSnapshot } from "./derive";
import { inputLineageSummary } from "./input-lineage";
import type {
  ForecastComparison,
  ContextChangeSummary,
  ForecastTimelinePoint,
  MatchForecast,
  MatchContextComparison,
  MatchContextView,
  MatchIntelligence,
  ForecastFreshness,
  UpcomingMatchForecast,
} from "./types";

export class MatchForecastError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_MATCH" | "NO_PRODUCTION_FORECAST" | "FORECAST_INTEGRITY",
    public readonly status: number
  ) {
    super(message);
  }
}

export function resolvePremierLeagueFixture(matchId: string): Fixture {
  const fixture = liveFixtures().find((candidate) => candidate.id === matchId);
  if (!fixture) {
    throw new MatchForecastError(`Unknown Premier League match: ${matchId}.`, "UNKNOWN_MATCH", 404);
  }
  if (!fixture.kickoffUtc) {
    throw new MatchForecastError(`Match ${matchId} has no auditable kickoff timestamp.`, "NO_PRODUCTION_FORECAST", 409);
  }
  return fixture;
}

/**
 * Resolve an official Premier League fixture from two club slugs.
 * Orientation always follows the fixture (home/away), never the query order.
 * If both home-and-away meetings exist, the next kickoff after `now` wins;
 * otherwise the most recent past kickoff is used.
 */
export function resolvePremierLeagueFixtureByClubs(
  slugA: string,
  slugB: string,
  now = new Date()
): Fixture {
  if (!slugA || !slugB || slugA === slugB) {
    throw new MatchForecastError(
      `No Premier League fixture matches ${slugA} vs ${slugB}.`,
      "UNKNOWN_MATCH",
      404
    );
  }
  const pair = liveFixtures().filter(
    (fixture) =>
      (fixture.homeSlug === slugA && fixture.awaySlug === slugB) ||
      (fixture.homeSlug === slugB && fixture.awaySlug === slugA)
  );
  if (pair.length === 0) {
    throw new MatchForecastError(
      `No Premier League fixture matches ${slugA} vs ${slugB}.`,
      "UNKNOWN_MATCH",
      404
    );
  }
  const nowMs = now.getTime();
  const dated = pair.filter((fixture) => Number.isFinite(Date.parse(fixture.kickoffUtc ?? "")));
  if (dated.length === 0) {
    throw new MatchForecastError(
      `Match ${pair[0].id} has no auditable kickoff timestamp.`,
      "NO_PRODUCTION_FORECAST",
      409
    );
  }
  const upcoming = dated
    .filter((fixture) => Date.parse(fixture.kickoffUtc as string) > nowMs)
    .sort(
      (a, b) => Date.parse(a.kickoffUtc as string) - Date.parse(b.kickoffUtc as string)
    );
  const selected =
    upcoming[0] ??
    [...dated].sort(
      (a, b) => Date.parse(b.kickoffUtc as string) - Date.parse(a.kickoffUtc as string)
    )[0];
  return resolvePremierLeagueFixture(selected.id);
}

export function isProductionForecastSnapshot(snapshot: PredictionSnapshot): boolean {
  return (
    snapshot.competition === "premier-league" &&
    snapshot.evaluationClass === "LIVE_OOS" &&
    snapshot.modelVersion === productionModelVersion()
  );
}

export function productionSnapshotsForMatch(
  matchId: string,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: matchId })
): PredictionSnapshot[] {
  return snapshots
    .filter((snapshot) => snapshot.fixtureId === matchId && isProductionForecastSnapshot(snapshot))
    .sort(
      (a, b) =>
        a.asOf.localeCompare(b.asOf) ||
        effectiveSnapshotGeneratedAt(a).localeCompare(effectiveSnapshotGeneratedAt(b)) ||
        a.provenance.uniqueKey.localeCompare(b.provenance.uniqueKey)
    );
}

function snapshotIsValidBeforeKickoff(
  snapshot: PredictionSnapshot,
  kickoffMs: number
): boolean {
  const cutoffMs = Date.parse(snapshot.asOf);
  const generatedMs = Date.parse(effectiveSnapshotGeneratedAt(snapshot));
  return (
    Number.isFinite(cutoffMs) &&
    Number.isFinite(generatedMs) &&
    Number.isFinite(kickoffMs) &&
    cutoffMs < kickoffMs &&
    generatedMs < kickoffMs
  );
}

function snapshotMatchesKickoff(snapshot: PredictionSnapshot, kickoffMs: number): boolean {
  if (!snapshot.kickoff) return true;
  const frozenKickoffMs = Date.parse(snapshot.kickoff);
  return Number.isFinite(frozenKickoffMs) && frozenKickoffMs === kickoffMs;
}

export function selectProductionSnapshot(
  fixture: Fixture,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: fixture.id }),
  now = new Date()
): PredictionSnapshot {
  const kickoffUtc = fixture.kickoffUtc ?? fixture.kickoff ?? "";
  const kickoffMs = Date.parse(kickoffUtc);
  const eligible = productionSnapshotsForMatch(fixture.id, snapshots).filter(
    (snapshot) =>
      inputLineageSummary(snapshot).status !== "PIT_INVALID" &&
      snapshotMatchesKickoff(snapshot, kickoffMs) &&
      Boolean(
        validateProductionForecastSnapshot({
          snapshot: freshnessSnapshotInput(snapshot),
          expectedKickoffUtc: kickoffUtc,
          evaluatedAt: now.toISOString(),
        }).valid
      )
  );
  const selected = eligible[eligible.length - 1];
  if (!selected) {
    throw new MatchForecastError(
      `No immutable production forecast exists before kickoff for ${fixture.id}.`,
      "NO_PRODUCTION_FORECAST",
      404
    );
  }
  return selected;
}

function latestIncludedInputAt(snapshot: PredictionSnapshot): string | null {
  return effectiveSnapshotLatestIncludedInputAt(snapshot);
}

function freshnessSnapshotInput(snapshot: PredictionSnapshot): ForecastFreshnessSnapshotInput {
  const productionVersion = productionModelVersion();
  return {
    snapshotId: snapshot.provenance.uniqueKey,
    fixtureId: snapshot.fixtureId,
    modelRole:
      snapshot.modelVersion === productionVersion
        ? "production"
        : snapshot.modelVersion.includes("shadow")
          ? "shadow"
          : "reconstruction",
    modelVersion: snapshot.modelVersion,
    evaluationClass: snapshot.evaluationClass ?? null,
    predictionStage: String(snapshot.predictionStage),
    kickoffUtc: snapshot.kickoff,
    cutoffAt: snapshot.asOf,
    generatedAt: effectiveSnapshotGeneratedAt(snapshot),
    latestIncludedInputAt: latestIncludedInputAt(snapshot),
  };
}

export function forecastFreshness(
  fixture: Fixture,
  snapshots: PredictionSnapshot[],
  now = new Date(),
  jobs: PredictionJob[] = jobsForFixture(fixture.id)
): ForecastFreshness {
  const kickoffUtc = fixture.kickoffUtc ?? fixture.kickoff;
  if (!kickoffUtc) {
    throw new MatchForecastError(
      `Match ${fixture.id} has no auditable kickoff timestamp.`,
      "NO_PRODUCTION_FORECAST",
      409
    );
  }
  return evaluateFixtureForecastFreshness({
    fixtureId: fixture.id,
    kickoffUtc,
    evaluatedAt: now.toISOString(),
    expectedModelVersion: productionModelVersion(),
    snapshots: snapshots.map(freshnessSnapshotInput),
    jobs: jobs.map((job) => ({
      fixtureId: job.fixtureId,
      modelVersion: job.modelVersion,
      stage: job.stage,
      kickoffUtc: job.kickoffUtc,
      status: job.status,
    })),
  });
}

function trainingWindow(snapshot: PredictionSnapshot): { from: string; to: string } | null {
  const value = snapshot.modelParameters?.trainingWindow;
  if (!value || typeof value !== "object") return null;
  const from = (value as { from?: unknown }).from;
  const to = (value as { to?: unknown }).to;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

function sourceStateForApi(snapshot: PredictionSnapshot): Record<string, unknown> {
  const source = snapshot.sourceState ?? {};
  const allow = [
    "eloHome",
    "eloAway",
    "fixturesUsed",
    "ratingStateAsOf",
    "computedAt",
    "ratingEventsUsed",
    "ratingEventIds",
    "latestRatingEventAppliedAt",
    "kickoffCertaintyAtFreeze",
    "fixtureRetrievedAt",
    "fixtureDataVersion",
    "seasonInitVersion",
    "origin",
    "featureCutoff",
    "evidenceMatchIdsHome",
    "evidenceMatchIdsAway",
    "latestEvidenceKickoff",
    "latestEvidenceObservedAt",
    "contextSnapshotId",
    "contextSchemaVersion",
    "contextSnapshotCutoffAt",
    "contextSnapshotGeneratedAt",
    "contextTemporalRule",
    "contextLineupStatus",
    "contextLineupAvailableAt",
    "contextEvidenceCount",
    "contextModelUsedEvidenceCount",
    "contextInformationalEvidenceCount",
    "contextUsedInForecastEvidenceIds",
  ];
  return Object.fromEntries(
    allow
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, source[key]])
  );
}

export function buildMatchForecast(
  fixture: Fixture,
  snapshot: PredictionSnapshot
): MatchForecast {
  if (!isProductionForecastSnapshot(snapshot)) {
    throw new MatchForecastError(
      `Refusing non-production forecast ${snapshot.modelVersion}.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  if (snapshot.fixtureId !== fixture.id) {
    throw new MatchForecastError(
      `Forecast ${snapshot.provenance.uniqueKey} belongs to another match.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  if (
    snapshot.season !== fixture.season ||
    snapshot.homeSlug !== fixture.homeSlug ||
    snapshot.awaySlug !== fixture.awaySlug ||
    snapshot.dataCutoff !== snapshot.asOf
  ) {
    throw new MatchForecastError(
      `Forecast ${snapshot.provenance.uniqueKey} does not match the fixture identity or cutoff.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  if (Date.parse(snapshot.asOf) >= Date.parse(fixture.kickoffUtc ?? "")) {
    throw new MatchForecastError(
      `Forecast cutoff ${snapshot.asOf} is not before kickoff.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  const generatedAt = effectiveSnapshotGeneratedAt(snapshot);
  const generatedAtMs = Date.parse(generatedAt);
  const kickoffMs = Date.parse(fixture.kickoffUtc ?? "");
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(kickoffMs) || generatedAtMs >= kickoffMs) {
    throw new MatchForecastError(
      `Forecast generation ${generatedAt} is not before kickoff.`,
      "FORECAST_INTEGRITY",
      409
    );
  }

  const { matrix, artifact } = scoreMatrixFromSnapshot(snapshot);
  const math = deriveForecastMath(matrix);
  const storedResult = [snapshot.homeProbability, snapshot.drawProbability, snapshot.awayProbability];
  const derivedResult = [math.result.homeWin, math.result.draw, math.result.awayWin];
  if (storedResult.some((probability, index) => Math.abs(probability - derivedResult[index]) > 1e-8)) {
    throw new MatchForecastError(
      `Frozen 1X2 disagrees with the canonical score distribution for ${snapshot.provenance.uniqueKey}.`,
      "FORECAST_INTEGRITY",
      409
    );
  }

  const safeSourceState = sourceStateForApi(snapshot);
  const inputLineage = inputLineageSummary(snapshot);
  const recordedLatestIncludedInputAt =
    inputLineage.latestIncludedInputAt ?? latestIncludedInputAt(snapshot);
  const ratingStateAsOf =
    typeof safeSourceState.ratingStateAsOf === "string"
      ? safeSourceState.ratingStateAsOf
      : snapshot.asOf;
  const contextSnapshotId =
    typeof safeSourceState.contextSnapshotId === "string" &&
    safeSourceState.contextSnapshotId.trim()
      ? safeSourceState.contextSnapshotId
      : null;
  const contextUsedInForecastEvidenceIds = Array.isArray(
    safeSourceState.contextUsedInForecastEvidenceIds
  )
    ? safeSourceState.contextUsedInForecastEvidenceIds.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const contextEvidenceCounts = {
    total:
      typeof safeSourceState.contextEvidenceCount === "number"
        ? safeSourceState.contextEvidenceCount
        : 0,
    usedInForecast:
      typeof safeSourceState.contextModelUsedEvidenceCount === "number"
        ? safeSourceState.contextModelUsedEvidenceCount
        : 0,
    informationalOnly:
      typeof safeSourceState.contextInformationalEvidenceCount === "number"
        ? safeSourceState.contextInformationalEvidenceCount
        : 0,
  };
  const contextCountsValid =
    Object.values(contextEvidenceCounts).every(Number.isSafeInteger) &&
    Object.values(contextEvidenceCounts).every((value) => value >= 0) &&
    contextEvidenceCounts.total ===
      contextEvidenceCounts.usedInForecast + contextEvidenceCounts.informationalOnly &&
    contextEvidenceCounts.usedInForecast === contextUsedInForecastEvidenceIds.length &&
    new Set(contextUsedInForecastEvidenceIds).size === contextUsedInForecastEvidenceIds.length;
  const contextGeneratedAt = safeSourceState.contextSnapshotGeneratedAt;
  const contextLineupAvailableAt = safeSourceState.contextLineupAvailableAt;
  const contextLineupStatus = safeSourceState.contextLineupStatus;
  const contextMetadataIsEmpty =
    safeSourceState.contextSchemaVersion == null &&
    safeSourceState.contextSnapshotCutoffAt == null &&
    contextGeneratedAt == null &&
    safeSourceState.contextTemporalRule == null &&
    (contextLineupStatus == null || contextLineupStatus === "NONE") &&
    contextLineupAvailableAt == null;
  const noContextValid =
    !contextSnapshotId &&
    contextCountsValid &&
    contextEvidenceCounts.total === 0 &&
    contextEvidenceCounts.usedInForecast === 0 &&
    contextEvidenceCounts.informationalOnly === 0 &&
    contextUsedInForecastEvidenceIds.length === 0 &&
    contextMetadataIsEmpty;
  const contextGeneratedAtMs = typeof contextGeneratedAt === "string"
    ? Date.parse(contextGeneratedAt)
    : Number.NaN;
  const contextLineupAvailableAtMs = typeof contextLineupAvailableAt === "string"
    ? Date.parse(contextLineupAvailableAt)
    : null;
  const withContextValid =
    Boolean(contextSnapshotId) &&
    contextCountsValid &&
    contextEvidenceCounts.usedInForecast === 0 &&
    safeSourceState.contextSchemaVersion === MATCH_CONTEXT_SCHEMA_VERSION &&
    safeSourceState.contextSnapshotCutoffAt === snapshot.asOf &&
    Number.isFinite(contextGeneratedAtMs) &&
    contextGeneratedAtMs >= Date.parse(snapshot.asOf) &&
    contextGeneratedAtMs < kickoffMs &&
    safeSourceState.contextTemporalRule === MATCH_CONTEXT_TEMPORAL_RULE &&
    ["NONE", "EXPECTED", "CONFIRMED", "PARTIAL"].includes(String(contextLineupStatus)) &&
    (contextLineupAvailableAtMs === null ||
      (Number.isFinite(contextLineupAvailableAtMs) && contextLineupAvailableAtMs <= Date.parse(snapshot.asOf)));
  if (!noContextValid && !withContextValid) {
    throw new MatchForecastError(
      `Forecast ${snapshot.provenance.uniqueKey} carries invalid champion context provenance.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  const forecast: MatchForecast = {
    matchId: fixture.id,
    competition: "premier-league",
    season: fixture.season,
    home: { slug: fixture.homeSlug, name: getClub(fixture.homeSlug).name },
    away: { slug: fixture.awaySlug, name: getClub(fixture.awaySlug).name },
    kickoffUtc: fixture.kickoffUtc as string,
    generatedAt,
    cutoffAt: snapshot.asOf,
    modelVersion: snapshot.modelVersion,
    modelRole: "production",
    expectedGoals: {
      home: snapshot.homeGoalExpectation,
      away: snapshot.awayGoalExpectation,
      total: snapshot.homeGoalExpectation + snapshot.awayGoalExpectation,
    },
    ...math,
    scoreMatrix: matrix,
    provenance: {
      modelVersion: snapshot.modelVersion,
      modelRole: "production",
      generatedAt,
      cutoffAt: snapshot.asOf,
      competition: "premier-league",
      season: snapshot.season,
      predictionStage: snapshot.predictionStage,
      evaluationClass: "LIVE_OOS",
      trainingWindow: trainingWindow(snapshot),
      inputsUsed: [
        "walk-forward Premier League Elo ratings available at cutoff",
        "frozen true-home-advantage parameter",
        "frozen Dixon-Coles rho",
        "frozen goal-expectation mapping",
      ],
      inputSnapshots: safeSourceState,
      dataFreshness: {
        fixtureRetrievedAt:
          typeof safeSourceState.fixtureRetrievedAt === "string"
            ? safeSourceState.fixtureRetrievedAt
            : null,
        ratingStateAsOf,
        latestIncludedInputAt: recordedLatestIncludedInputAt,
        latestIncludedInputStatus: recordedLatestIncludedInputAt
          ? "RECORDED"
          : "UNAVAILABLE",
      },
      immutableForecastId: snapshot.provenance.uniqueKey,
      scoreDistributionArtifact: artifact,
      reconstructionNote:
        artifact === "reconstructed-from-frozen-lambdas-and-rho"
          ? "Legacy immutable snapshots stored only the top scorelines. The complete normalized 9x9 matrix is deterministically reconstructed from the snapshot's frozen home/away goal expectations and frozen Dixon-Coles rho; the historical snapshot is not modified."
          : null,
      contextSnapshotId,
      contextSnapshotSchemaVersion:
        typeof safeSourceState.contextSchemaVersion === "string"
          ? safeSourceState.contextSchemaVersion
          : null,
      contextSnapshotCutoffAt:
        typeof safeSourceState.contextSnapshotCutoffAt === "string"
          ? safeSourceState.contextSnapshotCutoffAt
          : null,
      contextSnapshotGeneratedAt:
        typeof safeSourceState.contextSnapshotGeneratedAt === "string"
          ? safeSourceState.contextSnapshotGeneratedAt
          : null,
      contextTemporalRule:
        typeof safeSourceState.contextTemporalRule === "string"
          ? safeSourceState.contextTemporalRule
          : null,
      lineupStatus:
        typeof safeSourceState.contextSnapshotId === "string" &&
        ["NONE", "EXPECTED", "CONFIRMED", "PARTIAL"].includes(
          String(safeSourceState.contextLineupStatus)
        )
          ? safeSourceState.contextLineupStatus as MatchForecast["provenance"]["lineupStatus"]
          : "NOT_RECORDED",
      lineupAvailableAt:
        typeof safeSourceState.contextLineupAvailableAt === "string"
          ? safeSourceState.contextLineupAvailableAt
          : null,
      contextEvidenceCounts,
      contextUsedInForecastEvidenceIds,
      inputLineage,
    },
  };
  assertForecastInvariants(forecast);
  return forecast;
}

export async function latestMatchForecast(matchId: string, now = new Date()): Promise<MatchForecast> {
  await hydrateDurableOps();
  const fixture = resolvePremierLeagueFixture(matchId);
  const snapshots = listLiveSnapshots({ fixtureId: fixture.id });
  return buildMatchForecast(fixture, selectProductionSnapshot(fixture, snapshots, now));
}

export function upcomingMatchForecasts(limit = 6, now = new Date()): UpcomingMatchForecast[] {
  const nowMs = now.getTime();
  const fixtures = liveFixtures()
    .filter((fixture) => {
      const kickoff = Date.parse(fixture.kickoffUtc ?? "");
      return fixture.status !== "FINISHED" && Number.isFinite(kickoff) && kickoff > nowMs;
    })
    .sort((a, b) => Date.parse(a.kickoffUtc ?? "") - Date.parse(b.kickoffUtc ?? ""));
  const cards: UpcomingMatchForecast[] = [];
  const jobs = listJobs();
  for (const fixture of fixtures) {
    try {
      const snapshots = listLiveSnapshots({ fixtureId: fixture.id });
      const forecast = buildMatchForecast(
        fixture,
        selectProductionSnapshot(fixture, snapshots, now)
      );
      cards.push({
        match: {
          id: fixture.id,
          competition: "premier-league",
          season: fixture.season,
          home: forecast.home,
          away: forecast.away,
          kickoffUtc: fixture.kickoffUtc as string,
          status: fixture.status,
        },
        forecast,
        freshness: forecastFreshness(
          fixture,
          snapshots,
          now,
          jobs.filter((job) => job.fixtureId === fixture.id)
        ),
      });
      if (cards.length >= limit) break;
    } catch (error) {
      if (!(error instanceof MatchForecastError)) throw error;
    }
  }
  return cards;
}

export function forecastTimeline(
  fixture: Fixture,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: fixture.id }),
  now = new Date()
): ForecastTimelinePoint[] {
  return timelineSnapshotRows(fixture, snapshots, now).map(({ snapshot, fixtureAtFreeze, validForCurrentKickoff, validityIssues }) => {
      const forecast = buildMatchForecast(fixtureAtFreeze, snapshot);
      return {
        forecastId: forecast.provenance.immutableForecastId,
        cutoffAt: forecast.cutoffAt,
        generatedAt: forecast.generatedAt,
        kickoffAtFreeze: snapshot.kickoff,
        validForCurrentKickoff,
        validityIssues,
        predictionStage: forecast.provenance.predictionStage,
        modelVersion: forecast.modelVersion,
        result: forecast.result,
        over25: forecast.totals.over25,
        bttsYes: forecast.btts.yes,
        expectedGoalsTotal: forecast.expectedGoals.total,
        contextSnapshotId: forecast.provenance.contextSnapshotId,
        inputLineage: forecast.provenance.inputLineage,
      };
    });
}

function timelineSnapshotRows(
  fixture: Fixture,
  snapshots: PredictionSnapshot[],
  now = new Date()
): Array<{
  snapshot: PredictionSnapshot;
  fixtureAtFreeze: Fixture;
  validForCurrentKickoff: boolean;
  validityIssues: string[];
}> {
  const currentKickoffMs = Date.parse(fixture.kickoffUtc ?? fixture.kickoff ?? "");
  return productionSnapshotsForMatch(fixture.id, snapshots)
    .map((snapshot) => {
      const kickoffAtFreeze = snapshot.kickoff ?? fixture.kickoffUtc ?? fixture.kickoff ?? null;
      const kickoffAtFreezeMs = Date.parse(kickoffAtFreeze ?? "");
      const stageValidation = validateProductionForecastSnapshot({
        snapshot: freshnessSnapshotInput(snapshot),
        expectedKickoffUtc: kickoffAtFreeze ?? "",
        evaluatedAt: now.toISOString(),
      });
      const inputLineageInvalid = inputLineageSummary(snapshot).status === "PIT_INVALID";
      return {
        snapshot,
        fixtureAtFreeze: kickoffAtFreeze
          ? { ...fixture, kickoff: kickoffAtFreeze, kickoffUtc: kickoffAtFreeze }
          : fixture,
        validForCurrentKickoff:
          !inputLineageInvalid &&
          snapshotMatchesKickoff(snapshot, currentKickoffMs) &&
          Boolean(stageValidation.valid),
        validityIssues: inputLineageInvalid
          ? [...stageValidation.issues, "SNAPSHOT_INPUT_LINEAGE_INVALID"]
          : stageValidation.issues,
        kickoffAtFreezeMs,
      };
    })
    .filter(({ snapshot, kickoffAtFreezeMs }) =>
      snapshotIsValidBeforeKickoff(snapshot, kickoffAtFreezeMs) &&
      Date.parse(snapshot.asOf) <= now.getTime() &&
      Date.parse(effectiveSnapshotGeneratedAt(snapshot)) <= now.getTime()
    )
    .map(({ snapshot, fixtureAtFreeze, validForCurrentKickoff, validityIssues }) => ({
      snapshot,
      fixtureAtFreeze,
      validForCurrentKickoff,
      validityIssues,
    }));
}

function shallowInputDiff(
  oldInputs: Record<string, unknown>,
  newInputs: Record<string, unknown>
): ForecastComparison["inputChanges"] {
  const keys = new Set([...Object.keys(oldInputs), ...Object.keys(newInputs)]);
  const changes: ForecastComparison["inputChanges"] = [];
  for (const key of [...keys].sort()) {
    const before = oldInputs[key];
    const after = newInputs[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, before, after });
  }
  return changes;
}

export function compareForecastSnapshots(
  oldForecast: MatchForecast,
  newForecast: MatchForecast
): ForecastComparison {
  if (oldForecast.matchId !== newForecast.matchId) {
    throw new Error("Forecast comparison requires the same match.");
  }
  return {
    oldForecastId: oldForecast.provenance.immutableForecastId,
    newForecastId: newForecast.provenance.immutableForecastId,
    fromCutoff: oldForecast.cutoffAt,
    toCutoff: newForecast.cutoffAt,
    probabilityChanges: {
      homeWin: newForecast.result.homeWin - oldForecast.result.homeWin,
      draw: newForecast.result.draw - oldForecast.result.draw,
      awayWin: newForecast.result.awayWin - oldForecast.result.awayWin,
      over25: newForecast.totals.over25 - oldForecast.totals.over25,
      bttsYes: newForecast.btts.yes - oldForecast.btts.yes,
    },
    expectedGoalsChanges: {
      home: newForecast.expectedGoals.home - oldForecast.expectedGoals.home,
      away: newForecast.expectedGoals.away - oldForecast.expectedGoals.away,
      total: newForecast.expectedGoals.total - oldForecast.expectedGoals.total,
    },
    inputChanges: shallowInputDiff(
      oldForecast.provenance.inputSnapshots,
      newForecast.provenance.inputSnapshots
    ),
    contextChanges: [],
    contextComparisonStatus: "NOT_RECORDED",
    fromContextId: oldForecast.provenance.contextSnapshotId,
    toContextId: newForecast.provenance.contextSnapshotId,
    modelVersionChanged: oldForecast.modelVersion !== newForecast.modelVersion,
    cutoffChanged: oldForecast.cutoffAt !== newForecast.cutoffAt,
    causalAttribution: "not-established",
    causalNote:
      "The changed inputs preceded the newer frozen forecast. This comparison does not establish that any one input caused the full probability move.",
  };
}

export function isAvailableAtCutoff(value: Date | string, cutoffAt: string): boolean {
  const availableMs = Date.parse(value instanceof Date ? value.toISOString() : value);
  const cutoffMs = Date.parse(cutoffAt);
  return Number.isFinite(availableMs) && Number.isFinite(cutoffMs) && availableMs <= cutoffMs;
}

function unavailableContextView(
  status: "NOT_RECORDED" | "MISSING",
  contextId: string | null,
  note: string
): MatchContextView {
  return {
    status,
    contextId,
    schemaVersion: null,
    cutoffAt: null,
    generatedAt: null,
    forecastSnapshotKey: null,
    lineup: null,
    availability: null,
    evidence: [],
    evidenceCounts: { total: 0, usedInForecast: 0, informationalOnly: 0 },
    latestEvidenceAt: null,
    note,
  };
}

function publicContextSource(source: MatchContextSnapshot["evidence"][number]["source"]): {
  name: string;
  recordId: string;
  url: string | null;
} {
  // Raw provider URLs remain inside the immutable evidence envelope. Paths can
  // contain API keys, internal record identities, or private network targets,
  // so the public Match Room/API never republishes them without an explicit
  // provider-specific canonical-link allowlist.
  return {
    name: source.name,
    recordId: `ref:sha256:${createHash("sha256").update(source.recordId).digest("hex").slice(0, 24)}`,
    url: null,
  };
}

function contextView(snapshot: MatchContextSnapshot, note: string): MatchContextView {
  const evidence = snapshot.evidence.map((item) => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    entityId: item.entityId,
    teamSlug: item.teamSlug,
    observedAt: item.observedAt,
    fetchedAt: item.fetchedAt,
    availableAt: item.availableAt,
    confidence: item.confidence,
    rawEvidenceHash: item.rawEvidenceHash,
    source: publicContextSource(item.source),
    usedInForecast: item.usedInForecast,
    lineupStatus: item.lineupStatus,
    availabilityStatus: item.availabilityStatus,
  }));
  const usedInForecast = evidence.filter((item) => item.usedInForecast).length;
  return {
    status: "RECORDED",
    contextId: snapshot.contextId,
    schemaVersion: snapshot.schemaVersion,
    cutoffAt: snapshot.cutoffAt,
    generatedAt: snapshot.generatedAt,
    forecastSnapshotKey: snapshot.forecastSnapshotKey,
    lineup: snapshot.lineup,
    availability: snapshot.availability,
    evidence,
    evidenceCounts: {
      total: evidence.length,
      usedInForecast,
      informationalOnly: evidence.length - usedInForecast,
    },
    latestEvidenceAt: evidence.map((item) => item.availableAt).sort().at(-1) ?? null,
    note,
  };
}

function frozenContextForForecast(forecast: MatchForecast): {
  view: MatchContextView;
  snapshot: MatchContextSnapshot | null;
} {
  const id = forecast.provenance.contextSnapshotId;
  if (!id) {
    return {
      view: unavailableContextView(
        "NOT_RECORDED",
        null,
        "This production forecast predates Phase 4B context recording. Current context was not backfilled into history."
      ),
      snapshot: null,
    };
  }
  let snapshot: MatchContextSnapshot | null = null;
  try {
    snapshot = getFrozenMatchContext(id);
  } catch {
    snapshot = null;
  }
  const actualLineupAvailableAt = snapshot
    ? [snapshot.lineup.home.availableAt, snapshot.lineup.away.availableAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    : null;
  const exactReference = Boolean(
    snapshot &&
      snapshot.fixtureId === forecast.matchId &&
      snapshot.season === forecast.season &&
      snapshot.homeSlug === forecast.home.slug &&
      snapshot.awaySlug === forecast.away.slug &&
      snapshot.kickoffAt === forecast.kickoffUtc &&
      snapshot.cutoffAt === forecast.cutoffAt &&
      snapshot.forecastSnapshotKey === forecast.provenance.immutableForecastId &&
      snapshot.contextId === id &&
      snapshot.schemaVersion === forecast.provenance.contextSnapshotSchemaVersion &&
      snapshot.cutoffAt === forecast.provenance.contextSnapshotCutoffAt &&
      snapshot.generatedAt === forecast.provenance.contextSnapshotGeneratedAt &&
      snapshot.temporalRule === forecast.provenance.contextTemporalRule &&
      snapshot.lineup.overall === forecast.provenance.lineupStatus &&
      actualLineupAvailableAt === forecast.provenance.lineupAvailableAt &&
      snapshot.evidence.length === forecast.provenance.contextEvidenceCounts.total &&
      snapshot.usedInForecastEvidenceIds.length ===
        forecast.provenance.contextEvidenceCounts.usedInForecast &&
      snapshot.evidence.length - snapshot.usedInForecastEvidenceIds.length ===
        forecast.provenance.contextEvidenceCounts.informationalOnly &&
      JSON.stringify(snapshot.usedInForecastEvidenceIds) ===
        JSON.stringify(forecast.provenance.contextUsedInForecastEvidenceIds)
  );
  if (!snapshot || !exactReference) {
    return {
      view: unavailableContextView(
        "MISSING",
        id,
        "The forecast carries a context reference, but the exact immutable context is missing or fails identity checks. No current context was substituted."
      ),
      snapshot: null,
    };
  }
  return {
    view: contextView(
      snapshot,
      snapshot.evidence.length
        ? "Only evidence available by this exact forecast cutoff is shown."
        : "A cutoff-safe context was frozen, but no structured Premier League availability or lineup evidence was available."
    ),
    snapshot,
  };
}

function contextIsProductionVisible(
  context: MatchContextSnapshot,
  productionSnapshots: readonly PredictionSnapshot[]
): boolean {
  if (context.forecastSnapshotKey === null) {
    return context.usedInForecastEvidenceIds.length === 0;
  }
  const linked = productionSnapshots.find(
    (snapshot) =>
      snapshot.provenance.uniqueKey === context.forecastSnapshotKey &&
      snapshot.sourceState.contextSnapshotId === context.contextId
  );
  return Boolean(
    linked &&
      linked.fixtureId === context.fixtureId &&
      linked.season === context.season &&
      linked.homeSlug === context.homeSlug &&
      linked.awaySlug === context.awaySlug &&
      linked.kickoff === context.kickoffAt &&
      linked.asOf === context.cutoffAt &&
      linked.dataCutoff === context.cutoffAt
  );
}

function latestContextForFixture(
  fixture: Fixture,
  now: Date,
  productionSnapshots: readonly PredictionSnapshot[]
): MatchContextView {
  const nowMs = now.getTime();
  const kickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  let candidates: MatchContextSnapshot[] = [];
  try {
    candidates = listFrozenMatchContexts(fixture.id).filter(
      (snapshot) =>
        snapshot.kickoffAt === kickoff &&
        contextIsProductionVisible(snapshot, productionSnapshots) &&
        Date.parse(snapshot.generatedAt) <= nowMs &&
        Date.parse(snapshot.cutoffAt) <= nowMs
    );
  } catch {
    return unavailableContextView(
      "MISSING",
      null,
      "The current context store could not be verified. No mutable fallback was used."
    );
  }
  const latest = candidates
    .sort(
      (a, b) =>
        a.cutoffAt.localeCompare(b.cutoffAt) ||
        a.generatedAt.localeCompare(b.generatedAt) ||
        a.contextId.localeCompare(b.contextId)
    )
    .at(-1);
  return latest
    ? contextView(
        latest,
        latest.evidence.length
          ? "Latest prospectively recorded context for the current kickoff."
          : "Latest recorded context is empty because no structured Premier League availability or lineup provider is configured."
      )
    : unavailableContextView(
        "NOT_RECORDED",
        null,
        "No prospective Phase 4B context exists yet for this kickoff, and no structured Premier League availability or lineup provider is configured."
      );
}

function contextChangeSummaries(
  from: MatchContextSnapshot,
  to: MatchContextSnapshot
): ContextChangeSummary[] {
  const diff = diffMatchContexts(from, to);
  const changes: ContextChangeSummary[] = [];
  for (const item of diff.addedEvidence) {
    changes.push({
      type: "EVIDENCE_ADDED",
      teamSlug: item.teamSlug,
      entityId: item.entityId,
      evidenceId: item.evidenceId,
      before: null,
      after: { kind: item.kind, lineupStatus: item.lineupStatus, availabilityStatus: item.availabilityStatus },
      availableAt: item.availableAt,
      usedInForecast: item.usedInForecast,
    });
  }
  for (const item of diff.removedEvidence) {
    changes.push({
      type: "EVIDENCE_REMOVED",
      teamSlug: item.teamSlug,
      entityId: item.entityId,
      evidenceId: item.evidenceId,
      before: { kind: item.kind, lineupStatus: item.lineupStatus, availabilityStatus: item.availabilityStatus },
      after: null,
      availableAt: item.availableAt,
      usedInForecast: item.usedInForecast,
    });
  }
  for (const item of diff.forecastUsageChanges) {
    changes.push({
      type: "FORECAST_USAGE_CHANGED",
      teamSlug: null,
      entityId: null,
      evidenceId: item.evidenceId,
      before: item.before,
      after: item.after,
      availableAt: null,
      usedInForecast: item.after,
    });
  }
  for (const item of diff.lineupChanges) {
    changes.push({
      type: "LINEUP_CHANGED",
      teamSlug: item.teamSlug,
      entityId: null,
      evidenceId: item.after.evidenceId ?? item.before.evidenceId,
      before: item.before.status,
      after: item.after.status,
      availableAt: item.after.availableAt ?? item.before.availableAt,
      usedInForecast: item.after.usedInForecast,
    });
  }
  for (const item of diff.availabilityChanges) {
    changes.push({
      type: "AVAILABILITY_CHANGED",
      teamSlug: item.teamSlug,
      entityId: item.entityId,
      evidenceId: item.after?.evidenceId ?? item.before?.evidenceId ?? null,
      before: item.before?.status ?? null,
      after: item.after?.status ?? null,
      availableAt: item.after?.availableAt ?? item.before?.availableAt ?? null,
      usedInForecast: item.after?.usedInForecast ?? item.before?.usedInForecast ?? null,
    });
  }
  if (diff.kickoffChanged) {
    changes.push({
      type: "KICKOFF_CHANGED",
      teamSlug: null,
      entityId: null,
      evidenceId: null,
      before: diff.kickoffChanged.before,
      after: diff.kickoffChanged.after,
      availableAt: null,
      usedInForecast: null,
    });
  }
  return changes;
}

function compareMatchContexts(
  from: ReturnType<typeof frozenContextForForecast>,
  to: ReturnType<typeof frozenContextForForecast>
): MatchContextComparison {
  if (from.view.status === "MISSING" || to.view.status === "MISSING") {
    return {
      status: "MISSING",
      fromContextId: from.view.contextId,
      toContextId: to.view.contextId,
      changes: [],
      causalAttribution: "not-established",
      causalNote: "An exact context reference is unavailable, so no context change is inferred.",
    };
  }
  if (!from.snapshot || !to.snapshot) {
    return {
      status: "NOT_RECORDED",
      fromContextId: from.view.contextId,
      toContextId: to.view.contextId,
      changes: [],
      causalAttribution: "not-established",
      causalNote: "At least one forecast predates prospective context recording; current state is not used to reconstruct it.",
    };
  }
  return {
    status: "COMPARED",
    fromContextId: from.snapshot.contextId,
    toContextId: to.snapshot.contextId,
    changes: contextChangeSummaries(from.snapshot, to.snapshot),
    causalAttribution: "not-established",
    causalNote:
      "Context changes were observed between the exact cutoffs. Their timing does not establish that any item caused the probability change.",
  };
}

export async function getMatchIntelligence(matchId: string, now = new Date()): Promise<MatchIntelligence> {
  await hydrateDurableOps();
  const fixture = resolvePremierLeagueFixture(matchId);
  const snapshots = listLiveSnapshots({ fixtureId: fixture.id });
  const selected = selectProductionSnapshot(fixture, snapshots, now);
  const forecast = buildMatchForecast(fixture, selected);
  const timelineRows = timelineSnapshotRows(fixture, snapshots, now);
  const timeline = forecastTimeline(fixture, snapshots, now);
  const selectedIndex = timelineRows.findIndex(
    ({ snapshot }) => snapshot.provenance.uniqueKey === selected.provenance.uniqueKey
  );
  const previousRow = selectedIndex > 0
    ? timelineRows
        .slice(0, selectedIndex)
        .reverse()
        .find((row) => row.validForCurrentKickoff) ?? null
    : null;
  const previous = previousRow
    ? buildMatchForecast(previousRow.fixtureAtFreeze, previousRow.snapshot)
    : null;
  const selectedContext = frozenContextForForecast(forecast);
  const previousContext = previous ? frozenContextForForecast(previous) : null;
  const contextComparison = previousContext
    ? compareMatchContexts(previousContext, selectedContext)
    : null;
  const comparison = previous ? compareForecastSnapshots(previous, forecast) : null;
  if (comparison && contextComparison) {
    comparison.contextChanges = contextComparison.changes;
    comparison.contextComparisonStatus = contextComparison.status;
    comparison.fromContextId = contextComparison.fromContextId;
    comparison.toContextId = contextComparison.toContextId;
  }
  return {
    match: {
      id: fixture.id,
      competition: "premier-league",
      season: fixture.season,
      home: forecast.home,
      away: forecast.away,
      kickoffUtc: fixture.kickoffUtc as string,
      status: fixture.status,
    },
    forecast,
    freshness: forecastFreshness(fixture, snapshots, now),
    timeline,
    comparison,
    contextComparison,
    context: {
      atForecast: selectedContext.view,
      latest: latestContextForFixture(
        fixture,
        now,
        productionSnapshotsForMatch(fixture.id, snapshots)
      ),
      // The previous mutable news batch is intentionally not presented as
      // historical evidence: publishedAt alone does not prove first-known time.
      news: [],
      availability: {
        supported: false,
        items: [],
        note:
          "The Premier League production model has no timestamped availability input in this version, so availability is excluded rather than reconstructed from current state.",
      },
      tactics: {
        supported: false,
        items: [],
        note:
          "The Premier League production model does not read the current tactical-profile store. Historical tactical context without an auditable availability timestamp is excluded.",
      },
      temporalRule: "availableAt <= cutoffAt",
    },
    matchIntelligence: deriveMatchIntelligence({
      season: fixture.season,
      fixtureId: fixture.id,
      homeSlug: fixture.homeSlug,
      awaySlug: fixture.awaySlug,
      kickoffAt: fixture.kickoffUtc as string,
      contextCutoffAt: selectedContext.snapshot?.cutoffAt ?? forecast.cutoffAt,
      generatedAt: forecast.generatedAt,
      productionForecastId: forecast.provenance.immutableForecastId,
      contextSnapshot: selectedContext.snapshot
        ? {
            contextId: selectedContext.snapshot.contextId,
            cutoffAt: selectedContext.snapshot.cutoffAt,
            lineupOverall: selectedContext.snapshot.lineup.overall,
            evidence: selectedContext.snapshot.evidence.map((row) => ({
              evidenceId: row.evidenceId,
              kind: row.kind,
              entityId: row.entityId,
              teamSlug: row.teamSlug,
              observedAt: row.observedAt,
              fetchedAt: row.fetchedAt,
              availableAt: row.availableAt,
              sourceName: row.source.name,
              availabilityStatus: row.availabilityStatus,
              lineupStatus: row.lineupStatus,
              payload:
                row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
                  ? (row.payload as Record<string, unknown>)
                  : null,
              usedInForecast: row.usedInForecast,
            })),
          }
        : null,
      sourceAuthorization: "NONE_CONFIGURED",
    }),
    audit: forecast.provenance,
  };
}
