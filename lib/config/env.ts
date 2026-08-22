/**
 * Validated numeric environment reads.
 *
 * `Number(process.env.X || fallback)` silently yields NaN for a typo, and NaN
 * poisons whatever it feeds:
 *   • a cache TTL of NaN makes every freshness check false, so nothing is ever
 *     cached and a rate-limited upstream is called on every request;
 *   • a cadence of NaN passed to setInterval is coerced to ~0, turning a
 *     5-minute pinger into a tight loop against production.
 *
 * These helpers fall back to the documented default and say so, rather than
 * propagating a bad value into behaviour nobody would connect to a typo.
 */

function invalid(name: string, raw: string, fallback: number): number {
  console.warn(`[env] ${name}="${raw}" is not a valid positive number — using ${fallback}`);
  return fallback;
}

/**
 * A positive, finite number from the environment, or `fallback`.
 * Empty/unset returns `fallback` silently; a malformed value warns.
 */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return invalid(name, raw, fallback);
  return n;
}

/** As {@link numberFromEnv}, but the value must also be a whole number. */
export function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return invalid(name, raw, fallback);
  return n;
}

/**
 * A duration in milliseconds, clamped to a sane band so a stray extra zero
 * cannot turn a poll interval into a hot loop or an effectively dead timer.
 */
export function durationMsFromEnv(
  name: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const n = numberFromEnv(name, fallback);
  if (n < bounds.min || n > bounds.max) {
    console.warn(
      `[env] ${name}=${n}ms is outside ${bounds.min}–${bounds.max}ms — clamping`
    );
    return Math.min(bounds.max, Math.max(bounds.min, n));
  }
  return n;
}
