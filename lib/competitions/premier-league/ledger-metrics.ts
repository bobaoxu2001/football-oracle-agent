/**
 * Canonical public metrics for the Premier League LIVE_OOS ledger.
 *
 * Every count carries an explicit unit and model-track scope. A forecast
 * snapshot is identified by its immutable six-part snapshot key; a fixture is
 * counted once no matter how many forecast stages were frozen for it.
 */

import { loadCommittedLiveOos, type PredictionSnapshot } from "@/lib/snapshots/store";
import {
  canonicalizePredictionStage,
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
  snapshotUniqueKey,
} from "@/lib/snapshots/types";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { listLiveSnapshots } from "./ops/live-snapshot-reader";
import { productionModelVersion, SHADOW_MODEL_VERSION } from "./shadow/track";
import {
  assessEvaluationMaturity,
  type EvaluationMaturityAssessment,
} from "@/lib/evaluation/evidence-integrity";
import { validateSettlementSnapshotConsistency } from "@/lib/evaluation/settlement-integrity";
import { liveFixtures } from "./fixture-store";
import {
  validateProductionForecastSnapshot,
  type ForecastFreshnessSnapshotInput,
} from "./ops/production-freshness";

export type LedgerTrackRole = "production" | "shadow" | "all-tracks";

export interface LedgerStageMetrics {
  stage: string;
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  uniqueFixturesForecast: number;
  uniqueFixturesSettled: number;
}

export interface ForecastTrackMetrics {
  role: LedgerTrackRole;
  modelVersions: string[];
  totalForecastSnapshots: number;
  settledForecastSnapshots: number;
  unsettledForecastSnapshots: number;
  uniqueFixturesForecast: number;
  uniqueFixturesSettled: number;
  committedForecastSnapshots: number;
  operationalForecastSnapshots: number;
  byStage: LedgerStageMetrics[];
}

export interface CanonicalLedgerMetrics {
  schemaVersion: "pl-ledger-metrics-v3";
  competition: "premier-league";
  season: string;
  evaluationClass: "LIVE_OOS";
  productionModelVersion: string;
  shadowModelVersion: string;
  production: ForecastTrackMetrics;
  shadow: ForecastTrackMetrics;
  allTracks: ForecastTrackMetrics;
  evaluationMaturity: {
    /** Production evidence volume only; this is not a quality or edge claim. */
    production: EvaluationMaturityAssessment;
    /** Shadow-track settled fixtures, not necessarily valid paired comparison evidence. */
    shadowTrack: EvaluationMaturityAssessment;
    note: string;
  };
  settlements: {
    /** Settlement integrity is evaluated across production and shadow tracks. */
    scope: "all-tracks";
    /** Unique persisted rows after the settlement store's first-write-wins dedupe. */
    persistedSnapshotSettlementRecords: number;
    /** Persisted rows that resolve to a canonical LIVE_OOS snapshot in this season. */
    linkedForecastSnapshotRecords: number;
    /** Rows whose key resolves but whose stage/probabilities/provenance disagree. */
    inconsistentLinkedSettlementRecords: number;
    orphanSettlementRecords: number;
    /**
     * A settlement row is not a settlement operation. No durable operation-event
     * ledger exists yet, so an event count must remain explicitly unavailable.
     */
    successfulSettlementEvents: null;
    eventCountStatus: "unavailable";
    eventCountNote: string;
  };
}

export interface CanonicalLedgerMetricInput {
  season: string;
  snapshots: PredictionSnapshot[];
  committedSnapshots: PredictionSnapshot[];
  settlements: SettlementRecord[];
  productionVersion?: string;
  shadowVersion?: string;
  /** Current canonical kickoff per fixture, used to reject obsolete evidence. */
  fixtureKickoffs?: Record<string, string | null>;
}

function identityOf(snapshot: PredictionSnapshot): string {
  return snapshot.provenance?.uniqueKey || snapshotUniqueKey(snapshot);
}

