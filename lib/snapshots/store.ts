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
  canonicalSnapshotIdentity,
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
  canonicalSnapshotIdentity,
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

export function canonicalLiveTapePath(): string {
  return LIVE_ARCHIVE;
}

/**
 * WRITE destination for LIVE_OOS archiving.
 *
 * LIVE_OOS_ARCHIVE_PATH is a write-redirect, not a store swap: it exists so a
 * test can archive rows without any chance of touching the canonical tape.
 * Reads of the committed ledger deliberately ignore it — see
 * {@link loadCommittedLiveOos}.
 */
function liveArchivePath(): string {
  return process.env.LIVE_OOS_ARCHIVE_PATH || LIVE_ARCHIVE;
}

function archivePaths(): string[] {
  if (process.env.SNAPSHOT_STORE_PATH) return [];
  return [liveArchivePath()];
}

export function isCanonicalLiveTapePath(file: string): boolean {
  return path.resolve(file) === path.resolve(LIVE_ARCHIVE);
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

type Mem = {
  /** One entry per canonical identity. Enumeration uses this map only. */
  byUniqueKey: Map<string, PredictionSnapshot>;
  /** Lookup aliases (legacy 5-part keys, stored uniqueKey) → canonical identity. */
  aliases: Map<string, string>;
  loadedFrom: string | null;
};
const g = globalThis as unknown as { __foaSnapMem?: Mem };

function mem(): Mem {
  if (!g.__foaSnapMem) {
    g.__foaSnapMem = { byUniqueKey: new Map(), aliases: new Map(), loadedFrom: null };
  }
  return g.__foaSnapMem;
}

function indexSnapshot(state: Mem, snap: PredictionSnapshot): void {
  const unique = snap.provenance?.uniqueKey || snapshotUniqueKey(snap);
  if (!state.byUniqueKey.has(unique)) state.byUniqueKey.set(unique, snap);
  state.aliases.set(unique, unique);
  const modern = snapshotUniqueKey(snap);
  if (!state.aliases.has(modern)) state.aliases.set(modern, unique);
  const legacy = legacySnapshotUniqueKey(snap);
  if (!state.aliases.has(legacy)) state.aliases.set(legacy, unique);
}

function lookup(state: Mem, key: string): PredictionSnapshot | undefined {
  const unique = state.aliases.get(key) ?? (state.byUniqueKey.has(key) ? key : undefined);
  return unique ? state.byUniqueKey.get(unique) : undefined;
}

function loadFromDisk(): void {
  const file = storePath();
  const state = mem();
  if (state.loadedFrom === file && state.byUniqueKey.size > 0) return;
  state.byUniqueKey.clear();
  state.aliases.clear();
  state.loadedFrom = file;
  const files = [file, ...archivePaths()].filter((p, i, arr) => arr.indexOf(p) === i);
  for (const src of files) {
    if (!fs.existsSync(src)) continue;
    const text = fs.readFileSync(src, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        indexSnapshot(state, JSON.parse(line) as PredictionSnapshot);
      } catch {
        /* skip corrupt line */
      }
    }
  }
}

function appendToDisk(snap: PredictionSnapshot): void {
  const file = storePath();
  if (isCanonicalLiveTapePath(file)) {
    throw new Error(
      "Refusing to write the working snapshot store onto the canonical LIVE_OOS tape. That file is append-protected evidence."
    );
  }
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
  const state = mem();
  // Existence is canonical-key only. Legacy 5-part aliases omit predictionStage
  // and must not collapse PRESEASON vs T24H writes into one observation.
  const existing = lookup(state, uniqueKey);
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

  indexSnapshot(mem(), snap);
  appendToDisk(snap);
  void replicateMongo(snap);
  return cloneFrozen(snap);
}

export function getSnapshotByKey(key: SnapshotKey): PredictionSnapshot | null {
  loadFromDisk();
  const state = mem();
  const found = lookup(state, snapshotUniqueKey(key)) ?? lookup(state, legacySnapshotUniqueKey(key));
  return found ? cloneFrozen(found) : null;
}

