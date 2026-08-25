/**
 * Ops persistence backends.
 *
 * FileOpsStore — local JSONL (Phase 2A.2 default; tests).
 * ProductionPersistentOpsStore — MongoDB Atlas (Vercel) or a JSON bundle
 * (isolated durable-contract tests). Never writes the frozen 380-line tape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyBulkWriteOperation, Db } from "mongodb";
import { getMongoDb } from "@/lib/db/mongodb";
import { isCanonicalLiveTapePath, resetSnapshotCache } from "@/lib/snapshots/store";
import {
  assertMatchContextIntegrity,
  type MatchContextSnapshot,
} from "../context";
import { resetSeasonBundleCache } from "../fixture-store";
import { compactPersistedSourceObservations } from "./fixture-sync";
import { resetJobCache } from "./job-ledger";
import { compactPersistedResultObservations } from "./result-feed";
import { resetRatingEventCache } from "./rating-events";
import { resetContextSnapshotStoreCache } from "./context-snapshots";
import {
  clubSeasonsPath,
  contextSnapshotPath,
  liveFixturesPath,
  operationalLiveOosPath,
  opsDir,
  predictionJobPath,
  ratingEventPath,
  ratingStateSnapshotPath,
  resultObservationPath,
  resultVerificationPath,
  scheduleRevisionPath,
  seasonManifestPath,
  settlementCorrectionPath,
  sourceObservationPath,
  tickStatePath,
} from "./paths";

export type OpsBackendKind = "file" | "mongo" | "bundle";

const COMMITTED_ROOT = path.resolve(process.cwd(), "data/processed/premier-league");
const OPS_BUNDLE_COLLECTION = "pl_ops_bundle";
const CONTEXT_SNAPSHOT_COLLECTION = "pl_match_context_snapshots";
const BUNDLE_KEYS = [
  "jobs",
  "sourceObservations",
  "scheduleRevisions",
  "resultObservations",
  "resultVerifications",
  "ratingEvents",
  "ratingState",
  "tickState",
  "settlementCorrections",
  "operationalLiveOos",
  "settlements",
  "workingSnapshots",
  "contextSnapshots",
  "fixturesOverlay",
] as const;

type DurableBundleKey = (typeof BUNDLE_KEYS)[number];
/** contextSnapshots is optional when reading pre-Phase-4B bundles. */
export type DurableBundle = Omit<Record<DurableBundleKey, string>, "contextSnapshots"> & {
  contextSnapshots?: string;
};

export function opsBackend(): OpsBackendKind {
  const forced = process.env.PL_OPS_BACKEND;
  if (forced === "file" || forced === "mongo" || forced === "bundle") return forced;
  if (process.env.VERCEL === "1" && process.env.MONGODB_URI) return "mongo";
  return "file";
}

export function durableWorkDir(): string {
  return process.env.PL_DURABLE_WORK_DIR || path.join(os.tmpdir(), "foa-durable-ops");
}

function emptyBundle(): DurableBundle {
  return {
    jobs: "",
    sourceObservations: "",
    scheduleRevisions: "",
    resultObservations: "",
    resultVerifications: "",
    ratingEvents: "",
    ratingState: "",
    tickState: "",
    settlementCorrections: "",
    operationalLiveOos: "",
    settlements: "",
    workingSnapshots: "",
    contextSnapshots: "",
    fixturesOverlay: "",
  };
}

