/**
 * Lightweight export / restore of the production ops bundle.
 *
 *   npx tsx scripts/export-ops-bundle.ts
 *   npx tsx scripts/export-ops-bundle.ts --restore path/to/bundle.json
 *
 * Never touches the canonical LIVE_OOS tape.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import { getMongoDb } from "@/lib/db/mongodb";
import {
  decodeMongoBundleFromStorage,
  encodeMongoBundleForStorage,
  mergeMongoContextDocumentsWithLegacy,
  mergeMongoProvenanceDocumentsWithLegacy,
  nextMongoBundleRevision,
  requireCompleteMongoStoredBundle,
  type DurableBundle,
  type MongoContextSnapshotDocument,
  type MongoProvenanceRecordDocument,
} from "@/lib/competitions/premier-league/ops/durable-store";
import {
  acquireTickLock,
  releaseTickLock,
} from "@/lib/competitions/premier-league/ops/tick-lock";
import {
  canonicalJson,
} from "@/lib/competitions/premier-league/provenance/canonical";
import {
  parseProvenanceRecordsJsonl,
  serializeProvenanceRecordsJsonl,
} from "@/lib/competitions/premier-league/provenance/durable";
import {
  assertForecastInputManifestReferences,
  assertVerifiedRatingStateLineage,
  provenanceRecordId,
} from "@/lib/competitions/premier-league/provenance/manifest";
import {
  PROVENANCE_RECORD_KINDS,
  type ForecastInputManifest,
  type ManifestReferenceSet,
  type ProvenanceRecord,
  type ProvenanceRecordKind,
} from "@/lib/competitions/premier-league/provenance/types";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
export const BACKUP_SCHEMA = "football-oracle-ops-backup-v3";
const CONTEXT_COLLECTION = "pl_match_context_snapshots";
export const PROVENANCE_COLLECTION = "pl_provenance_records";

export type ProvenanceCountsByKind = Readonly<Record<ProvenanceRecordKind, number>>;

export interface OpsBackupV3 {
  schemaVersion: typeof BACKUP_SCHEMA;
  exportedAt: string;
  database: string;
  collection: "pl_ops_bundle";
  contextCollection: typeof CONTEXT_COLLECTION;
  id: "current";
  updatedAt: unknown;
  bundle: unknown;
  contextDocuments: unknown;
  contextCount: number;
  contextSha256: string;
  provenanceCollection: typeof PROVENANCE_COLLECTION;
  provenanceDocuments: MongoProvenanceRecordDocument[];
  provenanceCount: number;
  provenanceCountsByKind: ProvenanceCountsByKind;
  provenanceSha256: string;
}

export type ProvenanceBackupSection = Pick<
  OpsBackupV3,
  | "provenanceCollection"
  | "provenanceDocuments"
  | "provenanceCount"
  | "provenanceCountsByKind"
  | "provenanceSha256"
>;

function resolvedTargetPath(file: string): string {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const suffix: string[] = [path.basename(absolute)];
  let parent = path.dirname(absolute);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) break;
    suffix.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...suffix);
}

export function assertNotTape(file: string): void {
  if (resolvedTargetPath(file) === fs.realpathSync(TAPE)) {
    throw new Error("Refusing to write an ops bundle onto the canonical LIVE_OOS tape.");
  }
}

function requireMongoBackend(): void {
  if (process.env.MONGODB_DB !== "football_oracle") {
    throw new Error("ops bundle backup/restore requires MONGODB_DB=football_oracle");
  }
  if (process.env.PL_OPS_BACKEND && process.env.PL_OPS_BACKEND !== "mongo") {
    throw new Error("ops bundle backup/restore requires PL_OPS_BACKEND=mongo");
  }
  process.env.PL_OPS_BACKEND = "mongo";
}

function requireContextDocuments(
  value: unknown,
  sourceLabel: string
): MongoContextSnapshotDocument[] {
  if (!Array.isArray(value)) throw new Error(`${sourceLabel} must be an array`);
  const documents = value as MongoContextSnapshotDocument[];
  const ids = new Set<string>();
  for (const [index, document] of documents.entries()) {
    if (
      !document ||
      typeof document !== "object" ||
      typeof document._id !== "string" ||
      typeof document.insertedAt !== "string" ||
      !Number.isFinite(Date.parse(document.insertedAt)) ||
      !document.snapshot ||
      typeof document.snapshot !== "object"
    ) {
      throw new Error(`${sourceLabel}[${index}] is incomplete`);
    }
    if (ids.has(document._id)) throw new Error(`${sourceLabel} contains duplicate _id`);
    ids.add(document._id);
  }
  // Validates every content address and snapshot hash before any DB mutation.
  mergeMongoContextDocumentsWithLegacy(documents, "");
  return documents;
}

function contextDocumentsFromJsonl(
  text: string,
  existing: readonly MongoContextSnapshotDocument[],
  fallbackInsertedAt: string
): MongoContextSnapshotDocument[] {
  const byId = new Map(existing.map(document => [document._id, document]));
  return text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const snapshot = JSON.parse(line) as MongoContextSnapshotDocument["snapshot"];
      return byId.get(snapshot.contextId) ?? {
        _id: snapshot.contextId,
        snapshot,
        insertedAt: fallbackInsertedAt,
      };
    });
}

function contextManifest(documents: readonly MongoContextSnapshotDocument[]): {
  count: number;
  sha256: string;
} {
  const payload = documents
    .slice()
    .sort((a, b) => a._id.localeCompare(b._id))
    .map(document => JSON.stringify({
      _id: document._id,
      snapshot: document.snapshot,
      insertedAt: document.insertedAt,
    }))
    .join("\n");
  return {
    count: documents.length,
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

function emptyProvenanceCounts(): Record<ProvenanceRecordKind, number> {
  return Object.fromEntries(
    PROVENANCE_RECORD_KINDS.map((recordKind) => [recordKind, 0])
  ) as Record<ProvenanceRecordKind, number>;
}

/**
 * Validate exact Mongo provenance documents and retain their insert metadata.
 * Backup bytes are required to be sorted so the on-disk representation is
 * deterministic, independently of Mongo cursor or JavaScript insertion order.
 */
