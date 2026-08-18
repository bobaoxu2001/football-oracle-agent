/**
 * Market time-series store.
 *
 * Separate Mongo collections — never the ops bundle document.
 * File backend is for isolated tests only.
 */

import fs from "node:fs";
import path from "node:path";
import { getMongoDb } from "@/lib/db/mongodb";
import { opsDir } from "../ops/paths";
import { appendJsonl, readJsonl, rewriteJsonl, readJsonFile, writeJsonFile } from "../ops/jsonl";
import type {
  MarketConsensusSnapshot,
  MarketEventMapping,
  MarketObservation,
  MarketPollJob,
  MarketRecorderState,
} from "./types";
import { MARKET_SOURCE_THE_ODDS_API } from "./types";

const COL_OBS = "market_observations";
const COL_CONSENSUS = "market_consensus";
const COL_MAPS = "market_event_maps";
const COL_JOBS = "market_poll_jobs";
const COL_STATE = "market_state";

export function marketStoreBackend(): "mongo" | "file" {
  if (process.env.MARKET_STORE_BACKEND === "file") return "file";
  if (process.env.MARKET_STORE_BACKEND === "mongo") return "mongo";
  if (process.env.VERCEL === "1" && process.env.MONGODB_URI) return "mongo";
  return "file";
}

function marketDir(): string {
  return process.env.MARKET_STORE_DIR || path.join(opsDir(), "market");
}

function emptyState(): MarketRecorderState {
  return {
    source: MARKET_SOURCE_THE_ODDS_API,
    sourceConfigured: false,
    lastSuccessAt: null,
    lastFailedAt: null,
    lastSkipAt: null,
    lastError: null,
    lastQuota: { remaining: null, used: null, lastRequestCost: null },
    nextPollAt: null,
    currentCadenceMs: null,
    firstMarketObservationAt: null,
    firstPollSource: null,
    firstPollSchemaVersion: null,
    firstPollDeployment: null,
    polls: 0,
  };
}

const g = globalThis as unknown as {
  __foaMarketMem?: {
    obs: Map<string, MarketObservation>;
    consensus: Map<string, MarketConsensusSnapshot>;
    maps: Map<string, MarketEventMapping>;
    jobs: Map<string, MarketPollJob>;
    state: MarketRecorderState;
    loadedFrom: string | null;
  };
  __foaMarketIndexes?: boolean;
};

function mem() {
  if (!g.__foaMarketMem) {
    g.__foaMarketMem = {
      obs: new Map(),
      consensus: new Map(),
      maps: new Map(),
      jobs: new Map(),
      state: emptyState(),
      loadedFrom: null,
    };
  }
  return g.__foaMarketMem;
}

export function resetMarketStoreForTests(): void {
  g.__foaMarketMem = undefined;
  g.__foaMarketIndexes = false;
}

function loadFileIfNeeded(): void {
  const dir = marketDir();
  const state = mem();
  if (state.loadedFrom === dir) return;
  state.obs.clear();
  state.consensus.clear();
  state.maps.clear();
  state.jobs.clear();
  for (const row of readJsonl<MarketObservation>(path.join(dir, "observations.jsonl"))) {
    if (!state.obs.has(row.observationId)) state.obs.set(row.observationId, row);
  }
  for (const row of readJsonl<MarketConsensusSnapshot>(path.join(dir, "consensus.jsonl"))) {
    if (!state.consensus.has(row.consensusId)) state.consensus.set(row.consensusId, row);
  }
  for (const row of readJsonl<MarketEventMapping>(path.join(dir, "maps.jsonl"))) {
    state.maps.set(row.mappingId, row);
  }
  for (const row of readJsonl<MarketPollJob>(path.join(dir, "jobs.jsonl"))) {
    state.jobs.set(row.pollJobId, row);
  }
  state.state = readJsonFile<MarketRecorderState>(path.join(dir, "state.json")) ?? emptyState();
  state.loadedFrom = dir;
}

async function ensureIndexes(): Promise<void> {
  if (g.__foaMarketIndexes) return;
  const db = await getMongoDb();
  if (!db) return;
  await db.collection(COL_OBS).createIndexes([
    { key: { observationId: 1 }, unique: true, name: "observationId_uq" },
    { key: { canonicalFixtureId: 1, retrievedAt: 1 }, name: "fixture_retrieved" },
    { key: { source: 1, sourceEventId: 1 }, name: "source_event" },
    { key: { canonicalFixtureId: 1, bookmakerKey: 1, retrievedAt: 1 }, name: "fixture_book_retrieved" },
    { key: { marketType: 1 }, name: "marketType" },
    { key: { origin: 1 }, name: "origin" },
  ]);
  await db.collection(COL_CONSENSUS).createIndexes([
    { key: { consensusId: 1 }, unique: true, name: "consensusId_uq" },
    { key: { canonicalFixtureId: 1, retrievedAt: 1 }, name: "fixture_retrieved" },
    { key: { origin: 1 }, name: "origin" },
  ]);
  await db.collection(COL_MAPS).createIndexes([{ key: { mappingId: 1 }, unique: true, name: "mappingId_uq" }]);
  await db.collection(COL_JOBS).createIndexes([{ key: { pollJobId: 1 }, unique: true, name: "pollJobId_uq" }]);
  g.__foaMarketIndexes = true;
}

