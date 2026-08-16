/**
 * Composite LIVE snapshot reader.
 *
 * Settlement and live performance must see the union of:
 *   FrozenBaseSnapshotStore  — the immutable committed 380-row tape
 *   OperationalSnapshotStore — timed / later LIVE_OOS rows (archive + working store)
 *
 * The tape is never copied into Mongo. Identity is the audited 6-part key.
 */

import {
  listSnapshots,
  loadCommittedLiveOos,
  snapshotUniqueKey,
  type PredictionSnapshot,
} from "@/lib/snapshots/store";
import {
  canonicalSnapshotIdentity,
  type EvaluationClass,
} from "@/lib/snapshots/types";
import { loadOperationalLiveOos } from "./operational-archive";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";

export function liveSnapshotIdentity(
  snap: Pick<
    PredictionSnapshot,
    "competition" | "season" | "fixtureId" | "modelVersion" | "predictionStage" | "asOf"
  >
): string {
  return canonicalSnapshotIdentity(snap);
}

function identityOf(snap: PredictionSnapshot): string {
  return snap.provenance?.uniqueKey || snapshotUniqueKey(snap);
}

export interface LiveSnapshotFilter {
  season?: string;
  fixtureId?: string;
  evaluationClass?: EvaluationClass;
}

export interface LiveSnapshotUniverse {
  snapshots: PredictionSnapshot[];
  committed: number;
  operational: number;
  total: number;
}

function matchesFilter(snap: PredictionSnapshot, filter: LiveSnapshotFilter): boolean {
  if (filter.fixtureId && snap.fixtureId !== filter.fixtureId) return false;
  if (filter.season && snap.season !== filter.season) return false;
  if (filter.evaluationClass && (snap.evaluationClass ?? null) !== filter.evaluationClass) {
    return false;
  }
  return true;
}

/**
 * Canonical unique LIVE_OOS universe for a season.
 * Frozen tape rows win when the same identity appears in an operational store.
 */
export function liveSnapshotUniverse(
  season = PREMIER_LEAGUE_CURRENT_SEASON
): LiveSnapshotUniverse {
  const committed = loadCommittedLiveOos().filter((s) => !season || s.season === season);
  const operationalArchive = loadOperationalLiveOos().filter((s) => {
    if (s.evaluationClass !== "LIVE_OOS") return false;
    return !season || s.season === season;
  });

  const byKey = new Map<string, PredictionSnapshot>();
  for (const snap of committed) byKey.set(identityOf(snap), snap);
  for (const snap of operationalArchive) {
    const key = identityOf(snap);
    if (!byKey.has(key)) byKey.set(key, snap);
  }

  const committedKeys = new Set(committed.map(identityOf));
  const operationalKeys = new Set<string>();
  for (const snap of operationalArchive) {
    const key = identityOf(snap);
    if (!committedKeys.has(key)) operationalKeys.add(key);
  }

  return {
    snapshots: [...byKey.values()],
    committed: committed.length,
    operational: operationalKeys.size,
    total: byKey.size,
  };
}

/**
 * Settlement enumerator: frozen tape + operational archive + working store.
 * Deduped by canonical identity. Optional class/fixture/season filters.
 */
export function listLiveSnapshots(filter: LiveSnapshotFilter = {}): PredictionSnapshot[] {
  const byKey = new Map<string, PredictionSnapshot>();
  for (const snap of loadCommittedLiveOos()) {
    if (!matchesFilter(snap, filter)) continue;
    byKey.set(identityOf(snap), snap);
  }
  for (const snap of loadOperationalLiveOos()) {
    if (!matchesFilter(snap, filter)) continue;
    const key = identityOf(snap);
    if (!byKey.has(key)) byKey.set(key, snap);
  }
  for (const snap of listSnapshots()) {
    if (!matchesFilter(snap, filter)) continue;
    const key = identityOf(snap);
    if (!byKey.has(key)) byKey.set(key, snap);
  }
  return [...byKey.values()];
}
