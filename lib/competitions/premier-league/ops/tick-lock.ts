/**
 * Tick lease. Overlapping invocations must not mutate ops state twice.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMongoDb } from "@/lib/db/mongodb";
import { opsDir } from "./paths";
import { opsBackend } from "./durable-store";

export const TICK_LOCK_TTL_MS = 90_000;
const TICK_LOCK_OPERATION_TIMEOUT_MS = 6_000;
const TICK_LOCK_RELEASE_TIMEOUT_MS = 3_000;

export interface TickLock {
  ok: boolean;
  leaseId: string | null;
  reason?: string;
}

function fileLockPath(): string {
  return process.env.PL_TICK_LOCK_PATH || path.join(opsDir(), "tick.lock.json");
}

export async function acquireTickLock(holder = "tick"): Promise<TickLock> {
  const leaseId = randomUUID();
  const now = Date.now();
  const until = now + TICK_LOCK_TTL_MS;
  if (opsBackend() === "mongo") {
    const deadline = now + TICK_LOCK_OPERATION_TIMEOUT_MS;
    const remaining = () => {
      const timeoutMS = deadline - Date.now();
      if (timeoutMS <= 0) throw new Error("tick lock deadline exceeded");
      return timeoutMS;
    };
    const db = await getMongoDb();
    if (!db) return { ok: false, leaseId: null, reason: "mongo unavailable for lock" };
    const col = db.collection("pl_ops_locks");
    const existing = await col.findOne(
      { _id: "live-ops-tick" as never },
      { timeoutMS: remaining() }
    );
    const expired = !existing || !existing.lockedUntil || new Date(existing.lockedUntil).getTime() <= now;
    if (!expired) return { ok: false, leaseId: null, reason: "tick already running" };
    try {
      await col.updateOne(
        { _id: "live-ops-tick" as never, lockedUntil: existing?.lockedUntil ?? null } as never,
        { $set: { holder, leaseId, lockedUntil: new Date(until), acquiredAt: new Date(now) } },
        { upsert: true, timeoutMS: remaining() }
      );
    } catch (err) {
      // Concurrent upserts race on the fixed _id; duplicate key is the normal
      // loser signal. Timeouts/topology failures are infrastructure errors and
      // must not be mislabeled as harmless 409 contention.
      if ((err as { code?: number }).code === 11000) {
        return { ok: false, leaseId: null, reason: "tick already running" };
      }
      throw err;
    }
    const confirm = await col.findOne(
      { _id: "live-ops-tick" as never },
      { timeoutMS: remaining() }
    );
    if (!confirm || confirm.leaseId !== leaseId) {
      return { ok: false, leaseId: null, reason: "tick already running" };
    }
    return { ok: true, leaseId };
  }

  const file = fileLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { lockedUntil: number };
      if (prev.lockedUntil > now) return { ok: false, leaseId: null, reason: "tick already running" };
    } catch {
      /* replace corrupt lock */
    }
  }
  fs.writeFileSync(file, JSON.stringify({ holder, leaseId, lockedUntil: until }), "utf8");
  return { ok: true, leaseId };
}

export async function releaseTickLock(leaseId: string | null): Promise<void> {
  if (!leaseId) return;
  if (opsBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return;
    try {
      await db.collection("pl_ops_locks").deleteOne(
        { _id: "live-ops-tick" as never, leaseId } as never,
        { timeoutMS: TICK_LOCK_RELEASE_TIMEOUT_MS }
      );
    } catch (err) {
      // The lease has a hard TTL, so release failure is recoverable and must
      // not turn an already committed tick into a reported write failure.
      console.warn("[ops-lock] release failed; lease will expire:", (err as Error).message);
    }
    return;
  }
  const file = fileLockPath();
  if (!fs.existsSync(file)) return;
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { leaseId?: string };
    if (prev.leaseId === leaseId) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
