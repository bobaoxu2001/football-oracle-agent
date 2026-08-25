/**
 * Match-ledger persistence.
 *
 * Deliberately mirrors the Phase 2B0 market recorder: an isolated store with
 * its own backend switch, file by default and Mongo where the runtime has no
 * durable filesystem. It does NOT write through the Premier League ops bundle,
 * so a ledger outage can never corrupt forecast state or the frozen tape.
 *
 * Observations are append-only. The canonical match table is a materialized
 * view, recomputed from observations — never the primary write target.
 */

import fs from "node:fs";
import path from "node:path";
import { getMongoDb } from "@/lib/db/mongodb";
import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import type { CanonicalMatch, MatchObservation } from "./types";
import { materializeAll } from "./materialize";
import type { TeamIdentityRecord, TeamIdentityRegistry } from "./identity";

const COL_OBSERVATIONS = "big_five_match_observations";
const COL_IDENTITY = "big_five_team_identity";

const DEFAULT_DIR = path.resolve(process.cwd(), "data/processed/big-five");

export function matchLedgerBackend(): "file" | "mongo" {
  if (process.env.MATCH_LEDGER_BACKEND === "file") return "file";
  if (process.env.MATCH_LEDGER_BACKEND === "mongo") return "mongo";
  if (process.env.VERCEL === "1" && process.env.MONGODB_URI) return "mongo";
  return "file";
}

export function matchLedgerDir(): string {
  return process.env.MATCH_LEDGER_DIR || DEFAULT_DIR;
}

function observationPath(): string {
  return path.join(matchLedgerDir(), "match-observations.jsonl");
}

function identityPath(): string {
  return path.join(matchLedgerDir(), "team-identity.json");
}

// ── File helpers (corrupt-tolerant, atomic where a whole file is replaced) ──

function readJsonlFile<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  let corrupt = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      corrupt += 1;
    }
  }
  if (corrupt) console.warn(`[ledger] skipped ${corrupt} unreadable line(s) in ${file}`);
  return out;
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

// ── Observations ───────────────────────────────────────────────────────────

/**
 * Append observations, skipping ids already stored.
 *
 * First-write-wins on observationId is what makes ingestion idempotent:
 * re-observing Arsenal 3-0 Coventry a hundred times stores it once.
 */
export async function appendObservations(
  rows: MatchObservation[]
): Promise<{ written: number; skipped: number }> {
  if (!rows.length) return { written: 0, skipped: 0 };

  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("match ledger: mongo backend selected but unavailable");
    const col = db.collection(COL_OBSERVATIONS);
    // One provider response contains hundreds of fixtures. Issuing one Atlas
    // round trip per row made a healthy idempotent replay exceed Vercel's
    // 60-second function budget. De-duplicate the request first, then use
    // set-on-insert upserts: the original observation remains immutable and a
    // replay is still a no-op, but the whole pass is one bounded operation.
    const unique = new Map<string, MatchObservation>();
    for (const row of rows) {
      if (!unique.has(row.observationId)) unique.set(row.observationId, row);
    }
    const result = await col.bulkWrite(
      [...unique.values()].map((row) => ({
        updateOne: {
          filter: { _id: row.observationId },
          update: { $setOnInsert: { ...row, _id: row.observationId } },
          upsert: true,
        },
      })) as never,
      { ordered: false, timeoutMS: 12_000 }
    );
    return {
      written: result.upsertedCount,
      skipped: rows.length - result.upsertedCount,
    };
  }

  const file = observationPath();
  const existing = new Set(readJsonlFile<MatchObservation>(file).map((r) => r.observationId));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (existing.has(row.observationId)) {
      skipped += 1;
      continue;
    }
    existing.add(row.observationId);
    fresh.push(JSON.stringify(row));
  }
  if (fresh.length) fs.appendFileSync(file, `${fresh.join("\n")}\n`, "utf8");
  return { written: fresh.length, skipped };
}

export async function listObservations(filter?: {
  competition?: BigFiveCompetitionId;
  season?: string;
  canonicalMatchId?: string;
}): Promise<MatchObservation[]> {
  let rows: MatchObservation[];
  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return [];
    const query: Record<string, string> = {};
    if (filter?.competition) query.competition = filter.competition;
    if (filter?.season) query.season = filter.season;
    if (filter?.canonicalMatchId) query.canonicalMatchId = filter.canonicalMatchId;
    rows = (await db
      .collection(COL_OBSERVATIONS)
      // Filtering in Mongo is important even without a warm index: routes
      // requesting one competition must not download and materialize the
      // complete five-league observation history in the function runtime.
      .find(query, { projection: { _id: 0 }, timeoutMS: 10_000 })
      .toArray()) as unknown as MatchObservation[];
  } else {
    rows = readJsonlFile<MatchObservation>(observationPath());
  }
  if (!filter) return rows;
  return rows.filter(
    (r) =>
      (!filter.competition || r.competition === filter.competition) &&
      (!filter.season || r.season === filter.season) &&
      (!filter.canonicalMatchId || r.canonicalMatchId === filter.canonicalMatchId)
  );
}

// ── Canonical view ─────────────────────────────────────────────────────────

/**
 * The canonical match table, materialized from observations on read.
 *
 * Recomputed rather than stored so the observation log stays the single source
 * of truth and a materialization bug can never become permanent corruption.
 */
export async function listCanonicalMatches(filter?: {
  competition?: BigFiveCompetitionId;
  season?: string;
}): Promise<CanonicalMatch[]> {
  const rows = await listObservations(filter);
  return materializeAll(rows);
}

export async function getCanonicalMatch(
  canonicalMatchId: string
): Promise<CanonicalMatch | null> {
  const rows = await listObservations({ canonicalMatchId });
  const all = materializeAll(rows);
  return all[0] ?? null;
}

// ── Team identity registry ─────────────────────────────────────────────────

export async function loadTeamIdentityRegistry(): Promise<TeamIdentityRegistry> {
  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return {};
    const rows = (await db
      .collection(COL_IDENTITY)
      .find({}, { projection: { _id: 0 }, timeoutMS: 8_000 })
      .toArray()) as unknown as TeamIdentityRecord[];
    const out: TeamIdentityRegistry = {};
    for (const r of rows) out[`${r.competition}::${r.providerTeamId}`] = r;
    return out;
  }
  const file = identityPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TeamIdentityRegistry;
  } catch {
    console.warn(`[ledger] unreadable team identity at ${file} — starting empty`);
    return {};
  }
}

export async function saveTeamIdentityRegistry(registry: TeamIdentityRegistry): Promise<void> {
  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) throw new Error("match ledger: mongo backend selected but unavailable");
    const col = db.collection(COL_IDENTITY);
    const records = Object.values(registry);
    if (!records.length) return;
    await col.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: { _id: `${record.competition}::${record.providerTeamId}` },
          update: { $set: record },
          upsert: true,
        },
      })) as never,
      { ordered: false, timeoutMS: 8_000 }
    );
    return;
  }
  writeFileAtomic(identityPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

/** Test helper. Refuses to touch anything outside an overridden ledger dir. */
export function clearMatchLedgerForTests(): void {
  if (!process.env.MATCH_LEDGER_DIR) {
    throw new Error("clearMatchLedgerForTests requires MATCH_LEDGER_DIR to be set");
  }
  fs.rmSync(matchLedgerDir(), { recursive: true, force: true });
}
