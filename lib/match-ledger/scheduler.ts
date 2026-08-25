/**
 * Ledger ingest cadence.
 *
 * The ops tick runs every 5 minutes, but the Big Five ledger does not need to
 * re-read five whole season schedules that often: a completed match stays
 * completed. A minimum interval keeps provider usage proportionate (the
 * football-data.org free tier is rate limited) without adding a second
 * scheduler — the existing tick and its Mongo lease remain the only driver.
 */

import fs from "node:fs";
import path from "node:path";
import { getMongoDb } from "@/lib/db/mongodb";
import { durationMsFromEnv } from "@/lib/config/env";
import { matchLedgerBackend, matchLedgerDir } from "./store";

const COL_STATE = "big_five_ledger_state";

export interface LedgerState {
  lastIngestAt: string | null;
  lastIngestOkAt: string | null;
  lastError: string | null;
  ingestRuns: number;
  lastCompletedTotal: number | null;
}

export function emptyLedgerState(): LedgerState {
  return {
    lastIngestAt: null,
    lastIngestOkAt: null,
    lastError: null,
    ingestRuns: 0,
    lastCompletedTotal: null,
  };
}

/** Minimum gap between ledger ingests. Clamped so a typo cannot hammer the API. */
export function ledgerIngestIntervalMs(): number {
  return durationMsFromEnv("MATCH_LEDGER_INTERVAL_MS", 30 * 60 * 1000, {
    min: 60_000,
    max: 24 * 60 * 60 * 1000,
  });
}

function statePath(): string {
  return path.join(matchLedgerDir(), "ledger-state.json");
}

export async function loadLedgerState(): Promise<LedgerState> {
  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return emptyLedgerState();
    const doc = await db.collection(COL_STATE).findOne(
      { _id: "current" as never },
      { timeoutMS: 4_000 }
    );
    if (!doc) return emptyLedgerState();
    const { _id, ...rest } = doc as Record<string, unknown>;
    void _id;
    return { ...emptyLedgerState(), ...(rest as Partial<LedgerState>) };
  }
  const file = statePath();
  if (!fs.existsSync(file)) return emptyLedgerState();
  try {
    return { ...emptyLedgerState(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as LedgerState) };
  } catch {
    console.warn(`[ledger] unreadable state at ${file} — treating as absent`);
    return emptyLedgerState();
  }
}

export async function saveLedgerState(state: LedgerState): Promise<void> {
  if (matchLedgerBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return;
    await db
      .collection(COL_STATE)
      .updateOne(
        { _id: "current" as never },
        { $set: state },
        { upsert: true, timeoutMS: 4_000 }
      );
    return;
  }
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Is a ledger ingest due at `now`? Pure, so the cadence rule is testable. */
export function ingestIsDue(
  state: LedgerState,
  nowIso: string,
  intervalMs = ledgerIngestIntervalMs()
): boolean {
  if (!state.lastIngestAt) return true;
  const last = Date.parse(state.lastIngestAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return true;
  return now - last >= intervalMs;
}
