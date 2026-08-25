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
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
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
const OPS_MIGRATION_BACKUP_COLLECTION = "pl_ops_migration_backups";
const JOBS_ENCODING = "gzip-base64-v1";
const BUNDLE_WRITER_SCHEMA = 2;
const MAX_JOBS_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const HYDRATION_FRESH_MS = 15_000;
// The compact production bundle is still multi-megabyte. Eight seconds was
// enough for topology checks but not for a cold IAD read of the full document;
// 20s remains well below the 60s function ceiling and is protected by CDN
// coalescing plus the 15s warm-instance version cache.
const PUBLIC_HYDRATION_TIMEOUT_MS = 20_000;
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

export interface MongoStoredBundle extends Record<string, unknown> {
  jobs?: string;
  jobsGzipBase64?: string;
  jobsSha256?: string;
  jobsEncoding?: string;
}

/** Reject partial or wrong-database backups before they can become authoritative. */
export function requireCompleteMongoStoredBundle(
  value: unknown,
  sourceLabel = "Mongo stored ops bundle"
): MongoStoredBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be an object`);
  }
  const stored = value as MongoStoredBundle;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(stored, key);
  for (const key of BUNDLE_KEYS) {
    if (key === "jobs" || key === "contextSnapshots") continue;
    if (!hasOwn(key) || typeof stored[key] !== "string") {
      throw new Error(`${sourceLabel}.${key} is missing or not a string`);
    }
  }
  const hasPlainJobs = hasOwn("jobs") && typeof stored.jobs === "string";
  const hasCompressedJobs =
    stored.jobsEncoding === JOBS_ENCODING &&
    typeof stored.jobsGzipBase64 === "string" &&
    typeof stored.jobsSha256 === "string";
  if (!hasPlainJobs && !hasCompressedJobs) {
    throw new Error(`${sourceLabel} has no complete jobs representation`);
  }
  if (hasOwn("contextSnapshots") && typeof stored.contextSnapshots !== "string") {
    throw new Error(`${sourceLabel}.contextSnapshots is not a string`);
  }
  return stored;
}

export interface MongoBundleRevisionV2 {
  iso: string;
  writerSchema: typeof BUNDLE_WRITER_SCHEMA;
}

export type MongoBundleRevision = string | MongoBundleRevisionV2;

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Legacy writers only understand a string `updatedAt`. Once a write stores the
 * v2 document, those writers treat it as missing and their old CAS cannot
 * match. This is a durable writer fence, including for direct old-deployment
 * traffic and rollbacks.
 */
export function parseMongoBundleRevision(
  value: unknown,
  sourceLabel = "Mongo durable ops revision"
): MongoBundleRevision | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (!isIsoTimestamp(value)) throw new Error(`${sourceLabel} is not a timestamp`);
    return value;
  }
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { writerSchema?: unknown }).writerSchema === BUNDLE_WRITER_SCHEMA &&
    typeof (value as { iso?: unknown }).iso === "string" &&
    isIsoTimestamp((value as { iso: string }).iso)
  ) {
    return {
      iso: (value as { iso: string }).iso,
      writerSchema: BUNDLE_WRITER_SCHEMA,
    };
  }
  throw new Error(`${sourceLabel} has an unsupported writer schema`);
}

export function mongoBundleRevisionIso(revision: MongoBundleRevision | null): string | null {
  return typeof revision === "string" ? revision : revision?.iso ?? null;
}

export function nextMongoBundleRevision(now = new Date()): MongoBundleRevisionV2 {
  return { iso: now.toISOString(), writerSchema: BUNDLE_WRITER_SCHEMA };
}

export function mongoBundleRevisionFilter(
  revision: MongoBundleRevision | null
): Record<string, unknown> {
  if (typeof revision === "string") return { updatedAt: revision };
  if (revision) {
    return {
      "updatedAt.iso": revision.iso,
      "updatedAt.writerSchema": BUNDLE_WRITER_SCHEMA,
    };
  }
  return { $or: [{ updatedAt: { $exists: false } }, { updatedAt: null }] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function encodeMongoBundleForStorage(bundle: DurableBundle): MongoStoredBundle {
  const validated = validateDurableBundle(bundle);
  const {
    jobs,
    contextSnapshots: _contextSnapshots,
    ...bundleWithoutJobsAndContexts
  } = validated;
  const jobsBytes = Buffer.byteLength(jobs, "utf8");
  if (jobsBytes > MAX_JOBS_UNCOMPRESSED_BYTES) {
    throw new Error(
      `durable ops jobs payload exceeds ${MAX_JOBS_UNCOMPRESSED_BYTES} bytes`
    );
  }
  return {
    ...bundleWithoutJobsAndContexts,
    jobsEncoding: JOBS_ENCODING,
    jobsGzipBase64: gzipSync(Buffer.from(jobs, "utf8"), { level: 9 }).toString("base64"),
    jobsSha256: sha256(jobs),
  };
}

/** Preserve the format that was explicitly hydrated; never auto-migrate on flush. */
export function mongoBundleForWrite(
  bundle: DurableBundle,
  jobsCompressed: boolean
): MongoStoredBundle {
  const validated = validateDurableBundle(bundle);
  if (jobsCompressed) return encodeMongoBundleForStorage(validated);
  const { contextSnapshots: _contextSnapshots, ...plainBundle } = validated;
  return plainBundle;
}

export function decodeMongoBundleFromStorage(
  value: unknown,
  sourceLabel = "Mongo durable ops bundle"
): DurableBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be an object`);
  }
  const stored = value as MongoStoredBundle;
  const hasCompressed = stored.jobsGzipBase64 !== undefined;
  if (!hasCompressed) return validateDurableBundle(stored, sourceLabel);
  if (
    stored.jobsEncoding !== JOBS_ENCODING ||
    typeof stored.jobsGzipBase64 !== "string" ||
    typeof stored.jobsSha256 !== "string"
  ) {
    throw new Error(`${sourceLabel} has an unsupported jobs encoding`);
  }
  let jobs: string;
  try {
    jobs = gunzipSync(Buffer.from(stored.jobsGzipBase64, "base64"), {
      maxOutputLength: MAX_JOBS_UNCOMPRESSED_BYTES,
    }).toString("utf8");
  } catch {
    throw new Error(`${sourceLabel} contains an unreadable compressed jobs payload`);
  }
  if (sha256(jobs) !== stored.jobsSha256) {
    throw new Error(`${sourceLabel} compressed jobs checksum mismatch`);
  }
  if (typeof stored.jobs === "string" && stored.jobs && stored.jobs !== jobs) {
    throw new Error(`${sourceLabel} contains conflicting plain and compressed jobs`);
  }
  return validateDurableBundle({ ...stored, jobs }, sourceLabel);
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
  revision: MongoBundleRevision | null;
  jobsCompressed: boolean;
}