/** Look up by fixture + version + optional season/asOf. Prefer getSnapshotByKey. */
export function getSnapshot(
  fixtureId: string,
  modelVersion?: string,
  extra?: { season?: string; asOf?: string; competition?: SnapshotKey["competition"] }
): PredictionSnapshot | null {
  loadFromDisk();
  const matches = [...mem().byUniqueKey.values()].filter((s) => {
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
  return [...mem().byUniqueKey.values()].map(cloneFrozen);
}

/** Diagnostic: alias/index references vs unique observations. */
export function snapshotIndexStats(): {
  rawReferences: number;
  uniqueSnapshots: number;
  duplicatesSuppressed: number;
} {
  loadFromDisk();
  const uniqueSnapshots = mem().byUniqueKey.size;
  const rawReferences = mem().aliases.size;
  return {
    rawReferences,
    uniqueSnapshots,
    duplicatesSuppressed: Math.max(0, rawReferences - uniqueSnapshots),
  };
}

/** Drop the in-process cache. Disk remains. Used to simulate a restart. */
export function resetSnapshotCache(): void {
  g.__foaSnapMem = { byUniqueKey: new Map(), aliases: new Map(), loadedFrom: null };
}

/** Test-only: wipe cache AND the configured store file. Never touches the canonical tape. */
export function clearSnapshotsForTests(): void {
  resetSnapshotCache();
  const file = storePath();
  if (isCanonicalLiveTapePath(file)) {
    throw new Error("Refusing to delete the canonical LIVE_OOS tape.");
  }
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function refuseDestructiveLiveTapeWrite(op = "replace/truncate"): never {
  throw new Error(
    `Destructive ${op} of the canonical LIVE_OOS tape is forbidden. The 380 committed observations are append-only evidence.`
  );
}

export function replaceCanonicalLiveTape(): never {
  return refuseDestructiveLiveTapeWrite("replace");
}

function existingArchiveKeys(file: string): Set<string> {
  const existing = new Set<string>();
  if (!fs.existsSync(file)) return existing;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as PredictionSnapshot;
      existing.add(s.provenance?.uniqueKey || snapshotUniqueKey(s));
    } catch {
      /* skip */
    }
  }
  return existing;
}

/**
 * Append LIVE_OOS snapshots to an archive. Idempotent.
 * Same unique identity is never written twice. The committed 380-line tape
 * rejects new keys unless LIVE_OOS_ARCHIVE_ALLOW_APPEND=1.
 */
export function archiveLiveOosSnapshots(snaps: PredictionSnapshot[]): {
  uniqueBefore: number;
  uniqueAfter: number;
  appended: number;
} {
  const dest = liveArchivePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const existing = existingArchiveKeys(dest);
  const uniqueBefore = existing.size;
  const seenBatch = new Set<string>();
  const lines: string[] = [];
  for (const s of snaps) {
    if (s.evaluationClass !== "LIVE_OOS") continue;
    const key = s.provenance?.uniqueKey || snapshotUniqueKey(s);
    if (existing.has(key) || seenBatch.has(key)) continue;
    seenBatch.add(key);
    lines.push(JSON.stringify(s));
    existing.add(key);
  }
  if (lines.length && isCanonicalLiveTapePath(dest) && process.env.LIVE_OOS_ARCHIVE_ALLOW_APPEND !== "1") {
    throw new Error(
      `Refusing to append ${lines.length} new key(s) to the canonical LIVE_OOS tape. Re-archive is a no-op unless LIVE_OOS_ARCHIVE_ALLOW_APPEND=1.`
    );
  }
  if (lines.length) fs.appendFileSync(dest, `${lines.join("\n")}\n`, "utf8");
  return { uniqueBefore, uniqueAfter: existing.size, appended: lines.length };
}

/**
 * Load unique LIVE_OOS rows from the committed tape only.
 *
 * Pinned to LIVE_ARCHIVE on purpose — NOT liveArchivePath(). The committed
 * ledger is a fixed, hash-audited artifact, so "what has been committed" must
 * answer the same in every environment; a redirected write path must never be
 * able to fabricate a different committed history. Suites that redirect writes
 * still read the real tape here, and verify its md5/sha is unchanged.
 * Working/timed rows live in the operational archive instead.
 */
export function loadCommittedLiveOos(): PredictionSnapshot[] {
  const file = LIVE_ARCHIVE;
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
  return [...byKey.values()].map(cloneFrozen);
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
    "listSnapshots returns unique observations (canonical identity), not alias/index references.",
    "The committed live-oos-2026-27.jsonl tape cannot be truncated or replaced.",
  ].join(" ");
}