function readIf(file: string): string {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

function writeIf(file: string, text: string): void {
  if (!text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

interface ParsedContextSnapshotRow {
  snapshot: MatchContextSnapshot;
  json: string;
}

export interface MongoContextSnapshotDocument {
  _id: string;
  snapshot: MatchContextSnapshot;
  insertedAt: string;
}

function parseContextSnapshotJsonl(text: string, sourceLabel: string): ParsedContextSnapshotRow[] {
  const rows: ParsedContextSnapshotRow[] = [];
  for (const [index, rawLine] of text.split("\n").entries()) {
    const json = rawLine.trim();
    if (!json) continue;
    let snapshot: MatchContextSnapshot;
    try {
      snapshot = JSON.parse(json) as MatchContextSnapshot;
    } catch {
      throw new Error(`${sourceLabel} contains invalid match context JSON at line ${index + 1}`);
    }
    try {
      assertMatchContextIntegrity(snapshot);
    } catch (error) {
      throw new Error(
        `${sourceLabel} contains invalid match context at line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    rows.push({ snapshot, json });
  }
  return rows;
}

function firstWriteContextRows(
  sources: readonly { text: string; label: string }[]
): ParsedContextSnapshotRow[] {
  const byId = new Map<string, ParsedContextSnapshotRow>();
  for (const source of sources) {
    for (const row of parseContextSnapshotJsonl(source.text, source.label)) {
      if (!byId.has(row.snapshot.contextId)) byId.set(row.snapshot.contextId, row);
    }
  }
  return [...byId.values()];
}

function serializeContextRows(rows: readonly ParsedContextSnapshotRow[]): string {
  return rows.length ? `${rows.map((row) => row.json).join("\n")}\n` : "";
}

/**
 * Merge immutable context JSONL sources in priority order. The first valid row
 * for a content address wins, input order is retained, and every row is
 * integrity-checked before any caller persists it.
 */
export function mergeContextSnapshotJsonl(...sources: readonly string[]): string {
  return serializeContextRows(
    firstWriteContextRows(
      sources.map((text, index) => ({ text, label: `match context source ${index + 1}` }))
    )
  );
}

function contextSnapshotAppendPayload(existing: string, incoming: string): string {
  const existingRows = firstWriteContextRows([
    { text: existing, label: "existing local match context store" },
  ]);
  const mergedRows = firstWriteContextRows([
    { text: existing, label: "existing local match context store" },
    { text: incoming, label: "hydrated durable match context store" },
  ]);
  const appendedRows = mergedRows.slice(existingRows.length);
  if (!appendedRows.length) return "";
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${separator}${serializeContextRows(appendedRows)}`;
}

/** Build insert-only Mongo operations after validating and de-duplicating JSONL. */
export function buildImmutableContextMongoUpserts(
  text: string,
  insertedAt = new Date().toISOString()
): AnyBulkWriteOperation<MongoContextSnapshotDocument>[] {
  const rows = firstWriteContextRows([
    { text, label: "captured match context store" },
  ]).sort((a, b) => a.snapshot.contextId.localeCompare(b.snapshot.contextId));
  return rows.map((row) => ({
    updateOne: {
      filter: { _id: row.snapshot.contextId },
      update: {
        $setOnInsert: {
          snapshot: row.snapshot,
          insertedAt,
        },
      },
      upsert: true,
    },
  }));
}

/**
 * Convert separately stored Mongo contexts back to JSONL, preferring those
 * immutable documents over matching rows left in a legacy bundle.
 */
export function mergeMongoContextDocumentsWithLegacy(
  documents: readonly Pick<MongoContextSnapshotDocument, "_id" | "snapshot">[],
  legacyJsonl: string
): string {
  const collectionJsonl = documents
    .slice()
    .sort((a, b) => String(a._id).localeCompare(String(b._id)))
    .map((document, index) => {
      if (typeof document._id !== "string" || document._id !== document.snapshot?.contextId) {
        throw new Error(`Mongo match context document ${index + 1} has a mismatched _id`);
      }
      assertMatchContextIntegrity(document.snapshot);
      return JSON.stringify(document.snapshot);
    })
    .join("\n");
  return mergeContextSnapshotJsonl(collectionJsonl, legacyJsonl);
}

function copyCommitted(srcName: string, dest: string): void {
  const src = path.join(COMMITTED_ROOT, srcName);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function assertNotTape(file: string): void {
  if (isCanonicalLiveTapePath(file)) {
    throw new Error("Refusing to use the canonical LIVE_OOS tape as an operational store.");
  }
}

/** Shrink append-only JSONL fields before they are packed into one Mongo document. */
export function compactDurableOpsOnDisk(): void {
  compactPersistedSourceObservations();
  compactPersistedResultObservations();
}

export function captureBundleFromDisk(): DurableBundle {
  compactDurableOpsOnDisk();
  return {
    jobs: readIf(predictionJobPath()),
    sourceObservations: readIf(sourceObservationPath()),
    scheduleRevisions: readIf(scheduleRevisionPath()),
    resultObservations: readIf(resultObservationPath()),
    resultVerifications: readIf(resultVerificationPath()),
    ratingEvents: readIf(ratingEventPath()),
    ratingState: readIf(ratingStateSnapshotPath()),
    tickState: readIf(tickStatePath()),
    settlementCorrections: readIf(settlementCorrectionPath()),
    operationalLiveOos: readIf(operationalLiveOosPath()),
    settlements: readIf(process.env.SETTLEMENT_STORE_PATH || path.join(opsDir(), "settlements.jsonl")),
    workingSnapshots: readIf(process.env.SNAPSHOT_STORE_PATH || path.join(opsDir(), "working-snapshots.jsonl")),
    contextSnapshots: readIf(contextSnapshotPath()),
    fixturesOverlay: readIf(liveFixturesPath()),
  };
}

export function routeDurablePaths(work = durableWorkDir()): void {
  const ops = path.join(work, "ops");
  process.env.PL_OPS_DIR = ops;
  process.env.PL_SEASON_MANIFEST_PATH = path.join(work, "season-2026-27.json");
  process.env.PL_CLUB_SEASONS_PATH = path.join(work, "club-seasons-2026-27.json");
  process.env.PL_FIXTURES_PATH = path.join(work, "fixtures-2026-27.json");
  process.env.PL_FIXTURE_REVISIONS_PATH = path.join(ops, "fixture-revisions.jsonl");
  process.env.SNAPSHOT_STORE_PATH = path.join(ops, "working-snapshots.jsonl");
  process.env.SETTLEMENT_STORE_PATH = path.join(ops, "settlements.jsonl");
  process.env.LIVE_OOS_ARCHIVE_PATH = path.join(ops, "live-oos-operational.jsonl");
  process.env.PL_CONTEXT_SNAPSHOT_PATH = path.join(ops, "match-context-snapshots.jsonl");
  assertNotTape(process.env.SNAPSHOT_STORE_PATH);
  assertNotTape(process.env.LIVE_OOS_ARCHIVE_PATH);
  copyCommitted("season-2026-27.json", process.env.PL_SEASON_MANIFEST_PATH);
  copyCommitted("club-seasons-2026-27.json", process.env.PL_CLUB_SEASONS_PATH);
  if (!fs.existsSync(process.env.PL_FIXTURES_PATH)) {
    copyCommitted("fixtures-2026-27.json", process.env.PL_FIXTURES_PATH);
  }
}

export function applyBundleToDisk(bundle: DurableBundle): void {
  routeDurablePaths();
  const contextFile = contextSnapshotPath();
  const contextAppend = contextSnapshotAppendPayload(
    readIf(contextFile),
    bundle.contextSnapshots ?? ""
  );
  writeIf(predictionJobPath(), bundle.jobs);
  writeIf(sourceObservationPath(), bundle.sourceObservations);
  writeIf(scheduleRevisionPath(), bundle.scheduleRevisions);
  writeIf(resultObservationPath(), bundle.resultObservations);
  writeIf(resultVerificationPath(), bundle.resultVerifications);
  writeIf(ratingEventPath(), bundle.ratingEvents);
  writeIf(ratingStateSnapshotPath(), bundle.ratingState);
  writeIf(tickStatePath(), bundle.tickState);
  writeIf(settlementCorrectionPath(), bundle.settlementCorrections);
  writeIf(operationalLiveOosPath(), bundle.operationalLiveOos);
  writeIf(process.env.SETTLEMENT_STORE_PATH!, bundle.settlements);
  writeIf(process.env.SNAPSHOT_STORE_PATH!, bundle.workingSnapshots);
  if (contextAppend) {
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    fs.appendFileSync(contextFile, contextAppend, "utf8");
  }
  if (bundle.fixturesOverlay.trim()) writeIf(liveFixturesPath(), bundle.fixturesOverlay);
  resetJobCache();
  resetRatingEventCache();
  resetSeasonBundleCache();
  resetSnapshotCache();
  resetContextSnapshotStoreCache();
}

function bundlePath(): string {
  return process.env.PL_OPS_BUNDLE_PATH || path.join(durableWorkDir(), "ops-bundle.json");
}

async function loadMongoBundle(): Promise<DurableBundle> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  // Read in save order: writers insert contexts before removing legacy rows
  // from the bundle. This ordering avoids a hydrate racing between those two
  // writes and temporarily observing neither copy.
  const doc = await db.collection(OPS_BUNDLE_COLLECTION).findOne({ _id: "current" as never });
  const contextDocuments = await db
    .collection<MongoContextSnapshotDocument>(CONTEXT_SNAPSHOT_COLLECTION)
    .find({}, { projection: { snapshot: 1 } })
    .sort({ _id: 1 })
    .toArray();
  const legacyBundle = doc?.bundle && typeof doc.bundle === "object"
    ? doc.bundle as DurableBundle
    : emptyBundle();
  const legacyContexts = legacyBundle.contextSnapshots;
  if (legacyContexts !== undefined && typeof legacyContexts !== "string") {
    throw new Error("legacy ops bundle contextSnapshots must be a string");
  }
  return {
    ...emptyBundle(),
    ...legacyBundle,
    contextSnapshots: mergeMongoContextDocumentsWithLegacy(
      contextDocuments,
      legacyContexts ?? ""
    ),
  };
}

async function saveMongoContexts(db: Db, text: string): Promise<void> {
  const operations = buildImmutableContextMongoUpserts(text);
  if (!operations.length) return;
  const collection = db.collection<MongoContextSnapshotDocument>(CONTEXT_SNAPSHOT_COLLECTION);
  // Keep each command bounded while retaining one-document-per-context storage.
  for (let index = 0; index < operations.length; index += 100) {
    await collection.bulkWrite(operations.slice(index, index + 100), { ordered: false });
  }
}

async function saveMongoBundle(bundle: DurableBundle): Promise<void> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  await saveMongoContexts(db, bundle.contextSnapshots ?? "");
  const { contextSnapshots: _contextSnapshots, ...bundleWithoutContexts } = bundle;
  await db.collection(OPS_BUNDLE_COLLECTION).updateOne(
    { _id: "current" as never },
    { $set: { bundle: bundleWithoutContexts, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

function loadFileBundle(): DurableBundle {
  const file = bundlePath();
  if (!fs.existsSync(file)) return emptyBundle();
  return { ...emptyBundle(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as DurableBundle) };
}

function saveFileBundle(bundle: DurableBundle): void {
  writeIf(bundlePath(), JSON.stringify(bundle));
}

const g = globalThis as unknown as {
  __foaDurable?: { hydrated: boolean; lastHydratedAt: string | null; lastFlushAt: string | null; backend: OpsBackendKind };
};

function meta() {
  if (!g.__foaDurable) {
    g.__foaDurable = { hydrated: false, lastHydratedAt: null, lastFlushAt: null, backend: opsBackend() };
  }
  return g.__foaDurable;
}

export function durableStatus(): {
  backend: OpsBackendKind;
  durable: boolean;
  hydrated: boolean;
  lastHydratedAt: string | null;
  lastFlushAt: string | null;
} {
  const m = meta();
  const backend = opsBackend();
  return {
    backend,
    durable: backend !== "file",
    hydrated: m.hydrated,
    lastHydratedAt: m.lastHydratedAt,
    lastFlushAt: m.lastFlushAt,
  };
}

export async function hydrateDurableOps(): Promise<void> {
  const backend = opsBackend();
  meta().backend = backend;
  if (backend === "file") {
    meta().hydrated = true;
    return;
  }
  try {
    const bundle = backend === "mongo" ? await loadMongoBundle() : loadFileBundle();
    applyBundleToDisk(bundle);
    compactDurableOpsOnDisk();
    meta().hydrated = true;
    meta().lastHydratedAt = new Date().toISOString();
  } catch (err) {
    console.warn("[ops-durable] hydrate failed, continuing on local work dir:", (err as Error).message);
    routeDurablePaths();
    meta().hydrated = false;
    meta().lastHydratedAt = null;
  }
}

export async function flushDurableOps(): Promise<void> {
  const backend = opsBackend();
  if (backend === "file") return;
  const bundle = captureBundleFromDisk();
  if (backend === "mongo") await saveMongoBundle(bundle);
  else saveFileBundle(bundle);
  meta().lastFlushAt = new Date().toISOString();
}

export function resetDurableMetaForTests(): void {
  g.__foaDurable = { hydrated: false, lastHydratedAt: null, lastFlushAt: null, backend: opsBackend() };
}
