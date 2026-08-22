/**
 * Ops-tick authentication.
 *
 * Production (Vercel or NODE_ENV=production) requires CRON_SECRET.
 * Local tests without a secret stay runnable.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * `a !== b` returns as soon as two bytes differ, which leaks the length of the
 * matching prefix to an attacker who can time the endpoint. Lengths are
 * compared first (that is not secret) and the bytes with timingSafeEqual.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isProductionRuntime(): boolean {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

export function extractPresentedSecret(req: { headers: Headers; url: string }): string {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  let query = "";
  try {
    query = new URL(req.url).searchParams.get("secret") ?? "";
  } catch {
    query = "";
  }
  return bearer || query;
}

export function authorizeOpsTick(req: { headers: Headers; url: string }): {
  ok: boolean;
  status: number;
  reason: string;
} {
  const secret = process.env.CRON_SECRET ?? "";
  if (isProductionRuntime() && !secret) {
    return { ok: false, status: 401, reason: "CRON_SECRET is required in production" };
  }
  if (!secret) return { ok: true, status: 200, reason: "local-open" };
  const presented = extractPresentedSecret(req);
  if (!presented) return { ok: false, status: 401, reason: "missing secret" };
  if (!secretsMatch(presented, secret)) return { ok: false, status: 401, reason: "invalid secret" };
  return { ok: true, status: 200, reason: "ok" };
}