function dedupeSnapshots(rows: PredictionSnapshot[]): PredictionSnapshot[] {
  const byKey = new Map<string, PredictionSnapshot>();
  for (const row of rows) {
    const key = identityOf(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function scopeSnapshots(rows: PredictionSnapshot[], season: string): PredictionSnapshot[] {
  return dedupeSnapshots(rows).filter(
    (row) =>
      row.competition === "premier-league" &&
      row.season === season &&
      row.evaluationClass === "LIVE_OOS"
  );
}

function scopeSettlements(rows: SettlementRecord[], season: string): SettlementRecord[] {
  const byKey = new Map<string, SettlementRecord>();
  for (const row of rows) {
    if (row.season !== season || row.evaluationClass !== "LIVE_OOS") continue;
    if (!byKey.has(row.snapshotUniqueKey)) byKey.set(row.snapshotUniqueKey, row);
  }
  return [...byKey.values()];
}

function orderedStages(rows: PredictionSnapshot[]): string[] {
  const preferred = [
    "PRESEASON",
    "EARLY",
    "T7D",
    "T24H",
    "T2H",
    "T60M",
    "FINAL_PREKICK",
  ];
  const seen = new Set<string>(
    rows.map((row) => canonicalizePredictionStage(row.predictionStage))
  );
  const extra = [...seen].filter((stage) => !preferred.includes(stage)).sort();
  return [...preferred, ...extra];
}

function trackMetrics(input: {
  role: LedgerTrackRole;
  snapshots: PredictionSnapshot[];
  settlementByKey: Map<string, SettlementRecord>;
  committedKeys: Set<string>;
}): ForecastTrackMetrics {
  const snapshots = dedupeSnapshots(input.snapshots);
  const snapshotKeys = new Set(snapshots.map(identityOf));
  const settledSnapshots = snapshots.filter((snapshot) =>
    input.settlementByKey.has(identityOf(snapshot))
  );
  const modelVersions = [...new Set(snapshots.map((snapshot) => snapshot.modelVersion))].sort();

  const byStage = orderedStages(snapshots).map((stage) => {
    const stageSnapshots = snapshots.filter(
      (snapshot) => canonicalizePredictionStage(snapshot.predictionStage) === stage
    );
    const stageSettled = stageSnapshots.filter((snapshot) =>
      input.settlementByKey.has(identityOf(snapshot))
    );
    return {
      stage,
      totalForecastSnapshots: stageSnapshots.length,
      settledForecastSnapshots: stageSettled.length,
      uniqueFixturesForecast: new Set(stageSnapshots.map((snapshot) => snapshot.fixtureId)).size,
      uniqueFixturesSettled: new Set(stageSettled.map((snapshot) => snapshot.fixtureId)).size,
    };
  });

  const committedForecastSnapshots = snapshots.filter((snapshot) =>
    input.committedKeys.has(identityOf(snapshot))
  ).length;

  return {
    role: input.role,
    modelVersions,
    totalForecastSnapshots: snapshotKeys.size,
    settledForecastSnapshots: settledSnapshots.length,
    unsettledForecastSnapshots: Math.max(0, snapshotKeys.size - settledSnapshots.length),
    uniqueFixturesForecast: new Set(snapshots.map((snapshot) => snapshot.fixtureId)).size,
    uniqueFixturesSettled: new Set(settledSnapshots.map((snapshot) => snapshot.fixtureId)).size,
    committedForecastSnapshots,
    operationalForecastSnapshots: Math.max(0, snapshotKeys.size - committedForecastSnapshots),
    byStage,
  };
}

function validSettledFixtureCount(input: {
  snapshots: PredictionSnapshot[];
  settlementByKey: Map<string, SettlementRecord>;
  fixtureKickoffs: Record<string, string | null>;
}): number {
  const fixtures = new Set<string>();
  for (const snapshot of input.snapshots) {
    const settlement = input.settlementByKey.get(identityOf(snapshot));
    if (!settlement) continue;
    const expectedKickoffUtc =
      input.fixtureKickoffs[snapshot.fixtureId] ?? snapshot.kickoff;
    if (!expectedKickoffUtc) continue;
    const freshnessSnapshot: ForecastFreshnessSnapshotInput = {
      snapshotId: identityOf(snapshot),
      fixtureId: snapshot.fixtureId,
      modelRole: "production",
      modelVersion: snapshot.modelVersion,
      evaluationClass: snapshot.evaluationClass ?? null,
      predictionStage: String(snapshot.predictionStage),
      kickoffUtc: snapshot.kickoff,
      cutoffAt: snapshot.asOf,
      generatedAt: effectiveSnapshotGeneratedAt(snapshot),
      latestIncludedInputAt: effectiveSnapshotLatestIncludedInputAt(snapshot),
    };
    if (
      validateProductionForecastSnapshot({
        snapshot: freshnessSnapshot,
        expectedKickoffUtc,
        evaluatedAt: settlement.settledAt,
      }).valid
    ) {
      fixtures.add(snapshot.fixtureId);
    }
  }
  return fixtures.size;
}

/** Pure builder used by regression tests and the runtime reader. */
export function buildCanonicalLedgerMetrics(
  input: CanonicalLedgerMetricInput
): CanonicalLedgerMetrics {
  const productionVersion = input.productionVersion ?? productionModelVersion();
  const shadowVersion = input.shadowVersion ?? SHADOW_MODEL_VERSION;
  const snapshots = scopeSnapshots(input.snapshots, input.season);
  const committed = scopeSnapshots(input.committedSnapshots, input.season);
  const committedKeys = new Set(committed.map(identityOf));
  const settlements = scopeSettlements(input.settlements, input.season);
  const snapshotByKey = new Map(snapshots.map((snapshot) => [identityOf(snapshot), snapshot]));
  const resolvedSettlements = settlements.filter((settlement) =>
    snapshotByKey.has(settlement.snapshotUniqueKey)
  );
  const linkedSettlements = resolvedSettlements.filter((settlement) => {
    const snapshot = snapshotByKey.get(settlement.snapshotUniqueKey);
    return snapshot !== undefined &&
      validateSettlementSnapshotConsistency(settlement, snapshot).consistent;
  });
  const settlementByKey = new Map(
    linkedSettlements.map((settlement) => [settlement.snapshotUniqueKey, settlement])
  );

  const productionSnapshots = snapshots.filter(
    (snapshot) => snapshot.modelVersion === productionVersion
  );
  const shadowSnapshots = snapshots.filter((snapshot) => snapshot.modelVersion === shadowVersion);

  const production = trackMetrics({
    role: "production",
    snapshots: productionSnapshots,
    settlementByKey,
    committedKeys,
  });
  const shadow = trackMetrics({
    role: "shadow",
    snapshots: shadowSnapshots,
    settlementByKey,
    committedKeys,
  });
  const allTracks = trackMetrics({
    role: "all-tracks",
    snapshots,
    settlementByKey,
    committedKeys,
  });
  const fixtureKickoffs = input.fixtureKickoffs ?? {};
  const productionEvaluationFixtures = validSettledFixtureCount({
    snapshots: productionSnapshots,
    settlementByKey,
    fixtureKickoffs,
  });
  const shadowEvaluationFixtures = validSettledFixtureCount({
    snapshots: shadowSnapshots,
    settlementByKey,
    fixtureKickoffs,
  });

  return {
    schemaVersion: "pl-ledger-metrics-v3",
    competition: "premier-league",
    season: input.season,
    evaluationClass: "LIVE_OOS",
    productionModelVersion: productionVersion,
    shadowModelVersion: shadowVersion,
    production,
    shadow,
    allTracks,
    evaluationMaturity: {
      production: assessEvaluationMaturity(productionEvaluationFixtures),
      shadowTrack: assessEvaluationMaturity(shadowEvaluationFixtures),
      note:
        "Maturity is based on unique settled fixtures with canonical valid pre-kick stage evidence, never forecast-snapshot or settlement-row counts. Raw linked settled-fixture volume remains separately reported. EVALUATION_READY permits a first formal evaluation; it does not prove accuracy or market edge.",
    },
    settlements: {
      scope: "all-tracks",
      persistedSnapshotSettlementRecords: settlements.length,
      linkedForecastSnapshotRecords: linkedSettlements.length,
      inconsistentLinkedSettlementRecords:
        resolvedSettlements.length - linkedSettlements.length,
      orphanSettlementRecords: settlements.length - resolvedSettlements.length,
      successfulSettlementEvents: null,
      eventCountStatus: "unavailable",
      eventCountNote:
        "Settlement rows are keyed by immutable forecast snapshot. No durable settlement-operation event ledger exists, so an operation count is not inferred from row count.",
    },
  };
}

/** Single runtime source of truth for every public production-ledger surface. */
export function canonicalLedgerMetrics(
  season = PREMIER_LEAGUE_CURRENT_SEASON
): CanonicalLedgerMetrics {
  return buildCanonicalLedgerMetrics({
    season,
    snapshots: listLiveSnapshots({ season, evaluationClass: "LIVE_OOS" }),
    committedSnapshots: loadCommittedLiveOos(),
    settlements: loadSettlements(),
    fixtureKickoffs: Object.fromEntries(
      liveFixtures().map((fixture) => [
        fixture.id,
        fixture.kickoffUtc ?? fixture.kickoff ?? null,
      ])
    ),
  });
}
