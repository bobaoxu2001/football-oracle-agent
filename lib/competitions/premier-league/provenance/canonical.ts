import { createHash } from "node:crypto";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export type Sha256Hash = `sha256:${string}`;

const RFC3339_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/**
 * Detach and normalize a JSON-compatible value for content addressing.
 *
 * Object keys are sorted recursively, array order remains semantic, `-0`
 * becomes `0`, and values that JSON would silently discard are rejected.
 */
export function normalizeCanonicalJson(
  value: unknown,
  label = "value",
  ancestors = new Set<object>()
): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain JSON values only`);
  }
  if (ancestors.has(value)) throw new Error(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeCanonicalJson(item, `${label}[${index}]`, ancestors)
      );
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${label} must contain plain JSON objects only`);
    }
    const out: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeCanonicalJson(
        (value as Record<string, unknown>)[key],
        `${label}.${key}`,
        ancestors
      );
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON encoding. Object key order never depends on insertion order. */
export function canonicalJson(value: unknown): string {
  const normalized = normalizeCanonicalJson(value);
  return encodeCanonicalJson(normalized);
}

function encodeCanonicalJson(value: CanonicalJsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeCanonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(value[key])}`)
    .join(",")}}`;
}

/** SHA-256 of the canonical JSON bytes. */
export function canonicalSha256(value: unknown): Sha256Hash {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** A human-scoped content address while retaining the complete SHA-256. */
export function contentAddress(prefix: string, value: unknown): string {
  const normalizedPrefix = requireNonEmpty(prefix, "content-address prefix");
  return `${normalizedPrefix}:${canonicalSha256(value)}`;
}

export function normalizeSha256(value: unknown, label = "hash"): Sha256Hash {
  if (typeof value !== "string") throw new Error(`${label} must be a SHA-256 hash`);
  const normalized = value.trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${label} must be sha256:<64 hex>`);
  return normalized as Sha256Hash;
}

/** Require an RFC3339 timestamp with an explicit timezone and normalize to UTC. */
export function normalizeTimestamp(value: unknown, label = "timestamp"): string {
  if (typeof value !== "string" || !RFC3339_WITH_ZONE.test(value.trim())) {
    throw new Error(`${label} must be an RFC3339 timestamp with an explicit timezone`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} is not a valid timestamp`);
  return new Date(millis).toISOString();
}

export function assertCanonicalTimestamp(value: unknown, label = "timestamp"): string {
  const normalized = normalizeTimestamp(value, label);
  if (value !== normalized) throw new Error(`${label} must be normalized UTC ISO`);
  return normalized;
}

export function timestampMillis(value: unknown, label = "timestamp"): number {
  return Date.parse(normalizeTimestamp(value, label));
}

export function latestTimestamp(values: readonly string[], label = "timestamps"): string {
  if (!values.length) throw new Error(`${label} must not be empty`);
  return new Date(
    Math.max(...values.map((value, index) => timestampMillis(value, `${label}[${index}]`)))
  ).toISOString();
}

export function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function cloneFrozen<T>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