export function requireProvenanceDocuments(
  value: unknown,
  sourceLabel: string
): MongoProvenanceRecordDocument[] {
  if (!Array.isArray(value)) throw new Error(`${sourceLabel} must be an array`);
  const documents = value as MongoProvenanceRecordDocument[];
  const ids = new Set<string>();
  for (const [index, document] of documents.entries()) {
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof document._id !== "string" ||
      !document._id ||
      typeof document.insertedAt !== "string" ||
      !Number.isFinite(Date.parse(document.insertedAt)) ||
      !document.record ||
      typeof document.record !== "object" ||
      Array.isArray(document.record)
    ) {
      throw new Error(`${sourceLabel}[${index}] is incomplete`);
    }
    if (ids.has(document._id)) {
      throw new Error(`${sourceLabel} contains duplicate _id ${document._id}`);
    }
    ids.add(document._id);
  }
  const sorted = documents.slice().sort((a, b) => a._id.localeCompare(b._id));
  if (documents.some((document, index) => document._id !== sorted[index]?._id)) {
    throw new Error(`${sourceLabel} must be sorted by _id`);
  }
  // Validates every record's schema, content address, embedded hashes, _id,
  // insertedAt, and same-id collision semantics.
  mergeMongoProvenanceDocumentsWithLegacy(sorted, "");
  return sorted.map((document) => ({
    _id: document._id,
    record: JSON.parse(canonicalJson(document.record)) as ProvenanceRecord,
    insertedAt: document.insertedAt,
  }));
}

function provenanceDocumentsFromJsonl(
  text: string,
  existing: readonly MongoProvenanceRecordDocument[],
  fallbackInsertedAt: string
): MongoProvenanceRecordDocument[] {
  const byId = new Map(existing.map((document) => [document._id, document]));
  return parseProvenanceRecordsJsonl(text, "ops backup provenance union")
    .map((record) => {
      const recordId = provenanceRecordId(record);
      return byId.get(recordId) ?? {
        _id: recordId,
        record,
        insertedAt: fallbackInsertedAt,
      };
    })
    .sort((a, b) => a._id.localeCompare(b._id));
}

