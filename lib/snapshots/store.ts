/**
 * Durable, immutable prediction snapshots.
 *
 * Unique key:
 *   (competition, season, fixtureId, modelVersion, asOf)
 *
 * Persistence:
 *   1. Always write to a JSONL file (survives process restart).
 *   2. Optionally replicate to the existing MongoDB connection
 *      (collection `prediction_snapshots`) when MONGODB_URI is set.
 *
 * Viewing an old snapshot MUST return the stored probabilities.
 * A later model version never overwrites an earlier key.
 */

import fs from "node:fs";
import path from "node:path";
import type { CreateSnapshotInput, PredictionSnapshot, SnapshotKey } from "./types";
import {
  canonicalizePredictionStage,
  legacySnapshotUniqueKey,
  snapshotUniqueKey,
} from "./types";

export type {
  PredictionSnapshot,
  CreateSnapshotInput,
  SnapshotKey,
  PredictionStage,
  EvaluationClass,
  CanonicalPredictionStage,
} from "./types";
export {
  snapshotUniqueKey,
  legacySnapshotUniqueKey,
  canonicalizePredictionStage,
  PREDICTION_STAGES,
} from "./types";

const DEFAULT_STORE = path.resolve(
  process.cwd(),
  "data/processed/predictions/snapshots.jsonl"
);

const LIVE_ARCHIVE = path.resolve(
  process.cwd(),
  "data/processed/premier-league/live-oos-2026-27.jsonl"
);

function storePath(): string {
  return process.env.SNAPSHOT_STORE_PATH || DEFAULT_STORE;
}

function archivePaths(): string[] {
  if (process.env.SNAPSHOT_STORE_PATH) return [];
  return [LIVE_ARCHIVE];
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value as object);
  }
  return obj;
}

function cloneFrozen(snap: PredictionSnapshot): PredictionSnapshot {
  return deepFreeze(structuredClone(snap)) as PredictionSnapshot;
}

type Mem = { byKey: Map<string, PredictionSnapshot>; loadedFrom: string | null };
const g = globalThis as unknown as { __foaSnapMem?: Mem };

function mem(): Mem {
  if (!g.__foaSnapMem) g.__foaSnapMem = { byKey: new Map(), loadedFrom: null };
  return g.__foaSnapMem;
}

function loadFromDisk(): void {
  const file = storePath();
  const state = mem();
  if (state.loadedFrom === file && state.byKey.size > 0) return;
  state.byKey.clear();
  state.loadedFrom = file;
  const files = [file, ...archivePaths()].filter((p, i, arr) => arr.indexOf(p) === i);
  for (const src of files) {
    if (!fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as PredictionSnapshot;
        const modern = snapshotUniqueKey(snap);
        const stored = snap.provenance?.uniqueKey;
        if (stored && !state.byKey.has(stored)) state.byKey.set(stored, snap);
        if (!state.byKey.has(modern)) state.byKey.set(modern, snap);
        const legacy = legacySnapshotUniqueKey(snap);
        if (legacy !== modern && !state.byKey.has(legacy)) state.byKey.set(legacy, snap);
      } catch {
        /* skip corrupt line */
      }
    }
  }
}

