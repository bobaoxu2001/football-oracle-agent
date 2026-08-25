import { createHash } from "node:crypto";

interface Bucket {
  startedAt: number;
  count: number;
}

const buckets = new Map<string, Bucket>();
const inFlight = new Map<string, Promise<unknown>>();
const completed = new Map<string, { expiresAt: number; value: unknown }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;
const MAX_BUCKETS = 2_000;
const DURABLE_GUARD_DEADLINE_MS = 1_500;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Hash network identifiers immediately; raw addresses are never retained. */
export function anonymousRateLimitKey(raw: string | null): string {
  return createHash("sha256").update(raw?.trim() || "anonymous").digest("hex").slice(0, 24);
}

export function takeMatchAgentRateLimit(
  key: string,
  now = Date.now(),
  limit = MAX_REQUESTS,
  windowMs = WINDOW_MS
): RateLimitResult {
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
    }
  }
  const current = buckets.get(key);
  const bucket =
    !current || now - current.startedAt >= windowMs
      ? { startedAt: now, count: 0 }
      : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  const allowed = bucket.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000)),
  };
}

/** Scope a rate-limit bucket without ever retaining the caller's raw address. */
export function takePublicAiRateLimit(
  scope: string,
  anonymousKey: string,
  now = Date.now(),
  limit = MAX_REQUESTS,
  windowMs = WINDOW_MS
): RateLimitResult {
  return takeMatchAgentRateLimit(`${scope}:${anonymousKey}`, now, limit, windowMs);
}

interface DurableRateLimitRow {
  _id: string;
  count: number;
  expiresAt: Date;
}

/**
 * Enforce a fast per-instance guard first, then an atomic Mongo-backed ceiling
 * shared by every Vercel function instance. Mongo outages fail soft to the
 * local guard so the deterministic product does not become database-coupled.
 */
export async function takeDurablePublicAiRateLimit(
  scope: string,
  anonymousKey: string,
  now = Date.now(),
  limit = MAX_REQUESTS,
  windowMs = WINDOW_MS
): Promise<RateLimitResult> {
  const local = takePublicAiRateLimit(scope, anonymousKey, now, limit, windowMs);
  if (!local.allowed) return local;

  try {
    const { getMongoDb } = await import("@/lib/db/mongodb");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const db = await Promise.race([
      getMongoDb(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DURABLE_GUARD_DEADLINE_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (!db) return local;

    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rowId = `${scope}:${anonymousKey}:${windowStart}`;
    const collection = db.collection<DurableRateLimitRow>("ai_rate_limits");
    void collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
    const row = await collection.findOneAndUpdate(
      { _id: rowId },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(windowStart + windowMs) },
      },
      // Rate limiting must never become the slowest part of a deterministic
      // public request. The local guard remains active if Atlas is degraded.
      { upsert: true, returnDocument: "after", timeoutMS: 2_000 }
    );
    const count = row?.count ?? 1;
    const allowed = count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  } catch {
    return local;
  }
}

/** Stable opaque request identity for cost-deduplication. Raw prompts are not retained. */
export function aiRequestFingerprint(scope: string, value: unknown): string {
  return createHash("sha256")
    .update(scope)
    .update("\n")
    .update(JSON.stringify(value))
    .digest("hex");
}

/** Coalesce concurrent identical requests and briefly reuse their completed result. */
export async function runAiRequestDeduplicated<T>(
  fingerprint: string,
  task: () => Promise<T>,
  ttlMs = 60_000,
  now = Date.now()
): Promise<T> {
  const cached = completed.get(fingerprint);
  if (cached && cached.expiresAt > now) return structuredClone(cached.value) as T;
  const pending = inFlight.get(fingerprint);
  if (pending) return structuredClone(await pending) as T;

  const promise = task();
  inFlight.set(fingerprint, promise);
  try {
    const value = await promise;
    completed.set(fingerprint, { expiresAt: Date.now() + ttlMs, value: structuredClone(value) });
    if (completed.size > 500) {
      for (const [key, item] of completed) {
        if (item.expiresAt <= Date.now()) completed.delete(key);
      }
      if (completed.size > 500) completed.delete(completed.keys().next().value as string);
    }
    return value;
  } finally {
    inFlight.delete(fingerprint);
  }
}

export class AiRouteTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`AI route exceeded ${timeoutMs}ms.`);
  }
}

export async function withAiRouteTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AiRouteTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function requestBodyTooLarge(request: Request, maxBytes = 4_096): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const bytes = Number(raw);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

export class RequestBodyTooLargeError extends Error {}

/** Enforce the real UTF-8 body size even when Content-Length is absent or untrusted. */
export async function readBoundedJson<T>(request: Request, maxBytes = 4_096): Promise<T> {
  if (requestBodyTooLarge(request, maxBytes)) throw new RequestBodyTooLargeError();
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new RequestBodyTooLargeError();
  return JSON.parse(text || "{}") as T;
}

export function resetMatchAgentRateLimitsForTests(): void {
  buckets.clear();
  inFlight.clear();
  completed.clear();
}