export function provenanceManifest(
  documents: readonly MongoProvenanceRecordDocument[]
): {
  count: number;
  countsByKind: ProvenanceCountsByKind;
  sha256: string;
} {
  const validated = requireProvenanceDocuments(
    documents,
    "provenance manifest documents"
  );
  const countsByKind = emptyProvenanceCounts();
  for (const document of validated) countsByKind[document.record.recordKind] += 1;
  const payload = validated
    .map((document) => canonicalJson({
      _id: document._id,
      record: document.record,
      insertedAt: document.insertedAt,
    }))
    .join("\n");
  return {
    count: validated.length,
    countsByKind: Object.freeze({ ...countsByKind }),
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

export function buildProvenanceBackupSection(
  documents: readonly MongoProvenanceRecordDocument[]
): ProvenanceBackupSection {
  const provenanceDocuments = requireProvenanceDocuments(
    documents,
    "provenance backup section"
  );
  requireResolvedProvenanceGraph(
    provenanceDocuments.map((document) => document.record)
  );
  const summary = provenanceManifest(provenanceDocuments);
  return {
    provenanceCollection: PROVENANCE_COLLECTION,
    provenanceDocuments,
    provenanceCount: summary.count,
    provenanceCountsByKind: summary.countsByKind,
    provenanceSha256: summary.sha256,
  };
}

export function requireProvenanceBackupSection(
  value: unknown,
  sourceLabel: string
): ProvenanceBackupSection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be an object`);
  }
  const input = value as Partial<ProvenanceBackupSection>;
  if (input.provenanceCollection !== PROVENANCE_COLLECTION) {
    throw new Error(`${sourceLabel} has the wrong provenance collection`);
  }
  const provenanceDocuments = requireProvenanceDocuments(
    input.provenanceDocuments,
    `${sourceLabel}.provenanceDocuments`
  );
  const summary = provenanceManifest(provenanceDocuments);
  if (
    input.provenanceCount !== summary.count ||
    !input.provenanceCountsByKind ||
    typeof input.provenanceCountsByKind !== "object" ||
    Array.isArray(input.provenanceCountsByKind) ||
    canonicalJson(input.provenanceCountsByKind) !== canonicalJson(summary.countsByKind) ||
    input.provenanceSha256 !== summary.sha256
  ) {
    throw new Error(`${sourceLabel} provenance count/per-kind/checksum mismatch`);
  }
  requireResolvedProvenanceGraph(
    provenanceDocuments.map((document) => document.record)
  );
  return {
    provenanceCollection: PROVENANCE_COLLECTION,
    provenanceDocuments,
    provenanceCount: summary.count,
    provenanceCountsByKind: summary.countsByKind,
    provenanceSha256: summary.sha256,
  };
}

function requireRecordKind<K extends ProvenanceRecordKind>(
  byId: ReadonlyMap<string, ProvenanceRecord>,
  recordId: string,
  expectedKind: K,
  label: string
): Extract<ProvenanceRecord, { recordKind: K }> {
  const record = byId.get(recordId);
  if (!record) throw new Error(`${label} is missing provenance record ${recordId}`);
  if (record.recordKind !== expectedKind) {
    throw new Error(
      `${label} references ${recordId} as ${expectedKind}, found ${record.recordKind}`
    );
  }
  return record as Extract<ProvenanceRecord, { recordKind: K }>;
}

/** Verify that every immutable cross-record edge resolves to exact stored bytes. */
export function requireResolvedProvenanceGraph(
  records: readonly ProvenanceRecord[]
): void {
  const validated = parseProvenanceRecordsJsonl(
    serializeProvenanceRecordsJsonl(records),
    "ops backup provenance graph"
  );
  const byId = new Map(validated.map((record) => [provenanceRecordId(record), record]));
  for (const record of validated) {
    if (record.recordKind === "FIXTURE_REVISION" && record.supersedesFixtureRevisionId) {
      const previous = requireRecordKind(
        byId,
        record.supersedesFixtureRevisionId,
        "FIXTURE_REVISION",
        record.fixtureRevisionId
      );
      if (
        previous.competition !== record.competition ||
        previous.season !== record.season ||
        previous.fixtureId !== record.fixtureId ||
        Date.parse(previous.availableAt) > Date.parse(record.availableAt)
      ) {
        throw new Error(`${record.fixtureRevisionId} has incompatible fixture supersession`);
      }
    }
    if (record.recordKind === "RESULT_REVISION" && record.supersedesResultRevisionId) {
      const previous = requireRecordKind(
        byId,
        record.supersedesResultRevisionId,
        "RESULT_REVISION",
        record.resultRevisionId
      );
      if (
        previous.competition !== record.competition ||
        previous.season !== record.season ||
        previous.fixtureId !== record.fixtureId ||
        Date.parse(previous.availableAt) > Date.parse(record.availableAt)
      ) {
        throw new Error(`${record.resultRevisionId} has incompatible result supersession`);
      }
    }
    if (record.recordKind === "RESULT_CORRECTION") {
      const previous = requireRecordKind(
        byId,
        record.previousResultRevisionId,
        "RESULT_REVISION",
        record.correctionId
      );
      const corrected = requireRecordKind(
        byId,
        record.correctedResultRevisionId,
        "RESULT_REVISION",
        record.correctionId
      );
      if (
        previous.fixtureId !== record.fixtureId ||
        corrected.fixtureId !== record.fixtureId ||
        previous.season !== corrected.season ||
        corrected.supersedesResultRevisionId !== previous.resultRevisionId
      ) {
        throw new Error(`${record.correctionId} has incompatible result-correction lineage`);
      }
    }
    if (record.recordKind === "RATING_STATE") {
      const membership = requireRecordKind(
        byId,
        record.seasonMembershipSnapshotId,
        "SEASON_MEMBERSHIP",
        record.ratingStateId
      );
      if (
        membership.competition !== record.competition ||
        membership.season !== record.season ||
        canonicalJson(membership.teamSlugs) !== canonicalJson(record.state.clubSlugs)
      ) {
        throw new Error(`${record.ratingStateId} has incompatible season membership`);
      }
      for (const event of record.ratingEvents) {
        if (event.resultRevisionId) {
          const result = requireRecordKind(
            byId,
            event.resultRevisionId,
            "RESULT_REVISION",
            `${record.ratingStateId}/${event.ratingEventId}`
          );
          if (result.fixtureId !== event.fixtureId) {
            throw new Error(
              `${record.ratingStateId}/${event.ratingEventId} result fixture mismatch`
            );
          }
        }
        if (event.fixtureRevisionId) {
          const fixture = requireRecordKind(
            byId,
            event.fixtureRevisionId,
            "FIXTURE_REVISION",
            `${record.ratingStateId}/${event.ratingEventId}`
          );
          if (fixture.fixtureId !== event.fixtureId) {
            throw new Error(
              `${record.ratingStateId}/${event.ratingEventId} fixture revision mismatch`
            );
          }
        }
      }
      if (record.ratingResultLineageStatus === "VERIFIED") {
        assertVerifiedRatingStateLineage({
          ratingState: record,
          resultRevisions: record.ratingEvents.map((event) =>
            requireRecordKind(
              byId,
              String(event.resultRevisionId ?? ""),
              "RESULT_REVISION",
              `${record.ratingStateId}/${event.ratingEventId}`
            )
          ),
          fixtureRevisions: record.ratingEvents.map((event) =>
            requireRecordKind(
              byId,
              String(event.fixtureRevisionId ?? ""),
              "FIXTURE_REVISION",
              `${record.ratingStateId}/${event.ratingEventId}`
            )
          ),
          seasonMembership: membership,
          cutoffAt: record.asOf,
        });
      }
    }
    if (record.recordKind === "FORECAST_INPUT_MANIFEST") {
      const ratingState = requireRecordKind(
        byId,
        record.ratingStateId,
        "RATING_STATE",
        record.manifestId
      );
      const references: ManifestReferenceSet = {
        fixtureRevision: requireRecordKind(
          byId,
          record.fixtureRevisionId,
          "FIXTURE_REVISION",
          record.manifestId
        ),
        seasonMembership: requireRecordKind(
          byId,
          record.seasonMembershipSnapshotId,
          "SEASON_MEMBERSHIP",
          record.manifestId
        ),
        ratingState,
        modelBundle: requireRecordKind(
          byId,
          record.modelBundleId,
          "MODEL_BUNDLE",
          record.manifestId
        ),
        ratingResultRevisions: ratingState.ratingEvents.map((event) =>
          requireRecordKind(
            byId,
            String(event.resultRevisionId ?? ""),
            "RESULT_REVISION",
            `${record.manifestId}/${event.ratingEventId}`
          )
        ),
        ratingFixtureRevisions: ratingState.ratingEvents.map((event) =>
          requireRecordKind(
            byId,
            String(event.fixtureRevisionId ?? ""),
            "FIXTURE_REVISION",
            `${record.manifestId}/${event.ratingEventId}`
          )
        ),
      };
      assertForecastInputManifestReferences(
        record as ForecastInputManifest,
        references
      );
    }
  }
}

function collectInputManifestIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) collectInputManifestIds(child, ids);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "inputManifestId" && typeof child === "string" && child.trim()) {
      ids.add(child);
    }
    collectInputManifestIds(child, ids);
  }
}

function requireResolvedBundleProvenanceReferences(
  bundle: DurableBundle,
  records: readonly ProvenanceRecord[]
): void {
  const referenced = new Set<string>();
  for (const text of Object.values(bundle)) {
    if (!text.trim()) continue;
    try {
      collectInputManifestIds(JSON.parse(text), referenced);
      continue;
    } catch {
      // JSONL fields are validated by decodeMongoBundleFromStorage.
    }
    for (const line of text.split("\n")) {
      if (line.trim()) collectInputManifestIds(JSON.parse(line), referenced);
    }
  }
  const manifests = new Set(
    records
      .filter(
        (record): record is ForecastInputManifest =>
          record.recordKind === "FORECAST_INPUT_MANIFEST"
      )
      .map((record) => record.manifestId)
  );
  const missing = [...referenced].filter((manifestId) => !manifests.has(manifestId)).sort();
  if (missing.length) {
    throw new Error(
      `ops backup is missing ${missing.length} referenced provenance manifest(s): ${missing[0]}`
    );
  }
}

function remainingRestoreTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("ops provenance restore deadline exceeded");
  return Math.max(1, remaining);
}

/**
 * Restore immutable children without any delete or overwrite operation. A
 * same-id pre-existing document is accepted only when its complete canonical
 * document (including insertedAt) equals the backup, verified by read-back.
 */
export async function restoreImmutableProvenanceDocuments(
  collection: Collection<MongoProvenanceRecordDocument>,
  documents: readonly MongoProvenanceRecordDocument[],
  deadline = Date.now() + 45_000
): Promise<number> {
  const expected = requireProvenanceDocuments(
    documents,
    "ops provenance restore documents"
  );
  requireResolvedProvenanceGraph(expected.map((document) => document.record));
  const operations: AnyBulkWriteOperation<MongoProvenanceRecordDocument>[] = expected.map(
    (document) => ({
      updateOne: {
        filter: { _id: document._id },
        update: {
          $setOnInsert: {
            record: document.record,
            insertedAt: document.insertedAt,
          },
        },
        upsert: true,
      },
    })
  );
  for (let index = 0; index < operations.length; index += 100) {
    await collection.bulkWrite(operations.slice(index, index + 100), {
      ordered: false,
      timeoutMS: remainingRestoreTime(deadline),
    });
  }
  for (let index = 0; index < expected.length; index += 100) {
    const batch = expected.slice(index, index + 100);
    const ids = batch.map((document) => document._id);
    const stored = await collection
      .find(
        { _id: { $in: ids } },
        {
          projection: { record: 1, insertedAt: 1 },
          timeoutMS: remainingRestoreTime(deadline),
        }
      )
      .sort({ _id: 1 })
      .toArray();
    const verified = requireProvenanceDocuments(
      stored,
      "restored Mongo provenance read-back"
    );
    const verifiedById = new Map(
      verified.map((document) => [document._id, canonicalJson(document)])
    );
    for (const document of batch) {
      if (verifiedById.get(document._id) !== canonicalJson(document)) {
        throw new Error(`Mongo provenance immutable read-back mismatch for ${document._id}`);
      }
    }
  }
  return expected.length;
}

/** Restore immutable match contexts without deleting newer evidence. */
export async function restoreImmutableContextDocuments(
  collection: Collection<MongoContextSnapshotDocument>,
  documents: readonly MongoContextSnapshotDocument[],
  deadline = Date.now() + 45_000
): Promise<number> {
  const expected = requireContextDocuments(
    documents,
    "ops context restore documents"
  );
  const operations: AnyBulkWriteOperation<MongoContextSnapshotDocument>[] = expected.map(
    (document) => ({
      updateOne: {
        filter: { _id: document._id },
        update: {
          $setOnInsert: {
            snapshot: document.snapshot,
            insertedAt: document.insertedAt,
          },
        },
        upsert: true,
      },
    })
  );
  for (let index = 0; index < operations.length; index += 100) {
    await collection.bulkWrite(operations.slice(index, index + 100), {
      ordered: false,
      timeoutMS: remainingRestoreTime(deadline),
    });
  }
  for (let index = 0; index < expected.length; index += 100) {
    const batch = expected.slice(index, index + 100);
    const ids = batch.map((document) => document._id);
    const stored = await collection
      .find(
        { _id: { $in: ids } },
        {
          projection: { snapshot: 1, insertedAt: 1 },
          timeoutMS: remainingRestoreTime(deadline),
        }
      )
      .sort({ _id: 1 })
      .toArray();
    const verified = requireContextDocuments(
      stored,
      "restored Mongo context read-back"
    );
    const verifiedById = new Map(
      verified.map((document) => [document._id, canonicalJson(document)])
    );
    for (const document of batch) {
      if (verifiedById.get(document._id) !== canonicalJson(document)) {
        throw new Error(`Mongo context immutable read-back mismatch for ${document._id}`);
      }
    }
  }
  return expected.length;
}

function collectContextSnapshotIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectContextSnapshotIds(item, ids);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "contextSnapshotId" && typeof child === "string" && child.trim()) {
      ids.add(child);
    }
    collectContextSnapshotIds(child, ids);
  }
}

function requireResolvedContextReferences(
  bundle: DurableBundle,
  contextDocuments: readonly MongoContextSnapshotDocument[]
): void {
  const referenced = new Set<string>();
  for (const key of [
    "jobs",
    "operationalLiveOos",
    "settlements",
    "workingSnapshots",
  ] as const) {
    for (const line of bundle[key].split("\n")) {
      if (line.trim()) collectContextSnapshotIds(JSON.parse(line), referenced);
    }
  }
  const available = new Set(contextDocuments.map(document => document._id));
  const missing = [...referenced].filter(contextId => !available.has(contextId)).sort();
  if (missing.length) {
    throw new Error(
      `ops backup is missing ${missing.length} referenced context document(s): ${missing[0]}`
    );
  }
}

export function exactContextDocumentsForRestore(input: {
  backupDocuments: readonly MongoContextSnapshotDocument[];
  legacyJsonl: string;
  fallbackInsertedAt: string;
}): MongoContextSnapshotDocument[] {
  const backupDocuments = requireContextDocuments(
    input.backupDocuments,
    "ops backup contextDocuments"
  );
  const exact = requireContextDocuments(
    contextDocumentsFromJsonl(
      mergeMongoContextDocumentsWithLegacy(backupDocuments, input.legacyJsonl),
      backupDocuments,
      input.fallbackInsertedAt
    ),
    "exact ops backup context union"
  );
  if (canonicalJson(exact) !== canonicalJson(backupDocuments)) {
    throw new Error(
      "ops backup contextDocuments do not contain the exact bundle/collection union"
    );
  }
  return exact;
}

async function exportBundle(dest: string): Promise<void> {
  assertNotTape(dest);
  requireMongoBackend();
  const lock = await acquireTickLock("ops-bundle-export");
  if (!lock.ok) throw new Error(`cannot export while ${lock.reason ?? "tick lock is unavailable"}`);
  try {
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
    const [doc, rawContextDocuments, rawProvenanceDocuments] = await Promise.all([
      db.collection("pl_ops_bundle").findOne(
        { _id: "current" as never },
        { timeoutMS: 30_000 }
      ),
      db.collection<MongoContextSnapshotDocument>(CONTEXT_COLLECTION)
        .find({}, { timeoutMS: 30_000 })
        .sort({ _id: 1 })
        .toArray(),
      db.collection<MongoProvenanceRecordDocument>(PROVENANCE_COLLECTION)
        .find(
          {},
          {
            projection: { record: 1, insertedAt: 1 },
            timeoutMS: 30_000,
          }
        )
        .sort({ _id: 1 })
        .toArray(),
    ]);
    const exportDoc = doc as unknown as { updatedAt?: unknown; bundle?: unknown } | null;
    if (!exportDoc?.bundle) {
      throw new Error("production ops bundle is missing; refusing an empty export");
    }
    const bundle = requireCompleteMongoStoredBundle(
      exportDoc.bundle,
      "production ops export"
    );
    const logicalBundle = decodeMongoBundleFromStorage(bundle, "production ops export");
    const collectionContextDocuments = requireContextDocuments(
      rawContextDocuments,
      "production context export"
    );
    const exportedAt = new Date().toISOString();
    const contextDocuments = requireContextDocuments(
      contextDocumentsFromJsonl(
        mergeMongoContextDocumentsWithLegacy(
          collectionContextDocuments,
          logicalBundle.contextSnapshots ?? ""
        ),
        collectionContextDocuments,
        exportedAt
      ),
      "combined production context export"
    );
    const contextSummary = contextManifest(contextDocuments);
    requireResolvedContextReferences(logicalBundle, contextDocuments);
    const collectionProvenanceDocuments = requireProvenanceDocuments(
      rawProvenanceDocuments,
      "production provenance export"
    );
    const provenanceDocuments = requireProvenanceDocuments(
      provenanceDocumentsFromJsonl(
        mergeMongoProvenanceDocumentsWithLegacy(
          collectionProvenanceDocuments,
          logicalBundle.provenanceRecords ?? ""
        ),
        collectionProvenanceDocuments,
        exportedAt
      ),
      "combined production provenance export"
    );
    const provenanceSection = buildProvenanceBackupSection(provenanceDocuments);
    requireResolvedBundleProvenanceReferences(
      logicalBundle,
      provenanceDocuments.map((document) => document.record)
    );
    const payload: OpsBackupV3 = {
      schemaVersion: BACKUP_SCHEMA,
      exportedAt,
      database: "football_oracle",
      collection: "pl_ops_bundle",
      contextCollection: CONTEXT_COLLECTION,
      id: "current",
      updatedAt: exportDoc.updatedAt ?? null,
      bundle,
      contextDocuments,
      contextCount: contextSummary.count,
      contextSha256: contextSummary.sha256,
      ...provenanceSection,
    };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const temporary = path.join(
      path.dirname(dest),
      `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      fs.renameSync(temporary, dest);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log(
      `exported ops bundle + ${contextDocuments.length} contexts + ` +
      `${provenanceDocuments.length} provenance records → ${dest}`
    );
  } finally {
    await releaseTickLock(lock.leaseId);
  }
}

