/**
 * Canonical public metrics for the Premier League LIVE_OOS ledger.
 *
 * Every count carries an explicit unit and model-track scope. A forecast
 * snapshot is identified by its immutable six-part snapshot key; a fixture is
 * counted once no matter how many forecast stages were frozen for it.
 */

import { loadCommittedLiveOos, type PredictionSnapshot } from "@/lib/snapshots/store";
import { canonicalizePredictionStage, snapshotUniqueKey } from "@/lib/snapshots/types";
import { loadSettlements, type SettlementRecord } from "./settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { listLiveSnapshots } from "./ops/live-snapshot-reader";
import { productionModelVersion, SHADOW_MODEL_VERSION } from "./shadow/track";

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
  schemaVersion: "pl-ledger-metrics-v1";
  competition: "premier-league";
  season: string;
  evaluationClass: "LIVE_OOS";
  productionModelVersion: string;
  shadowModelVersion: string;
  production: ForecastTrackMetrics;
  shadow: ForecastTrackMetrics;
  allTracks: ForecastTrackMetrics;
  settlements: {
    /** Unique persisted rows after the settlement store's first-write-wins dedupe. */
    persistedSnapshotSettlementRecords: number;
    /** Persisted rows that resolve to a canonical LIVE_OOS snapshot in this season. */
    linkedForecastSnapshotRecords: number;
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
  const linkedSettlements = settlements.filter((settlement) => {
    const snapshot = snapshotByKey.get(settlement.snapshotUniqueKey);
    return (
      snapshot !== undefined &&
      snapshot.fixtureId === settlement.fixtureId &&
      snapshot.modelVersion === settlement.modelVersion
    );
  });
  const settlementByKey = new Map(
    linkedSettlements.map((settlement) => [settlement.snapshotUniqueKey, settlement])
  );

  const productionSnapshots = snapshots.filter(
    (snapshot) => snapshot.modelVersion === productionVersion
  );
  const shadowSnapshots = snapshots.filter((snapshot) => snapshot.modelVersion === shadowVersion);

  return {
    schemaVersion: "pl-ledger-metrics-v1",
    competition: "premier-league",
    season: input.season,
    evaluationClass: "LIVE_OOS",
    productionModelVersion: productionVersion,
    shadowModelVersion: shadowVersion,
    production: trackMetrics({
      role: "production",
      snapshots: productionSnapshots,
      settlementByKey,
      committedKeys,
    }),
    shadow: trackMetrics({
      role: "shadow",
      snapshots: shadowSnapshots,
      settlementByKey,
      committedKeys,
    }),
    allTracks: trackMetrics({
      role: "all-tracks",
      snapshots,
      settlementByKey,
      committedKeys,
    }),
    settlements: {
      persistedSnapshotSettlementRecords: settlements.length,
      linkedForecastSnapshotRecords: linkedSettlements.length,
      orphanSettlementRecords: settlements.length - linkedSettlements.length,
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
  });
}