function mongoVersionToken(revision: MongoBundleRevision | null, contextCount: number): string {
  return JSON.stringify([revision, contextCount]);
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
    parseMongoBundleRevision(doc?.updatedAt, "Mongo durable ops revision probe"),
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
    const legacyBundle = decodeMongoBundleFromStorage(
      doc?.bundle ?? emptyBundle(),
      "Mongo durable ops bundle"
    );
    const legacyContexts = legacyBundle.contextSnapshots;
    if (legacyContexts !== undefined && typeof legacyContexts !== "string") {
      throw new Error("legacy ops bundle contextSnapshots must be a string");
    }
    const revision = parseMongoBundleRevision(
      doc?.updatedAt,
      "Mongo durable ops revision"
    );
    return {
      revision,
      version: mongoVersionToken(revision, contextDocuments.length),
      jobsCompressed: Boolean(
        doc?.bundle &&
          typeof doc.bundle === "object" &&
          typeof (doc.bundle as MongoStoredBundle).jobsGzipBase64 === "string"
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
  expectedRevision: MongoBundleRevision | null,
  jobsCompressed: boolean,
  timeoutMs = 20_000
): Promise<{
  version: string;
  revision: MongoBundleRevisionV2;
  jobsCompressed: boolean;
}> {
  bundle = validateDurableBundle(bundle);
  const deadline = Date.now() + timeoutMs;
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  await saveMongoContexts(db, bundle.contextSnapshots ?? "", deadline);
  const bundleForMongo = mongoBundleForWrite(bundle, jobsCompressed);
  const revision = nextMongoBundleRevision();
  const filter = {
    _id: "current",
    ...mongoBundleRevisionFilter(expectedRevision),
  };
  const result = await db.collection(OPS_BUNDLE_COLLECTION).updateOne(
    filter as never,
    { $set: { bundle: bundleForMongo, updatedAt: revision } },
    {
      upsert: expectedRevision === null,
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
  return {
    version: mongoVersionToken(revision, contextCount),
    revision,
    jobsCompressed,
  };
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
  bundleRevision: MongoBundleRevision | null;
  jobsCompressed: boolean;
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
    bundleRevision: null,
    jobsCompressed: false,
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

export interface DurableStorageDiagnostics {
  backend: OpsBackendKind;
  updatedAt: string | null;
  bundleBytes: number | null;
  fieldBytes: Record<DurableBundleKey, number>;
  contextDocuments: number;
}

/** Server-side byte counts only; never returns durable evidence contents. */
export async function durableStorageDiagnostics(): Promise<DurableStorageDiagnostics> {
  const backend = opsBackend();
  if (backend !== "mongo") {
    const bundle = backend === "bundle" ? loadFileBundle() : captureBundleFromDisk();
    const fieldBytes = Object.fromEntries(
      BUNDLE_KEYS.map(key => [key, Buffer.byteLength(bundle[key] ?? "", "utf8")])
    ) as Record<DurableBundleKey, number>;
    return {
      backend,
      updatedAt: null,
      bundleBytes: Object.values(fieldBytes).reduce((sum, bytes) => sum + bytes, 0),
      fieldBytes,
      contextDocuments: parseContextSnapshotJsonl(
        bundle.contextSnapshots ?? "",
        "diagnostic context store"
      ).length,
    };
  }
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable storage diagnostics");
  const fields = Object.fromEntries(
    BUNDLE_KEYS.filter(key => key !== "contextSnapshots").map(key => [
      key,
      key === "jobs"
        ? {
            $add: [
              { $strLenBytes: { $ifNull: ["$bundle.jobs", ""] } },
              { $strLenBytes: { $ifNull: ["$bundle.jobsGzipBase64", ""] } },
            ],
          }
        : { $strLenBytes: { $ifNull: [`$bundle.${key}`, ""] } },
    ])
  );
  const [rows, contextDocuments] = await Promise.all([
    db.collection(OPS_BUNDLE_COLLECTION).aggregate<{
      updatedAt?: unknown;
      bundleBytes?: unknown;
      fieldBytes?: Record<string, unknown>;
    }>(
      [
        { $match: { _id: "current" } },
        {
          $project: {
            _id: 0,
            updatedAt: 1,
            bundleBytes: { $bsonSize: "$bundle" },
            fieldBytes: fields,
          },
        },
      ],
      { maxTimeMS: 8_000, timeoutMS: 10_000 }
    ).toArray(),
    db.collection(CONTEXT_SNAPSHOT_COLLECTION).countDocuments({}, { timeoutMS: 10_000 }),
  ]);
  const row = rows[0];
  const fieldBytes = Object.fromEntries(
    BUNDLE_KEYS.map(key => [
      key,
      key === "contextSnapshots" ? 0 : Number(row?.fieldBytes?.[key] ?? 0),
    ])
  ) as Record<DurableBundleKey, number>;
  return {
    backend,
    updatedAt: mongoBundleRevisionIso(
      parseMongoBundleRevision(row?.updatedAt, "Mongo durable ops diagnostic revision")
    ),
    bundleBytes: Number.isFinite(Number(row?.bundleBytes)) ? Number(row?.bundleBytes) : null,
    fieldBytes,
    contextDocuments,
  };
}

export interface DurableJobsMigrationResult {
  migrated: boolean;
  writerFenced: boolean;
  previousUpdatedAt: string | null;
  updatedAt: string | null;
  logicalBytes: number;
  storedBytes: number;
  sha256: string;
  backupId: string | null;
}

/** One-time, CAS-protected storage-format migration; logical job bytes stay identical. */
export async function migrateMongoJobsToCompressedStorage(
  deadline = Date.now() + 40_000
): Promise<DurableJobsMigrationResult> {
  if (opsBackend() !== "mongo") {
    throw new Error("jobs compression migration requires the Mongo durable backend");
  }
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for jobs compression migration");
  const doc = await db.collection(OPS_BUNDLE_COLLECTION).findOne(
    { _id: "current" as never },
    {
      projection: {
        updatedAt: 1,
        "bundle.jobs": 1,
        "bundle.jobsEncoding": 1,
        "bundle.jobsGzipBase64": 1,
        "bundle.jobsSha256": 1,
      },
      timeoutMS: Math.min(25_000, remainingTimeoutMs(deadline)),
    }
  ) as { updatedAt?: unknown; bundle?: MongoStoredBundle } | null;
  if (!doc?.bundle) throw new Error("Mongo durable ops bundle is missing");
  const previousRevision = parseMongoBundleRevision(
    doc.updatedAt,
    "Mongo jobs migration revision"
  );
  const previousUpdatedAt = mongoBundleRevisionIso(previousRevision);
  if (typeof doc.bundle.jobsGzipBase64 === "string") {
    const jobs = decodeMongoBundleFromStorage(doc.bundle, "compressed jobs migration probe").jobs;
    let currentRevision = previousRevision;
    let writerFenced = typeof previousRevision !== "string" && previousRevision !== null;
    if (!writerFenced) {
      const fencedRevision = nextMongoBundleRevision();
      const fenceResult = await db.collection(OPS_BUNDLE_COLLECTION).updateOne(
        {
          _id: "current",
          ...mongoBundleRevisionFilter(previousRevision),
        } as never,
        { $set: { updatedAt: fencedRevision } },
        { timeoutMS: Math.min(10_000, remainingTimeoutMs(deadline)) }
      );
      if (fenceResult.matchedCount !== 1) {
        throw new Error("durable ops bundle changed while installing writer fence");
      }
      currentRevision = fencedRevision;
      writerFenced = true;
    }
    return {
      migrated: false,
      writerFenced,
      previousUpdatedAt,
      updatedAt: mongoBundleRevisionIso(currentRevision),
      logicalBytes: Buffer.byteLength(jobs, "utf8"),
      storedBytes: Buffer.byteLength(doc.bundle.jobsGzipBase64, "utf8"),
      sha256: sha256(jobs),
      backupId: null,
    };
  }
  if (typeof doc.bundle.jobs !== "string") {
    throw new Error("Mongo durable ops jobs field is not a string");
  }
  const jobs = doc.bundle.jobs;
  // Reuse the full validator for the JSONL evidence boundary before mutation.
  validateDurableBundle({ ...emptyBundle(), jobs }, "jobs compression migration input");
  const encoded = encodeMongoBundleForStorage({ ...emptyBundle(), jobs });
  const payload = String(encoded.jobsGzipBase64 ?? "");
  const digest = String(encoded.jobsSha256 ?? "");
  const backupId = `jobs-${JOBS_ENCODING}-${digest}`;
  await db.collection(OPS_MIGRATION_BACKUP_COLLECTION).updateOne(
    { _id: backupId as never },
    {
      $setOnInsert: {
        encoding: JOBS_ENCODING,
        payload,
        sha256: digest,
        sourceUpdatedAt: previousUpdatedAt,
        createdAt: new Date().toISOString(),
      },
    },
    { upsert: true, timeoutMS: Math.min(15_000, remainingTimeoutMs(deadline)) }
  );
  const backup = await db.collection(OPS_MIGRATION_BACKUP_COLLECTION).findOne(
    { _id: backupId as never },
    {
      projection: { encoding: 1, payload: 1, sha256: 1 },
      timeoutMS: Math.min(5_000, remainingTimeoutMs(deadline)),
    }
  );
  if (
    backup?.encoding !== JOBS_ENCODING ||
    typeof backup?.payload !== "string" ||
    backup?.sha256 !== digest
  ) {
    throw new Error("compressed jobs migration backup verification failed");
  }
  const recoveredJobs = decodeMongoBundleFromStorage(
    {
      jobsEncoding: backup.encoding,
      jobsGzipBase64: backup.payload,
      jobsSha256: backup.sha256,
    },
    "compressed jobs migration backup"
  ).jobs;
  if (recoveredJobs !== jobs) {
    throw new Error("compressed jobs migration backup round-trip mismatch");
  }
  const revision = nextMongoBundleRevision();
  const filter = {
    _id: "current",
    ...mongoBundleRevisionFilter(previousRevision),
  };
  const result = await db.collection(OPS_BUNDLE_COLLECTION).updateOne(
    filter as never,
    {
      $set: {
        "bundle.jobsEncoding": JOBS_ENCODING,
        "bundle.jobsGzipBase64": payload,
        "bundle.jobsSha256": digest,
        updatedAt: revision,
      },
      $unset: { "bundle.jobs": "" },
    },
    { timeoutMS: Math.min(15_000, remainingTimeoutMs(deadline)) }
  );
  if (result.matchedCount !== 1) {
    throw new Error("durable ops bundle changed during jobs compression migration");
  }
  return {
    migrated: true,
    writerFenced: true,
    previousUpdatedAt,
    updatedAt: revision.iso,
    logicalBytes: Buffer.byteLength(jobs, "utf8"),
    storedBytes: Buffer.byteLength(payload, "utf8"),
    sha256: digest,
    backupId,
  };
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
        : {
            bundle: loadFileBundle(),
            version: null,
            revision: null,
            jobsCompressed: false,
          };
      const bundle = loaded.bundle;
      applyBundleToDisk(bundle);
      compactDurableOpsOnDisk();
      state.hydrated = true;
      state.lastHydratedAt = new Date().toISOString();
      state.bundleVersion = loaded.version;
      state.bundleRevision = loaded.revision;
      state.jobsCompressed = loaded.jobsCompressed;
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
    const saved = await saveMongoBundle(
      bundle,
      state.bundleRevision,
      state.jobsCompressed
    );
    state.bundleVersion = saved.version;
    state.bundleRevision = saved.revision;
    state.jobsCompressed = saved.jobsCompressed;
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