function appendToDisk(snap: PredictionSnapshot): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(snap)}\n`, "utf8");
}

async function replicateMongo(snap: PredictionSnapshot): Promise<void> {
  try {
    const { getMongoDb } = await import("@/lib/db/mongodb");
    const db = await getMongoDb();
    if (!db) return;
    await db.collection("prediction_snapshots").updateOne(
      { uniqueKey: snap.provenance.uniqueKey },
      { $setOnInsert: { ...snap, uniqueKey: snap.provenance.uniqueKey } },
      { upsert: true }
    );
  } catch {
    /* Mongo is optional */
  }
}

export function createSnapshot(input: CreateSnapshotInput): PredictionSnapshot {
  loadFromDisk();
  const stage = canonicalizePredictionStage(input.predictionStage);
  const keyFields: SnapshotKey = {
    competition: input.competition,
    season: input.season,
    fixtureId: input.fixtureId,
    modelVersion: input.modelVersion,
    predictionStage: stage,
    asOf: input.asOf,
  };
  const uniqueKey = snapshotUniqueKey(keyFields);
  const existing =
    mem().byKey.get(uniqueKey) ??
    mem().byKey.get(legacySnapshotUniqueKey(keyFields));
  if (existing) return cloneFrozen(existing);

  const snap: PredictionSnapshot = {
    competition: input.competition,
    season: input.season,
    fixtureId: input.fixtureId,
    homeTeam: input.homeTeam ?? input.homeSlug,
    awayTeam: input.awayTeam ?? input.awaySlug,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    kickoff: input.kickoff ?? null,
    createdAt: new Date().toISOString(),
    asOf: input.asOf,
    dataCutoff: input.asOf,
    modelVersion: input.modelVersion,
    predictionStage: stage,
    evaluationClass: input.evaluationClass,
    homeProbability: input.home,
    drawProbability: input.draw,
    awayProbability: input.away,
    homeGoalExpectation: input.homeExpectedGoals,
    awayGoalExpectation: input.awayExpectedGoals,
    scorelineDistribution: { ...input.scorelineDistribution },
    modelParameters: { ...(input.modelParameters ?? {}) },
    sourceState: { ...(input.sourceState ?? {}) },
    provenance: {
      store: "file",
      uniqueKey,
      notes:
        input.provenanceNotes ??
        "First write wins. Key = competition+season+fixtureId+modelVersion+predictionStage+asOf. Stored probabilities are never recomputed.",
    },
    market: null,
    home: input.home,
    draw: input.draw,
    away: input.away,
    homeExpectedGoals: input.homeExpectedGoals,
    awayExpectedGoals: input.awayExpectedGoals,
  };

  mem().byKey.set(uniqueKey, snap);
  appendToDisk(snap);
  void replicateMongo(snap);
  return cloneFrozen(snap);
}

export function getSnapshotByKey(key: SnapshotKey): PredictionSnapshot | null {
  loadFromDisk();
  const found =
    mem().byKey.get(snapshotUniqueKey(key)) ??
    mem().byKey.get(legacySnapshotUniqueKey(key));
  return found ? cloneFrozen(found) : null;
}

/** Look up by fixture + version + optional season/asOf. Prefer getSnapshotByKey. */
export function getSnapshot(
  fixtureId: string,
  modelVersion?: string,
  extra?: { season?: string; asOf?: string; competition?: SnapshotKey["competition"] }
): PredictionSnapshot | null {
  loadFromDisk();
  const matches = [...mem().byKey.values()].filter((s) => {
    if (s.fixtureId !== fixtureId) return false;
    if (modelVersion && s.modelVersion !== modelVersion) return false;
    if (extra?.season && s.season !== extra.season) return false;
    if (extra?.asOf && s.asOf !== extra.asOf) return false;
    if (extra?.competition && s.competition !== extra.competition) return false;
    return true;
  });
  if (!matches.length) return null;
  return cloneFrozen(matches[matches.length - 1]);
}

export function listSnapshots(): PredictionSnapshot[] {
  loadFromDisk();
  return [...mem().byKey.values()].map(cloneFrozen);
}

/** Drop the in-process cache. Disk remains. Used to simulate a restart. */
export function resetSnapshotCache(): void {
  g.__foaSnapMem = { byKey: new Map(), loadedFrom: null };
}

/** Test-only: wipe cache AND the configured store file. */
export function clearSnapshotsForTests(): void {
  resetSnapshotCache();
  const file = storePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Append LIVE_OOS snapshots to the committed archive (production ingest only). */
export function archiveLiveOosSnapshots(snaps: PredictionSnapshot[]): void {
  if (!snaps.length) return;
  fs.mkdirSync(path.dirname(LIVE_ARCHIVE), { recursive: true });
  const existing = new Set<string>();
  if (fs.existsSync(LIVE_ARCHIVE)) {
    for (const line of fs.readFileSync(LIVE_ARCHIVE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as PredictionSnapshot;
        existing.add(s.provenance.uniqueKey);
      } catch {
        /* skip */
      }
    }
  }
  const lines = snaps
    .filter((s) => s.evaluationClass === "LIVE_OOS" && !existing.has(s.provenance.uniqueKey))
    .map((s) => JSON.stringify(s));
  if (lines.length) fs.appendFileSync(LIVE_ARCHIVE, `${lines.join("\n")}\n`, "utf8");
}

export function assertImmutable(original: PredictionSnapshot, candidate: PredictionSnapshot): boolean {
  return (
    original.home === candidate.home &&
    original.draw === candidate.draw &&
    original.away === candidate.away &&
    original.homeProbability === candidate.homeProbability &&
    original.modelVersion === candidate.modelVersion &&
    original.asOf === candidate.asOf &&
    original.season === candidate.season &&
    original.fixtureId === candidate.fixtureId
  );
}

export function snapshotPersistenceGuarantee(): string {
  return [
    "Snapshots are keyed by (competition, season, fixtureId, modelVersion, predictionStage, asOf).",
    "First write wins; later writes with the same key return the original numbers.",
    "Returned objects are deep-frozen clones; mutating them does not change the store.",
    "The JSONL file at SNAPSHOT_STORE_PATH (default data/processed/predictions/snapshots.jsonl) survives process restart.",
    "MongoDB collection prediction_snapshots is an optional replica when MONGODB_URI is set.",
    "A later model version is a different key and never overwrites an older snapshot.",
    "Phase 1 snapshots without predictionStage still resolve via the legacy 5-part key.",
  ].join(" ");
}
