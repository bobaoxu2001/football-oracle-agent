/**
 * MongoDB memory layer — the agent's "remember what I predicted" step.
 *
 * Targets the MongoDB Partner Track. Every prediction interaction is persisted
 * so the agent has a memory of past sessions (the "Recent Predictions" rail).
 *
 * CRITICAL DEMO GUARANTEE: if MONGODB_URI is missing, invalid, or unreachable,
 * we transparently fall back to an in-process memory store. The app NEVER
 * crashes or blocks on the database — Mongo is an enhancement, not a dependency.
 */

import { MongoClient, type Collection, type Db } from "mongodb";

export interface StoredPrediction {
  userQuery: string;
  intent: string;
  teams: string[];
  prediction: {
    teamAWin: number;
    draw: number;
    teamBWin: number;
    confidence: number;
  } | null;
  simulationResult: {
    simulationsRun: number;
    mostLikelyScore: string;
    upsetProbability: number;
    summary: string;
  } | null;
  reasoningSteps: string[];
  explanation: string;
  followUpContext: string;
  createdAt: Date;
  // ── Structured-result extension (all OPTIONAL — older records lack them) ──
  language?: string;
  group?: string | null;
  tournamentStage?: string | null;
  summary?: string;
  rankings?: Array<Record<string, unknown>> | null;
  modelFactors?: Array<{ label: string; value: string; weight: string }>;
  rulesApplied?: string[];
  newsSignals?: string[];
  limitations?: string[];
  confidence?: number;
  /** Which LLM (if any) produced the narrative for this session. */
  llmProvider?: "deepseek" | "gemini" | null;
}

export type PersistMode = "mongodb" | "memory";

const DB_NAME = process.env.MONGODB_DB || "worldcup_oracle";
const COLLECTION = "predictions";

// ---- In-memory fallback store ----
// Hung off globalThis so the SAME store is shared across all route/page bundles
// in one server process (Next.js bundles each route separately, so a plain
// module-level array would not be shared between e.g. /api/agent/predict and
// the /memory page). With MongoDB configured this store is unused.
const __g = globalThis as unknown as { __wcoaPredMem?: StoredPrediction[] };
const memoryStore: StoredPrediction[] = (__g.__wcoaPredMem ??= []);
const MEMORY_LIMIT = 50;

// ---- Mongo connection (lazy, cached, fail-soft) ----
// The client promise lives on globalThis so ALL route/page bundles in one
// server process share a single pooled connection (Next bundles each route
// separately — a plain module variable would give every route its own client,
// and a transient failure in one bundle would strand it on the memory store).
// A failed connect is retried after a short cooldown instead of latching off
// forever, so a brief DNS/network blip doesn't permanently disable Atlas.
const __gm = globalThis as unknown as {
  __wcoaMongoClient?: Promise<MongoClient> | null;
  __wcoaMongoFailedAt?: number;
};
const RETRY_COOLDOWN_MS = 60_000;

function getClient(): Promise<MongoClient> | null {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!__gm.__wcoaMongoClient) {
    const failedAt = __gm.__wcoaMongoFailedAt ?? 0;
    if (Date.now() - failedAt < RETRY_COOLDOWN_MS) return null;
    const client = new MongoClient(uri, {
      // Serverless cold connects to Atlas (SRV + TLS + topology discovery) need
      // more headroom than a local box; 2.5s was too tight on Vercel.
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      // Bound already-connected operations as well. The driver defaults these
      // waits to unbounded, which let a degraded Atlas monitor pin Vercel
      // functions until the platform's 60-second runtime timeout.
      timeoutMS: 45_000,
      waitQueueTimeoutMS: 5_000,
      maxPoolSize: 10,
      maxConnecting: 2,
      maxIdleTimeMS: 60_000,
    });
    __gm.__wcoaMongoClient = client.connect().catch((err) => {
      console.warn("[mongodb] connection failed — using in-memory fallback:", err?.message);
      __gm.__wcoaMongoFailedAt = Date.now();
      __gm.__wcoaMongoClient = null;
      throw err;
    });
  }
  return __gm.__wcoaMongoClient;
}

export function mongoConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

/**
 * Shared DB handle for other collections (e.g. team_news) to reuse the same
 * pooled, fail-soft connection. Returns null when Mongo is absent/unreachable.
 */
export async function getMongoDb(): Promise<Db | null> {
  const cp = getClient();
  if (!cp) return null;
  try {
    const client = await cp;
    return client.db(DB_NAME);
  } catch {
    return null;
  }
}

async function getCollection(): Promise<Collection<StoredPrediction> | null> {
  const cp = getClient();
  if (!cp) return null;
  try {
    const client = await cp;
    return client.db(DB_NAME).collection<StoredPrediction>(COLLECTION);
  } catch {
    return null;
  }
}

/** Persist a prediction. Returns which backend actually stored it. */
export async function savePrediction(doc: StoredPrediction): Promise<PersistMode> {
  const col = await getCollection();
  if (col) {
    try {
      await col.insertOne(doc);
      return "mongodb";
    } catch (err) {
      console.warn("[mongodb] insert failed — falling back to memory:", (err as Error)?.message);
    }
  }
  memoryStore.unshift(doc);
  if (memoryStore.length > MEMORY_LIMIT) memoryStore.length = MEMORY_LIMIT;
  return "memory";
}

/** Whether a live MongoDB connection can actually be established right now. */
export async function mongoConnected(): Promise<boolean> {
  return (await getMongoDb()) !== null;
}

/** Count privately stored prediction sessions for operational status. */
export async function countPredictions(): Promise<{
  total: number;
  source: PersistMode;
}> {
  const col = await getCollection();
  if (col) {
    try {
      return { total: await col.estimatedDocumentCount(), source: "mongodb" };
    } catch {
      /* fall through */
    }
  }
  return { total: memoryStore.length, source: "memory" };
}

/** Fetch recent predictions (newest first). Always returns something. */
export async function getRecentPredictions(limit = 8): Promise<{
  items: StoredPrediction[];
  source: PersistMode;
}> {
  const col = await getCollection();
  if (col) {
    try {
      const items = await col
        .find({}, { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return { items, source: "mongodb" };
    } catch (err) {
      console.warn("[mongodb] query failed — falling back to memory:", (err as Error)?.message);
    }
  }
  return { items: memoryStore.slice(0, limit), source: "memory" };
}
