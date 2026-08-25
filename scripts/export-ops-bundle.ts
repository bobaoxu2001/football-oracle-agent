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
import { getMongoDb } from "@/lib/db/mongodb";
import {
  decodeMongoBundleFromStorage,
  encodeMongoBundleForStorage,
  mergeMongoContextDocumentsWithLegacy,
  nextMongoBundleRevision,
  requireCompleteMongoStoredBundle,
  type DurableBundle,
  type MongoContextSnapshotDocument,
} from "@/lib/competitions/premier-league/ops/durable-store";
import {
  acquireTickLock,
  releaseTickLock,
} from "@/lib/competitions/premier-league/ops/tick-lock";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const BACKUP_SCHEMA = "football-oracle-ops-backup-v2";
const CONTEXT_COLLECTION = "pl_match_context_snapshots";

interface OpsBackupV2 {
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
}

function assertNotTape(file: string): void {
  if (path.resolve(file) === TAPE) {
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

async function exportBundle(dest: string): Promise<void> {
  assertNotTape(dest);
  requireMongoBackend();
  const lock = await acquireTickLock("ops-bundle-export");
  if (!lock.ok) throw new Error(`cannot export while ${lock.reason ?? "tick lock is unavailable"}`);
  try {
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
    const [doc, rawContextDocuments] = await Promise.all([
      db.collection("pl_ops_bundle").findOne(
        { _id: "current" as never },
        { timeoutMS: 30_000 }
      ),
      db.collection<MongoContextSnapshotDocument>(CONTEXT_COLLECTION)
        .find({}, { timeoutMS: 30_000 })
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
    const manifest = contextManifest(contextDocuments);
    requireResolvedContextReferences(logicalBundle, contextDocuments);
    const payload: OpsBackupV2 = {
      schemaVersion: BACKUP_SCHEMA,
      exportedAt,
      database: "football_oracle",
      collection: "pl_ops_bundle",
      contextCollection: CONTEXT_COLLECTION,
      id: "current",
      updatedAt: exportDoc.updatedAt ?? null,
      bundle,
      contextDocuments,
      contextCount: manifest.count,
      contextSha256: manifest.sha256,
    };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`exported ops bundle + ${contextDocuments.length} contexts → ${dest}`);
  } finally {
    await releaseTickLock(lock.leaseId);
  }
}

async function restoreBundle(src: string): Promise<void> {
  assertNotTape(src);
  if (!fs.existsSync(src)) throw new Error(`missing backup file: ${src}`);
  requireMongoBackend();
  const parsed = JSON.parse(fs.readFileSync(src, "utf8")) as Partial<OpsBackupV2>;
  if (parsed.schemaVersion !== BACKUP_SCHEMA) {
    throw new Error(`restore requires ${BACKUP_SCHEMA}; legacy partial backups are not safe`);
  }
  if (typeof parsed.exportedAt !== "string" || !Number.isFinite(Date.parse(parsed.exportedAt))) {
    throw new Error("ops backup exportedAt is missing or invalid");
  }
  const targetDatabase = process.env.MONGODB_DB;
  if (
    parsed.database !== targetDatabase ||
    parsed.collection !== "pl_ops_bundle" ||
    parsed.contextCollection !== CONTEXT_COLLECTION ||
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
  const contextJsonl = mergeMongoContextDocumentsWithLegacy(
    backupContextDocuments,
    logicalBundle.contextSnapshots ?? ""
  );
  const exactContextDocuments = contextDocumentsFromJsonl(
    contextJsonl,
    backupContextDocuments,
    parsed.exportedAt
  );
  requireResolvedContextReferences(logicalBundle, exactContextDocuments);
  // Legacy/plain backups are upgraded during restore so they cannot recreate
  // the multi-megabyte hydration bottleneck that this recovery path repairs.
  const storageBundle = encodeMongoBundleForStorage(logicalBundle);
  const lock = await acquireTickLock("ops-bundle-restore");
  if (!lock.ok) throw new Error(`cannot restore while ${lock.reason ?? "tick lock is unavailable"}`);
  try {
    const db = await getMongoDb();
    if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
    const session = db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const contexts = db.collection<MongoContextSnapshotDocument>(CONTEXT_COLLECTION);
        await contexts.deleteMany({}, { session });
        if (exactContextDocuments.length) {
          await contexts.insertMany(exactContextDocuments, {
            ordered: true,
            session,
          });
        }
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
        timeoutMS: 45_000,
        maxCommitTimeMS: 30_000,
      });
    } finally {
      await session.endSession();
    }
    console.log(
      `restored ops bundle + ${exactContextDocuments.length} contexts from ${src}`
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