export async function insertObservation(row: MarketObservation): Promise<"inserted" | "duplicate"> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("Mongo unavailable for market observations");
    await ensureIndexes();
    try {
      await db.collection(COL_OBS).insertOne({ ...row, _id: row.observationId } as never);
      return "inserted";
    } catch (err) {
      if (String((err as Error).message).includes("E11000") || (err as { code?: number }).code === 11000) {
        return "duplicate";
      }
      throw err;
    }
  }
  loadFileIfNeeded();
  if (mem().obs.has(row.observationId)) return "duplicate";
  mem().obs.set(row.observationId, row);
  appendJsonl(path.join(marketDir(), "observations.jsonl"), row);
  return "inserted";
}

export async function insertConsensus(row: MarketConsensusSnapshot): Promise<"inserted" | "duplicate"> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("Mongo unavailable for market consensus");
    await ensureIndexes();
    try {
      await db.collection(COL_CONSENSUS).insertOne({ ...row, _id: row.consensusId } as never);
      return "inserted";
    } catch (err) {
      if (String((err as Error).message).includes("E11000") || (err as { code?: number }).code === 11000) {
        return "duplicate";
      }
      throw err;
    }
  }
  loadFileIfNeeded();
  if (mem().consensus.has(row.consensusId)) return "duplicate";
  mem().consensus.set(row.consensusId, row);
  appendJsonl(path.join(marketDir(), "consensus.jsonl"), row);
  return "inserted";
}

export async function upsertMapping(row: MarketEventMapping): Promise<void> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("Mongo unavailable for market maps");
    await ensureIndexes();
    await db.collection(COL_MAPS).updateOne(
      { _id: row.mappingId } as never,
      { $set: { ...row } },
      { upsert: true }
    );
    return;
  }
  loadFileIfNeeded();
  mem().maps.set(row.mappingId, row);
  rewriteJsonl(path.join(marketDir(), "maps.jsonl"), [...mem().maps.values()]);
}

export async function getMapping(source: string, sourceEventId: string): Promise<MarketEventMapping | null> {
  const id = `${source}::${sourceEventId}`;
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return null;
    const doc = await db.collection(COL_MAPS).findOne({ mappingId: id });
    return (doc as unknown as MarketEventMapping) ?? null;
  }
  loadFileIfNeeded();
  return mem().maps.get(id) ?? null;
}

export async function insertPollJob(row: MarketPollJob): Promise<void> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("Mongo unavailable for market jobs");
    await ensureIndexes();
    await db.collection(COL_JOBS).updateOne(
      { _id: row.pollJobId } as never,
      { $set: { ...row } },
      { upsert: true }
    );
    return;
  }
  loadFileIfNeeded();
  mem().jobs.set(row.pollJobId, row);
  appendJsonl(path.join(marketDir(), "jobs.jsonl"), row);
}

export async function loadMarketState(): Promise<MarketRecorderState> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return emptyState();
    const doc = await db.collection(COL_STATE).findOne({ _id: "current" as never });
    if (!doc) return emptyState();
    const { _id: _ignored, ...rest } = doc as unknown as MarketRecorderState & { _id?: unknown };
    return { ...emptyState(), ...rest };
  }
  loadFileIfNeeded();
  return { ...mem().state };
}

export async function saveMarketState(next: MarketRecorderState): Promise<void> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("Mongo unavailable for market state");
    await db.collection(COL_STATE).updateOne(
      { _id: "current" as never },
      { $set: { ...next, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
    return;
  }
  loadFileIfNeeded();
  mem().state = next;
  writeJsonFile(path.join(marketDir(), "state.json"), next);
}

export async function listObservations(filter: { fixtureId?: string } = {}): Promise<MarketObservation[]> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return [];
    const q = filter.fixtureId ? { canonicalFixtureId: filter.fixtureId } : {};
    return (await db.collection(COL_OBS).find(q).toArray()) as unknown as MarketObservation[];
  }
  loadFileIfNeeded();
  return [...mem().obs.values()].filter((r) => !filter.fixtureId || r.canonicalFixtureId === filter.fixtureId);
}

export async function listConsensus(filter: { fixtureId?: string } = {}): Promise<MarketConsensusSnapshot[]> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return [];
    const q = filter.fixtureId ? { canonicalFixtureId: filter.fixtureId } : {};
    return (await db.collection(COL_CONSENSUS).find(q).toArray()) as unknown as MarketConsensusSnapshot[];
  }
  loadFileIfNeeded();
  return [...mem().consensus.values()].filter((r) => !filter.fixtureId || r.canonicalFixtureId === filter.fixtureId);
}

export async function countObservations(): Promise<number> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return 0;
    return db.collection(COL_OBS).countDocuments();
  }
  loadFileIfNeeded();
  return mem().obs.size;
}

export async function countConsensus(): Promise<number> {
  if (marketStoreBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return 0;
    return db.collection(COL_CONSENSUS).countDocuments();
  }
  loadFileIfNeeded();
  return mem().consensus.size;
}

export { emptyState as emptyMarketState };
