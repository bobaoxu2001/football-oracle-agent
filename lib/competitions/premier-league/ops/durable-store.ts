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
const HYDRATION_FRESH_MS = 15_000;
const PUBLIC_HYDRATION_TIMEOUT_MS = 8_000;
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

function writeAuthoritative(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

const JSON_DOCUMENT_KEYS = ["ratingState", "tickState", "fixturesOverlay"] as const;
const JSONL_KEYS = [
  "jobs",
  "sourceObservations",
  "scheduleRevisions",
  "resultObservations",
  "resultVerifications",
  "ratingEvents",
  "settlementCorrections",
  "operationalLiveOos",
  "settlements",
  "workingSnapshots",
] as const;

function assertJsonObject(text: string, label: string): void {
  if (!text.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  if (label.endsWith("fixturesOverlay")) {
    const fixtures = (parsed as { fixtures?: unknown }).fixtures;
    if (!Array.isArray(fixtures)) {
      throw new Error(`${label} must contain a fixtures array`);
    }
  }
}

function assertJsonlObjects(text: string, label: string): void {
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${label} contains invalid JSON at line ${index + 1}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must contain JSON objects (line ${index + 1})`);
    }
  }
}

/** Validate every opaque payload before any authoritative file is replaced. */
export function validateDurableBundle(
  value: unknown,
  sourceLabel = "durable ops bundle"
): DurableBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const normalized = emptyBundle();
  for (const key of BUNDLE_KEYS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "string") {
      throw new Error(`${sourceLabel}.${key} must be a string`);
    }
    normalized[key] = field;
  }
  for (const key of JSON_DOCUMENT_KEYS) {
    assertJsonObject(normalized[key], `${sourceLabel}.${key}`);
  }
  for (const key of JSONL_KEYS) {
    assertJsonlObjects(normalized[key], `${sourceLabel}.${key}`);
  }
  parseContextSnapshotJsonl(
    normalized.contextSnapshots ?? "",
    `${sourceLabel}.contextSnapshots`
  );
  return normalized;
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
  return validateDurableBundle({
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
  }, "captured durable ops bundle");
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
  bundle = validateDurableBundle(bundle);
  routeDurablePaths();
  const contextFile = contextSnapshotPath();
  const contextAppend = contextSnapshotAppendPayload(
    readIf(contextFile),
    bundle.contextSnapshots ?? ""
  );
  writeAuthoritative(predictionJobPath(), bundle.jobs);
  writeAuthoritative(sourceObservationPath(), bundle.sourceObservations);
  writeAuthoritative(scheduleRevisionPath(), bundle.scheduleRevisions);
  writeAuthoritative(resultObservationPath(), bundle.resultObservations);
  writeAuthoritative(resultVerificationPath(), bundle.resultVerifications);
  writeAuthoritative(ratingEventPath(), bundle.ratingEvents);
  writeAuthoritative(ratingStateSnapshotPath(), bundle.ratingState);
  writeAuthoritative(tickStatePath(), bundle.tickState);
  writeAuthoritative(settlementCorrectionPath(), bundle.settlementCorrections);
  writeAuthoritative(operationalLiveOosPath(), bundle.operationalLiveOos);
  writeAuthoritative(process.env.SETTLEMENT_STORE_PATH!, bundle.settlements);
  writeAuthoritative(process.env.SNAPSHOT_STORE_PATH!, bundle.workingSnapshots);
  if (contextAppend) {
    fs.mkdirSync(path.dirname(contextFile), { recursive: true });
    fs.appendFileSync(contextFile, contextAppend, "utf8");
  }
  if (bundle.fixturesOverlay.trim()) {
    writeAuthoritative(liveFixturesPath(), bundle.fixturesOverlay);
  } else {
    // Empty means "no durable overlay", not "reuse whichever overlay happened
    // to be left in this warm serverless work directory".
    copyCommitted("fixtures-2026-27.json", liveFixturesPath());
  }
  resetJobCache();
  resetRatingEventCache();
  resetSeasonBundleCache();
  resetSnapshotCache();
  resetContextSnapshotStoreCache();
}

function bundlePath(): string {
  return process.env.PL_OPS_BUNDLE_PATH || path.join(durableWorkDir(), "ops-bundle.json");
}

interface LoadedMongoBundle {
  bundle: DurableBundle;
  version: string;
  updatedAt: string | null;
}

function mongoVersionToken(updatedAt: string | null, contextCount: number): string {
  return JSON.stringify([updatedAt, contextCount]);
}

async function loadMongoBundleVersion(timeoutMS: number): Promise<string> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  const boundedTimeout = Math.min(timeoutMS, 4_000);
  const [doc, contextCount] = await Promise.all([
    db.collection(OPS_BUNDLE_COLLECTION).findOne(
      { _id: "current" as never },
      { projection: { updatedAt: 1 }, timeoutMS: boundedTimeout }
    ),
    db.collection(CONTEXT_SNAPSHOT_COLLECTION).countDocuments(
      {},
      { timeoutMS: boundedTimeout }
    ),
  ]);
  return mongoVersionToken(
    typeof doc?.updatedAt === "string" ? doc.updatedAt : null,
    contextCount
  );
}

async function loadMongoBundle(timeoutMS: number): Promise<LoadedMongoBundle> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMS);
  // Read in save order: writers insert contexts before removing legacy rows
  // from the bundle. This ordering avoids a hydrate racing between those two
  // writes and temporarily observing neither copy.
  try {
    const doc = await db.collection(OPS_BUNDLE_COLLECTION).findOne(
      { _id: "current" as never },
      { timeoutMS, signal: controller.signal }
    );
    const contextDocuments = await db
      .collection<MongoContextSnapshotDocument>(CONTEXT_SNAPSHOT_COLLECTION)
      .find({}, { projection: { snapshot: 1 }, timeoutMS, signal: controller.signal })
      .sort({ _id: 1 })
      .toArray();
    const legacyBundle = validateDurableBundle(
      doc?.bundle ?? emptyBundle(),
      "Mongo durable ops bundle"
    );
    const legacyContexts = legacyBundle.contextSnapshots;
    if (legacyContexts !== undefined && typeof legacyContexts !== "string") {
      throw new Error("legacy ops bundle contextSnapshots must be a string");
    }
    return {
      updatedAt: typeof doc?.updatedAt === "string" ? doc.updatedAt : null,
      version: mongoVersionToken(
        typeof doc?.updatedAt === "string" ? doc.updatedAt : null,
        contextDocuments.length
      ),
      bundle: {
        ...emptyBundle(),
        ...legacyBundle,
        contextSnapshots: mergeMongoContextDocumentsWithLegacy(
          contextDocuments,
          legacyContexts ?? ""
        ),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function remainingTimeoutMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Mongo durable ops flush deadline exceeded");
  return Math.max(1, remaining);
}

async function saveMongoContexts(
  db: Db,
  text: string,
  deadline: number
): Promise<void> {
  const operations = buildImmutableContextMongoUpserts(text);
  if (!operations.length) return;
  const collection = db.collection<MongoContextSnapshotDocument>(CONTEXT_SNAPSHOT_COLLECTION);
  // Keep each command bounded while retaining one-document-per-context storage.
  for (let index = 0; index < operations.length; index += 100) {
    await collection.bulkWrite(operations.slice(index, index + 100), {
      ordered: false,
      timeoutMS: remainingTimeoutMs(deadline),
    });
  }
}

async function saveMongoBundle(
  bundle: DurableBundle,
  expectedUpdatedAt: string | null,
  timeoutMs = 20_000
): Promise<{ version: string; updatedAt: string }> {
  bundle = validateDurableBundle(bundle);
  const deadline = Date.now() + timeoutMs;
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  await saveMongoContexts(db, bundle.contextSnapshots ?? "", deadline);
  const { contextSnapshots: _contextSnapshots, ...bundleWithoutContexts } = bundle;
  const updatedAt = new Date().toISOString();
  const filter = expectedUpdatedAt
    ? { _id: "current", updatedAt: expectedUpdatedAt }
    : {
        _id: "current",
        $or: [{ updatedAt: { $exists: false } }, { updatedAt: null }],
      };
  const result = await db.collection(OPS_BUNDLE_COLLECTION).updateOne(
    filter as never,
    { $set: { bundle: bundleWithoutContexts, updatedAt } },
    {
      upsert: expectedUpdatedAt === null,
      timeoutMS: remainingTimeoutMs(deadline),
    }
  );
  if (result.matchedCount + result.upsertedCount !== 1) {
    throw new Error("Durable ops bundle changed after hydration; refusing stale overwrite");
  }
  const contextCount = await db.collection(CONTEXT_SNAPSHOT_COLLECTION).countDocuments(
    {},
    { timeoutMS: remainingTimeoutMs(deadline) }
  );
  return { version: mongoVersionToken(updatedAt, contextCount), updatedAt };
}

function loadFileBundle(): DurableBundle {
  const file = bundlePath();
  if (!fs.existsSync(file)) return emptyBundle();
  return validateDurableBundle(
    JSON.parse(fs.readFileSync(file, "utf8")) as unknown,
    "file durable ops bundle"
  );
}

function saveFileBundle(bundle: DurableBundle): void {
  writeAuthoritative(bundlePath(), JSON.stringify(validateDurableBundle(bundle)));
}

interface DurableMeta {
  hydrated: boolean;
  lastHydratedAt: string | null;
  lastHydrateFailedAt: string | null;
  hydrateRefreshFailed: boolean;
  lastFlushAt: string | null;
  backend: OpsBackendKind;
  bundleVersion: string | null;
  bundleUpdatedAt: string | null;
  hydrationPromise?: Promise<Error | null>;
}

const g = globalThis as unknown as { __foaDurable?: DurableMeta };

function newMeta(): DurableMeta {
  return {
    hydrated: false,
    lastHydratedAt: null,
    lastHydrateFailedAt: null,
    hydrateRefreshFailed: false,
    lastFlushAt: null,
    backend: opsBackend(),
    bundleVersion: null,
    bundleUpdatedAt: null,
  };
}

function meta() {
  if (!g.__foaDurable) {
    g.__foaDurable = newMeta();
  }
  return g.__foaDurable;
}

export function durableStatus(): {
  backend: OpsBackendKind;
  durable: boolean;
  hydrated: boolean;
  lastHydratedAt: string | null;
  lastHydrateFailedAt: string | null;
  hydrateRefreshFailed: boolean;
  lastFlushAt: string | null;
} {
  const m = meta();
  const backend = opsBackend();
  return {
    backend,
    durable: backend !== "file",
    hydrated: m.hydrated,
    lastHydratedAt: m.lastHydratedAt,
    lastHydrateFailedAt: m.lastHydrateFailedAt,
    hydrateRefreshFailed: m.hydrateRefreshFailed,
    lastFlushAt: m.lastFlushAt,
  };
}

export interface HydrateDurableOpsOptions {
  /** Ignore the short read cache. The production writer uses this before a tick. */
  force?: boolean;
  /** Refuse stale in-memory state after a failed refresh. Required for writers. */
  strict?: boolean;
  /** Bound the Mongo read independently of the enclosing Vercel function. */
  timeoutMs?: number;
}

export interface DurableTickFreshness {
  fresh: boolean;
  lastTickAt: string | null;
  ageMs: number | null;
}

/**
 * Lightweight observer bootstrap. Market mapping needs the latest durable
 * fixture overlay, but it must not download the complete forecast ledger just
 * to decide whether an observational poll is due.
 */
export async function hydrateDurableFixtures(timeoutMs = 4_000): Promise<void> {
  const backend = opsBackend();
  if (backend === "file") return;
  let fixturesOverlay = "";
  if (backend === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable for durable fixture overlay");
    const doc = await db.collection(OPS_BUNDLE_COLLECTION).findOne(
      { _id: "current" as never },
      {
        projection: { "bundle.fixturesOverlay": 1 },
        timeoutMS: Math.max(1_000, timeoutMs),
      }
    );
    const value = (doc as { bundle?: { fixturesOverlay?: unknown } } | null)
      ?.bundle?.fixturesOverlay;
    if (value !== undefined && typeof value !== "string") {
      throw new Error("Mongo durable fixture overlay must be a string");
    }
    fixturesOverlay = value ?? "";
  } else {
    fixturesOverlay = loadFileBundle().fixturesOverlay;
  }
  assertJsonObject(fixturesOverlay, "durable observer fixturesOverlay");
  routeDurablePaths();
  if (fixturesOverlay.trim()) {
    writeAuthoritative(liveFixturesPath(), fixturesOverlay);
  } else {
    copyCommitted("fixtures-2026-27.json", liveFixturesPath());
  }
  resetSeasonBundleCache();
}

/** Small projection used by the hosted one-shot backup before a full tick. */
export async function durableTickFreshness(
  now = new Date(),
  maxAgeMs = 7 * 60 * 1000
): Promise<DurableTickFreshness> {
  const backend = opsBackend();
  let raw = "";
  if (backend === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable for durable ops freshness check");
    const doc = await db.collection(OPS_BUNDLE_COLLECTION).findOne(
      { _id: "current" as never },
      { projection: { "bundle.tickState": 1 }, timeoutMS: 4_000 }
    );
    const value = (doc as { bundle?: { tickState?: unknown } } | null)?.bundle?.tickState;
    raw = typeof value === "string" ? value : "";
  } else if (backend === "bundle") {
    raw = loadFileBundle().tickState;
  } else {
    raw = readIf(tickStatePath());
  }
  let lastTickAt: string | null = null;
  try {
    const parsed = JSON.parse(raw || "{}") as { lastTickAt?: unknown };
    lastTickAt = typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : null;
  } catch {
    lastTickAt = null;
  }
  const tickMs = lastTickAt ? Date.parse(lastTickAt) : Number.NaN;
  const ageMs = Number.isFinite(tickMs) ? Math.max(0, now.getTime() - tickMs) : null;
  return {
    fresh: ageMs !== null && ageMs <= maxAgeMs,
    lastTickAt,
    ageMs,
  };
}

function hydrationIsFresh(value: DurableMeta, now = Date.now()): boolean {
  if (!value.hydrated || value.hydrateRefreshFailed || !value.lastHydratedAt) return false;
  const hydratedAt = Date.parse(value.lastHydratedAt);
  return Number.isFinite(hydratedAt) && now - hydratedAt < HYDRATION_FRESH_MS;
}

export async function hydrateDurableOps(
  options: HydrateDurableOpsOptions = {}
): Promise<void> {
  const backend = opsBackend();
  const state = meta();
  state.backend = backend;
  if (backend === "file") {
    state.hydrated = true;
    state.hydrateRefreshFailed = false;
    return;
  }

  if (!options.force && hydrationIsFresh(state)) return;
  const callerHadHydratedState = state.hydrated;
  if (state.hydrationPromise) {
    const failure = await state.hydrationPromise;
    if (failure && (options.strict || !callerHadHydratedState)) throw failure;
    return;
  }

  const hadHydratedState = callerHadHydratedState;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? PUBLIC_HYDRATION_TIMEOUT_MS);
  const task: Promise<Error | null> = (async () => {
    try {
      if (backend === "mongo" && hadHydratedState && state.bundleVersion) {
        const currentVersion = await loadMongoBundleVersion(timeoutMs);
        if (currentVersion === state.bundleVersion) {
          state.lastHydratedAt = new Date().toISOString();
          state.lastHydrateFailedAt = null;
          state.hydrateRefreshFailed = false;
          return null;
        }
      }
      const loaded = backend === "mongo"
        ? await loadMongoBundle(timeoutMs)
        : { bundle: loadFileBundle(), version: null, updatedAt: null };
      const bundle = loaded.bundle;
      applyBundleToDisk(bundle);
      compactDurableOpsOnDisk();
      state.hydrated = true;
      state.lastHydratedAt = new Date().toISOString();
      state.bundleVersion = loaded.version;
      state.bundleUpdatedAt = loaded.updatedAt;
      state.lastHydrateFailedAt = null;
      state.hydrateRefreshFailed = false;
      return null;
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      state.lastHydrateFailedAt = new Date().toISOString();
      state.hydrateRefreshFailed = true;
      if (!hadHydratedState) {
        state.hydrated = false;
        state.lastHydratedAt = null;
        routeDurablePaths();
      }
      console.warn(
        `[ops-durable] hydrate failed${hadHydratedState ? "; retaining last verified local state" : ""}:`,
        failure.message
      );
      return failure;
    }
  })();
  state.hydrationPromise = task;
  let failure: Error | null = null;
  try {
    failure = await task;
  } finally {
    if (state.hydrationPromise === task) delete state.hydrationPromise;
  }
  if (failure && (options.strict || !hadHydratedState)) throw failure;
}

export async function flushDurableOps(): Promise<void> {
  const backend = opsBackend();
  if (backend === "file") return;
  const bundle = captureBundleFromDisk();
  const state = meta();
  if (backend === "mongo") {
    const saved = await saveMongoBundle(bundle, state.bundleUpdatedAt);
    state.bundleVersion = saved.version;
    state.bundleUpdatedAt = saved.updatedAt;
  } else {
    saveFileBundle(bundle);
  }
  state.lastFlushAt = new Date().toISOString();
  state.lastHydratedAt = state.lastFlushAt;
  state.hydrated = true;
  state.lastHydrateFailedAt = null;
  state.hydrateRefreshFailed = false;
}

export function resetDurableMetaForTests(): void {
  g.__foaDurable = newMeta();
}
