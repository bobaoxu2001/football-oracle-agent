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
// Observer functions may legitimately run for the full 120-second Vercel
// budget. Keep their lease longer than both the function and the scheduler's
// 130-second HTTP timeout so a delayed backup trigger cannot start a second
// market poll after the first one has already consumed provider quota.
export const OBSERVER_LOCK_TTL_MS = 180_000;
const TICK_LOCK_OPERATION_TIMEOUT_MS = 6_000;
const TICK_LOCK_RELEASE_TIMEOUT_MS = 3_000;

export interface TickLock {
  ok: boolean;
  leaseId: string | null;
  reason?: string;
}

interface OpsLockTarget {
  id: string;
  ttlMs: number;
  file: string;
}

function isFsError(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

/**
 * Publish a complete lease with an atomic hard-link create. Writing directly
 * after existsSync() lets two Node processes both believe they won; linking a
 * private candidate to the shared path gives the filesystem one winner.
 */
function createFileLease(
  file: string,
  leaseId: string,
  payload: string
): boolean {
  const candidate = `${file}.candidate.${leaseId}`;
  fs.writeFileSync(candidate, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    fs.linkSync(candidate, file);
    return true;
  } catch (err) {
    if (isFsError(err, "EEXIST")) return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(candidate);
    } catch {
      /* candidate cleanup is best-effort */
    }
  }
}

function tickLockTarget(): OpsLockTarget {
  return {
    id: "live-ops-tick",
    ttlMs: TICK_LOCK_TTL_MS,
    file: process.env.PL_TICK_LOCK_PATH || path.join(opsDir(), "tick.lock.json"),
  };
}

function observerLockTarget(): OpsLockTarget {
  return {
    id: "live-ops-observers",
    ttlMs: OBSERVER_LOCK_TTL_MS,
    file:
      process.env.PL_OBSERVER_LOCK_PATH ||
      path.join(opsDir(), "observers.lock.json"),
  };
}

async function acquireOpsLock(
  holder: string,
  target: OpsLockTarget
): Promise<TickLock> {
  const leaseId = randomUUID();
  const now = Date.now();
  const until = now + target.ttlMs;
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
      { _id: target.id as never },
      { timeoutMS: remaining() }
    );
    const expired = !existing || !existing.lockedUntil || new Date(existing.lockedUntil).getTime() <= now;
    if (!expired) return { ok: false, leaseId: null, reason: "tick already running" };
    try {
      await col.updateOne(
        { _id: target.id as never, lockedUntil: existing?.lockedUntil ?? null } as never,
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
      { _id: target.id as never },
      { timeoutMS: remaining() }
    );
    if (!confirm || confirm.leaseId !== leaseId) {
      return { ok: false, leaseId: null, reason: "tick already running" };
    }
    return { ok: true, leaseId };
  }

  const file = target.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ holder, leaseId, lockedUntil: until });
  if (createFileLease(file, leaseId, payload)) {
    return { ok: true, leaseId };
  }
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as {
      lockedUntil: number;
    };
    if (prev.lockedUntil > now) {
      return { ok: false, leaseId: null, reason: "tick already running" };
    }
    // There is no portable ownership-conditional unlink in Node's filesystem
    // API. Automatic stale takeover would let one contender delete a newer
    // winner between its read and rename. The non-production file backend
    // therefore fails closed; remove a confirmed stale file explicitly.
    return {
      ok: false,
      leaseId: null,
      reason: "stale file lock requires explicit cleanup",
    };
  } catch {
    return {
      ok: false,
      leaseId: null,
      reason: "unreadable file lock requires explicit cleanup",
    };
  }
}

async function releaseOpsLock(
  leaseId: string | null,
  target: OpsLockTarget
): Promise<void> {
  if (!leaseId) return;
  if (opsBackend() === "mongo") {
    const db = await getMongoDb();
    if (!db) return;
    try {
      await db.collection("pl_ops_locks").deleteOne(
        { _id: target.id as never, leaseId } as never,
        { timeoutMS: TICK_LOCK_RELEASE_TIMEOUT_MS }
      );
    } catch (err) {
      // The lease has a hard TTL, so release failure is recoverable and must
      // not turn an already committed tick into a reported write failure.
      console.warn("[ops-lock] release failed; lease will expire:", (err as Error).message);
    }
    return;
  }
  const file = target.file;
  if (!fs.existsSync(file)) return;
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { leaseId?: string };
    if (prev.leaseId === leaseId) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export async function acquireTickLock(holder = "tick"): Promise<TickLock> {
  return acquireOpsLock(holder, tickLockTarget());
}

export async function releaseTickLock(leaseId: string | null): Promise<void> {
  return releaseOpsLock(leaseId, tickLockTarget());
}

export async function acquireObserverLock(
  holder = "observers"
): Promise<TickLock> {
  return acquireOpsLock(holder, observerLockTarget());
}

export async function releaseObserverLock(
  leaseId: string | null
): Promise<void> {
  return releaseOpsLock(leaseId, observerLockTarget());
}
