/**
 * Team News Store — persistence for the news intelligence layer.
 *
 * Primary: MongoDB `team_news` collection (MongoDB Partner Track), indexed on
 * team / publishedAt / category / impactLevel. Fallback: an in-process memory
 * store. As everywhere in this app, MongoDB is an enhancement — if it is
 * missing or unreachable, news still works and predictions never break.
 */

import { getMongoDb } from "@/lib/db/mongodb";
import type { Collection } from "mongodb";
import type { TeamNewsItem } from "./types";

const COLLECTION = "team_news";
const BATCH_COLLECTION = "team_news_batches";

interface StoredTeamNewsItem extends TeamNewsItem {
  batchId?: string;
}

interface ActiveNewsBatch {
  team: string;
  batchId: string;
  activatedAt: Date;
}

// ---- In-memory fallback ----
// Shared across route/page bundles via globalThis (see mongodb.ts for why).
const __g = globalThis as unknown as {
  __wcoaNewsMem?: TeamNewsItem[];
  __wcoaNewsLast?: Date | null;
};
const memoryStore: TeamNewsItem[] = (__g.__wcoaNewsMem ??= []);
const MEMORY_LIMIT = 500;

let indexesEnsured = false;

function markWrite() {
  __g.__wcoaNewsLast = new Date();
}

/** Timestamp of the most recent write (refresh or on-demand seed). */
export function getLastNewsUpdate(): Date | null {
  return __g.__wcoaNewsLast ?? null;
}

async function getCollection(): Promise<Collection<StoredTeamNewsItem> | null> {
  const db = await getMongoDb();
  if (!db) return null;
  const col = db.collection<StoredTeamNewsItem>(COLLECTION);
  if (!indexesEnsured) {
    try {
      await col.createIndexes([
        { key: { team: 1, publishedAt: -1 }, name: "team_publishedAt" },
        { key: { category: 1 }, name: "category" },
        { key: { impactLevel: 1 }, name: "impactLevel" },
        { key: { publishedAt: -1 }, name: "publishedAt" },
        { key: { team: 1, batchId: 1 }, name: "team_batch" },
      ]);
      indexesEnsured = true;
    } catch {
      /* indexes are best-effort */
    }
  }
  return col;
}

async function getBatchCollection(): Promise<Collection<ActiveNewsBatch> | null> {
  const db = await getMongoDb();
  return db ? db.collection<ActiveNewsBatch>(BATCH_COLLECTION) : null;
}

export interface SafeNewsBatchOperations {
  stage: () => Promise<void>;
  activate: () => Promise<void>;
  discardStage: () => Promise<void>;
  cleanupOld: () => Promise<void>;
}

/** Stage → activate pointer → cleanup. The last-known-good pointer moves only after staging succeeds. */
export async function replaceNewsBatchSafely(ops: SafeNewsBatchOperations): Promise<void> {
  try {
    await ops.stage();
    await ops.activate();
  } catch (error) {
    try {
      await ops.discardStage();
    } catch {
      /* rollback is best-effort; the active pointer still references the old batch */
    }
    throw error;
  }
  try {
    await ops.cleanupOld();
  } catch {
    /* stale inactive batches are harmless and can be cleaned on a later refresh */
  }
}

/** A stable key to de-duplicate news items (same team + title). */
function keyOf(it: TeamNewsItem): string {
  return `${it.team}::${it.title.trim().toLowerCase()}`;
}

/**
 * Upsert a batch of news items for a team. Replaces the team's prior items so
 * a refresh produces a clean, current set. Returns the backend used.
 */
export async function saveTeamNews(
  team: string,
  items: TeamNewsItem[]
): Promise<"mongodb" | "memory"> {
  const col = await getCollection();
  const batches = await getBatchCollection();
  if (col && batches) {
    const batchId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    const staged = items.map((item) => ({ ...item, batchId }));
    try {
      await replaceNewsBatchSafely({
        stage: async () => {
          if (staged.length) await col.insertMany(staged, { ordered: true });
        },
        activate: async () => {
          await batches.updateOne(
            { team },
            { $set: { team, batchId, activatedAt: new Date() } },
            { upsert: true }
          );
        },
        discardStage: async () => {
          await col.deleteMany({ team, batchId });
        },
        cleanupOld: async () => {
          await col.deleteMany({ team, batchId: { $ne: batchId } });
        },
      });
      markWrite();
      return "mongodb";
    } catch (err) {
      console.warn("[team_news] write failed — using memory:", (err as Error)?.message);
    }
  }
  // memory fallback: drop prior items for the team, then add the new set
  for (let i = memoryStore.length - 1; i >= 0; i--) {
    if (memoryStore[i].team === team) memoryStore.splice(i, 1);
  }
  memoryStore.push(...items);
  if (memoryStore.length > MEMORY_LIMIT) memoryStore.splice(0, memoryStore.length - MEMORY_LIMIT);
  markWrite();
  return "memory";
}

/** Aggregate private-storage stats for the compatibility status page. */
export async function getNewsStats(): Promise<{
  source: "mongodb" | "memory";
  total: number;
  lastUpdate: string | null;
}> {
  const col = await getCollection();
  if (col) {
    try {
      const total = await col.estimatedDocumentCount();
      return { source: "mongodb", total, lastUpdate: getLastNewsUpdate()?.toISOString() ?? null };
    } catch (err) {
      console.warn("[team_news] stats failed — using memory:", (err as Error)?.message);
    }
  }
  return {
    source: "memory",
    total: memoryStore.length,
    lastUpdate: getLastNewsUpdate()?.toISOString() ?? null,
  };
}

/** Recent news for a team, newest first. Always returns something usable. */
export async function getTeamNews(
  team: string,
  limit = 8
): Promise<{ items: TeamNewsItem[]; source: "mongodb" | "memory" }> {
  const col = await getCollection();
  if (col) {
    try {
      const batch = await (await getBatchCollection())?.findOne({ team });
      const filter = batch?.batchId ? { team, batchId: batch.batchId } : { team, batchId: { $exists: false } };
      const items = await col
        .find(filter, { projection: { _id: 0, batchId: 0 } })
        .sort({ publishedAt: -1 })
        .limit(limit)
        .toArray();
      return { items, source: "mongodb" };
    } catch (err) {
      console.warn("[team_news] query failed — using memory:", (err as Error)?.message);
    }
  }
  const items = memoryStore
    .filter((n) => n.team === team)
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
    .slice(0, limit);
  return { items, source: "memory" };
}

/** True if the store already has any items for a team (in memory or Mongo). */
export async function hasStoredNews(team: string): Promise<boolean> {
  const col = await getCollection();
  if (col) {
    try {
      const batch = await (await getBatchCollection())?.findOne({ team });
      const filter = batch?.batchId ? { team, batchId: batch.batchId } : { team, batchId: { $exists: false } };
      return (await col.countDocuments(filter, { limit: 1 })) > 0;
    } catch {
      /* fall through to memory */
    }
  }
  return memoryStore.some((n) => n.team === team);
}

export { keyOf };
