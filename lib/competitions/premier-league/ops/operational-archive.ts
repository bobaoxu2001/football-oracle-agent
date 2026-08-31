/**
 * Append-only operational LIVE_OOS archive.
 * Never points at the canonical 380-line tape.
 */

import fs from "node:fs";
import path from "node:path";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { canonicalizePredictionStage, snapshotUniqueKey } from "@/lib/snapshots/types";
import { isCanonicalLiveTapePath } from "@/lib/snapshots/store";
import { operationalLiveOosPath } from "./paths";
import type { TimedStage } from "./types";

function dest(): string {
  const file = operationalLiveOosPath();
  if (isCanonicalLiveTapePath(file)) {
    throw new Error("Refusing to use the canonical LIVE_OOS tape as the operational archive.");
  }
  return file;
}

function existingRows(file: string): Map<string, string> {
  const rows = new Map<string, string>();
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as PredictionSnapshot;
      const key = s.provenance?.uniqueKey || snapshotUniqueKey(s);
      if (!rows.has(key)) rows.set(key, JSON.stringify(s));
    } catch {
      /* skip */
    }
  }
  return rows;
}

export function archiveOperationalLiveOos(snaps: PredictionSnapshot[]): { appended: number } {
  const file = dest();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = existingRows(file);
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.evaluationClass !== "LIVE_OOS") continue;
    const key = s.provenance?.uniqueKey || snapshotUniqueKey(s);
    const candidate = JSON.stringify(s);
    const prior = existing.get(key);
    if (prior !== undefined) {
      if (prior !== candidate) {
        throw new Error(`Immutable operational snapshot conflict for ${key}`);
      }
      continue;
    }
    existing.set(key, candidate);
    lines.push(candidate);
  }
  if (lines.length) fs.appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { appended: lines.length };
}

export function loadOperationalLiveOos(): PredictionSnapshot[] {
  const file = dest();
  if (!fs.existsSync(file)) return [];
  const byKey = new Map<string, PredictionSnapshot>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as PredictionSnapshot;
      const key = s.provenance?.uniqueKey || snapshotUniqueKey(s);
      if (!byKey.has(key)) byKey.set(key, s);
    } catch {
      /* skip */
    }
  }
  return [...byKey.values()];
}

export type ScheduledSnapshotIndex = ReadonlyMap<string, PredictionSnapshot>;

function scheduledSnapshotIndexKey(input: {
  fixtureId: string;
  stage: string;
  modelVersion: string;
  plannedAsOf: string;
}): string {
  return JSON.stringify([
    input.fixtureId,
    input.stage,
    input.modelVersion,
    input.plannedAsOf,
  ]);
}

/** Build once per scheduler pass so the immutable archive is parsed only once. */
export function indexScheduledSnapshots(
  snapshots = loadOperationalLiveOos()
): ScheduledSnapshotIndex {
  const index = new Map<string, PredictionSnapshot>();
  for (const snapshot of snapshots) {
    const stage = canonicalizePredictionStage(snapshot.predictionStage);
    const key = scheduledSnapshotIndexKey({
      fixtureId: snapshot.fixtureId,
      stage,
      modelVersion: snapshot.modelVersion,
      plannedAsOf: snapshot.asOf,
    });
    // Preserve the historical first-row-wins lookup behavior.
    if (!index.has(key)) index.set(key, snapshot);
  }
  return index;
}

export function findScheduledSnapshot(input: {
  fixtureId: string;
  stage: TimedStage;
  modelVersion: string;
  plannedAsOf: string;
}, index = indexScheduledSnapshots()): PredictionSnapshot | null {
  return index.get(
    scheduledSnapshotIndexKey({
      fixtureId: input.fixtureId,
      stage: input.stage,
      modelVersion: input.modelVersion,
      plannedAsOf: input.plannedAsOf,
    })
  ) ?? null;
}