async function restoreBundle(src: string): Promise<void> {
  assertNotTape(src);
  if (!fs.existsSync(src)) throw new Error(`missing backup file: ${src}`);
  requireMongoBackend();
  const parsed = JSON.parse(fs.readFileSync(src, "utf8")) as Partial<OpsBackupV3>;
  if (parsed.schemaVersion !== BACKUP_SCHEMA) {
    throw new Error(
      `restore requires ${BACKUP_SCHEMA}; backups without immutable provenance are not safe`
    );
  }
  if (typeof parsed.exportedAt !== "string" || !Number.isFinite(Date.parse(parsed.exportedAt))) {
    throw new Error("ops backup exportedAt is missing or invalid");
  }
  const targetDatabase = process.env.MONGODB_DB;
  if (
    parsed.database !== targetDatabase ||
    parsed.collection !== "pl_ops_bundle" ||
    parsed.contextCollection !== CONTEXT_COLLECTION ||
    parsed.provenanceCollection !== PROVENANCE_COLLECTION ||
    parsed.id !== "current"
  ) {
    throw new Error("ops backup identity does not match the target durable store");
  }
  const storedBundle = requireCompleteMongoStoredBundle(
    parsed.bundle,
    "ops bundle restore input"
  );
  // Validate every logical field and verify compressed-job checksums before
  // taking the production writer lease or mutating Atlas.
  const logicalBundle = decodeMongoBundleFromStorage(
    storedBundle,
    "ops bundle restore input"
  );
  const backupContextDocuments = requireContextDocuments(
    parsed.contextDocuments,
    "ops backup contextDocuments"
  );
  const manifest = contextManifest(backupContextDocuments);
  if (
    parsed.contextCount !== manifest.count ||
    parsed.contextSha256 !== manifest.sha256
  ) {
    throw new Error("ops backup context count/checksum mismatch");
  }
  const exactContextDocuments = exactContextDocumentsForRestore({
    backupDocuments: backupContextDocuments,
    legacyJsonl: logicalBundle.contextSnapshots ?? "",
    fallbackInsertedAt: parsed.exportedAt,
  });
  requireResolvedContextReferences(logicalBundle, exactContextDocuments);
  const backupProvenanceDocuments = requireProvenanceBackupSection(
    parsed,
    "ops backup"
  ).provenanceDocuments;
  const exactProvenanceDocuments = requireProvenanceDocuments(
    provenanceDocumentsFromJsonl(
      mergeMongoProvenanceDocumentsWithLegacy(
        backupProvenanceDocuments,
        logicalBundle.provenanceRecords ?? ""
      ),
      backupProvenanceDocuments,
      parsed.exportedAt
    ),
    "exact ops backup provenance union"
  );
  if (canonicalJson(exactProvenanceDocuments) !== canonicalJson(backupProvenanceDocuments)) {
    throw new Error(
      "ops backup provenanceDocuments do not contain the exact bundle/collection union"
    );
  }
  const provenanceRecords = exactProvenanceDocuments.map(
    (document) => document.record
  );
  requireResolvedProvenanceGraph(provenanceRecords);
  requireResolvedBundleProvenanceReferences(logicalBundle, provenanceRecords);
  // Legacy/plain backups are upgraded during restore so they cannot recreate
  // the multi-megabyte hydration bottleneck that this recovery path repairs.
  const storageBundle = encodeMongoBundleForStorage(logicalBundle);
  const lock = await acquireTickLock("ops-bundle-restore");
  if (!lock.ok) throw new Error(`cannot restore while ${lock.reason ?? "tick lock is unavailable"}`);
  try {
    // One shared budget stays safely inside the 90-second writer lease. Every
    // child read-back and the parent transaction consume this same deadline.
    const restoreDeadline = Date.now() + 60_000;
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
    // Child provenance is written before the parent bundle. A later failure can
    // leave only harmless immutable orphans; it cannot create a parent whose
    // manifest references are absent. Existing child records are never deleted
    // or overwritten and must compare equal after the $setOnInsert retry.
    await restoreImmutableProvenanceDocuments(
      db.collection<MongoProvenanceRecordDocument>(PROVENANCE_COLLECTION),
      exactProvenanceDocuments,
      restoreDeadline
    );
    await restoreImmutableContextDocuments(
      db.collection<MongoContextSnapshotDocument>(CONTEXT_COLLECTION),
      exactContextDocuments,
      restoreDeadline
    );
    const transactionBudget = Math.min(30_000, remainingRestoreTime(restoreDeadline));
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await db.collection("pl_ops_bundle").updateOne(
          { _id: "current" as never },
          {
            $set: {
              bundle: storageBundle,
              updatedAt: nextMongoBundleRevision(),
              restoredFrom: src,
            },
          },
          { upsert: true, session }
        );
        if (result.matchedCount + result.upsertedCount !== 1) {
          throw new Error("restored ops bundle write did not affect exactly one document");
        }
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        timeoutMS: transactionBudget,
        maxCommitTimeMS: transactionBudget,
      });
    } finally {
      await session.endSession();
    }
    console.log(
      `restored ops bundle + ${exactContextDocuments.length} contexts + ` +
      `${exactProvenanceDocuments.length} immutable provenance records from ${src}`
    );
  } finally {
    await releaseTickLock(lock.leaseId);
  }
}

async function main() {
  const restoreIdx = process.argv.indexOf("--restore");
  if (restoreIdx >= 0) {
    const src = process.argv[restoreIdx + 1];
    if (!src) throw new Error("usage: --restore <file>");
    await restoreBundle(src);
    return;
  }
  const dest =
    process.argv[2] ||
    path.resolve(
      process.cwd(),
      "ops-backups",
      `pl-ops-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
  await exportBundle(dest);
}

const invokedAsScript = Boolean(
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
);

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
