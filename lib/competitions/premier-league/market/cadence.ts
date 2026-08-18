/**
 * Adaptive pre-match polling.
 *
 * Specified policy:
 *   > 7d            every 6 hours
 *   7d → 48h        every 1 hour
 *   48h → 6h        every 15 minutes
 *   6h → kickoff    every 5 minutes
 *   after kickoff   stop pre-match recorder for that fixture
 *
 * Quota floors (documented deviation so a 500-credit month is not burned
 * when the first match is already inside 7 days):
 *   remaining < 200 → min interval 6 hours
 *   remaining < 80  → min interval 12 hours
 *   remaining < 20  → min interval 24 hours, health DEGRADED
 * Never silent-stop.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export const CADENCE_FAR_MS = 6 * HOUR;
export const CADENCE_WEEK_MS = 1 * HOUR;
export const CADENCE_TWO_DAY_MS = 15 * MIN;
export const CADENCE_NEAR_MS = 5 * MIN;
export const CADENCE_QUOTA_LOW_MS = 12 * HOUR;
export const CADENCE_QUOTA_CRITICAL_MS = 24 * HOUR;
export const QUOTA_SAFE = 200;
export const QUOTA_LOW = 80;
export const QUOTA_CRITICAL = 20;

export function baseCadenceMs(msToKickoff: number | null): number {
  if (msToKickoff == null || msToKickoff <= 0) return Number.POSITIVE_INFINITY;
  if (msToKickoff > 7 * 24 * HOUR) return CADENCE_FAR_MS;
  if (msToKickoff > 48 * HOUR) return CADENCE_WEEK_MS;
  if (msToKickoff > 6 * HOUR) return CADENCE_TWO_DAY_MS;
  return CADENCE_NEAR_MS;
}

export function quotaFloorMs(remaining: number | null): number {
  if (remaining == null) return 0;
  if (remaining < QUOTA_CRITICAL) return CADENCE_QUOTA_CRITICAL_MS;
  if (remaining < QUOTA_LOW) return CADENCE_QUOTA_LOW_MS;
  if (remaining < QUOTA_SAFE) return CADENCE_FAR_MS;
  return 0;
}

export function effectiveCadenceMs(msToKickoff: number | null, quotaRemaining: number | null): number {
  const base = baseCadenceMs(msToKickoff);
  const floor = quotaFloorMs(quotaRemaining);
  if (!Number.isFinite(base)) return base;
  return Math.max(base, floor);
}

export function nearestFutureKickoffMs(kickoffs: Array<string | null | undefined>, nowMs: number): number | null {
  let best: number | null = null;
  for (const k of kickoffs) {
    if (!k) continue;
    const t = Date.parse(k);
    if (!Number.isFinite(t) || t <= nowMs) continue;
    const d = t - nowMs;
    if (best == null || d < best) best = d;
  }
  return best;
}

export function nextPollAt(nowIso: string, lastSuccessAt: string | null, cadenceMs: number): string {
  if (!Number.isFinite(cadenceMs)) return nowIso;
  if (!lastSuccessAt) return nowIso;
  const next = Date.parse(lastSuccessAt) + cadenceMs;
  return new Date(Math.max(next, Date.parse(nowIso))).toISOString();
}

export function pollIsDue(nowIso: string, lastSuccessAt: string | null, cadenceMs: number): boolean {
  if (!Number.isFinite(cadenceMs)) return false;
  if (!lastSuccessAt) return true;
  return Date.parse(nowIso) >= Date.parse(lastSuccessAt) + cadenceMs;
}
