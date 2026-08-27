/**
 * Public operational-error boundary.
 *
 * Internal stores intentionally retain the original diagnostic for operators.
 * Anything crossing a public route or page must instead use one of these
 * bounded categories and messages. Classification may inspect a diagnostic,
 * but the diagnostic itself is never copied into the public result.
 */

export const PUBLIC_OPERATIONAL_ERROR_CATEGORIES = [
  "AUTHENTICATION_FAILED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_RESPONSE_INVALID",
  "DURABLE_STORE_UNAVAILABLE",
  "EVIDENCE_VALIDATION_FAILED",
  "DATA_VALIDATION_FAILED",
  "DATA_CONFLICT",
  "CONFIGURATION_INCOMPLETE",
  "INTERNAL_OPERATION_FAILED",
] as const;

export type PublicOperationalErrorCategory =
  (typeof PUBLIC_OPERATIONAL_ERROR_CATEGORIES)[number];

export interface PublicOperationalError {
  category: PublicOperationalErrorCategory;
  message: string;
}

const SENSITIVE_PUBLIC_VALUE_PATTERNS = [
  /\bmongodb(?:\+srv)?:\/\//i,
  /\b(?:postgres(?:ql)?|redis|rediss|mysql|mariadb|amqp|amqps):\/\/\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i,
  /\b(?:authorization|bearer|password|passwd|api[_-]?key|access[_-]?token|secret)\b\s*[:=]/i,
  /\bbearer\s+[a-z0-9._~+/-]+=*/i,
  /\b(?:sk-(?:live|test|proj)-|xox[baprs]-|gh[pousr]_)[a-z0-9_-]{8,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:^|[\s("'`])\/(?:Users|home|var|tmp|private|etc|opt|app|root|workspace|usr|srv)\//,
  /\b[a-z]:\\(?:Users|Windows|Program Files|workspace)\\/i,
  /(?:^|\n)\s*at\s+[^\n]+:\d+:\d+/,
  /\bObjectId\(["'][a-f0-9]{24}["']\)/i,
  /\b[a-f0-9]{24}\b/i,
  /^\s*[\[{][\s\S]*[\]}]\s*$/,
  /<html(?:\s|>)/i,
] as const;

const SENSITIVE_PUBLIC_KEY = /^(?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|connection[_-]?string|database[_-]?url|mongodb[_-]?uri)$/i;

const PUBLIC_MESSAGES: Record<PublicOperationalErrorCategory, string> = {
  AUTHENTICATION_FAILED: "An operational dependency rejected authentication.",
  UPSTREAM_RATE_LIMITED: "An upstream service temporarily limited requests.",
  UPSTREAM_UNAVAILABLE: "An upstream service is temporarily unavailable.",
  UPSTREAM_RESPONSE_INVALID: "An upstream service returned an unusable response.",
  DURABLE_STORE_UNAVAILABLE: "The durable operational store is temporarily unavailable.",
  EVIDENCE_VALIDATION_FAILED: "Forecast evidence did not pass validation.",
  DATA_VALIDATION_FAILED: "Production data did not pass structural validation.",
  DATA_CONFLICT: "Conflicting source observations require review.",
  CONFIGURATION_INCOMPLETE: "A required operational dependency is not configured.",
  INTERNAL_OPERATION_FAILED: "The operational check failed.",
};

function diagnosticText(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name} ${value.message}`.toLowerCase();
  }
  try {
    return String(value ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/** Classify without ever returning bytes from the internal diagnostic. */
export function classifyPublicOperationalError(
  value: unknown
): PublicOperationalError {
  const diagnostic = diagnosticText(value);
  let category: PublicOperationalErrorCategory = "INTERNAL_OPERATION_FAILED";

  if (/not configured|configuration|missing required|environment variable|\benv\b/.test(diagnostic)) {
    category = "CONFIGURATION_INCOMPLETE";
  } else if (
    /credential|password|passwd|bearer|authorization|api[-_ ]?key|secret|unauthori[sz]ed|forbidden|\b401\b|\b403\b/.test(
      diagnostic
    )
  ) {
    category = "AUTHENTICATION_FAILED";
  } else if (/rate.?limit|too many requests|quota|\b429\b/.test(diagnostic)) {
    category = "UPSTREAM_RATE_LIMITED";
  } else if (
    /mongodb|mongo\+srv|\bbson\b|database|collection|e11000|durable|storage|store failure|persist|hydrate|flush/.test(
      diagnostic
    )
  ) {
    category = "DURABLE_STORE_UNAVAILABLE";
  } else if (
    /provenance|manifest|content.?address|integrity|rating state|rating lineage|fixture revision|result revision|membership snapshot|model bundle|pit[-_ ]|cutoff|immutable reference|evidence/.test(
      diagnostic
    )
  ) {
    category = "EVIDENCE_VALIDATION_FAILED";
  } else if (/data gate|structural validation|season data|invalid fixture/.test(diagnostic)) {
    category = "DATA_VALIDATION_FAILED";
  } else if (/conflict|duplicate result|disagreeing source/.test(diagnostic)) {
    category = "DATA_CONFLICT";
  } else if (
    /timeout|timed out|etimedout|econn|enotfound|dns|network|socket|fetch failed|service unavailable|\b502\b|\b503\b|\b504\b/.test(
      diagnostic
    )
  ) {
    category = "UPSTREAM_UNAVAILABLE";
  } else if (
    /invalid (json|response|payload)|parse|unexpected token|schema|malformed|unreadable response/.test(
      diagnostic
    )
  ) {
    category = "UPSTREAM_RESPONSE_INVALID";
  }

  return { category, message: PUBLIC_MESSAGES[category] };
}

export function containsSensitivePublicValue(value: string): boolean {
  return SENSITIVE_PUBLIC_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Last-resort recursive guard for future public fields. Known diagnostics are
 * projected explicitly, and this prevents a newly added string field from
 * accidentally carrying a credentialed URI, path, stack or raw payload.
 */
export function redactSensitivePublicValues<T>(value: T): T {
  if (typeof value === "string") {
    return (containsSensitivePublicValue(value)
      ? publicOperationalErrorText(value)
      : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitivePublicValues(entry)) as T;
  }
  if (value && typeof value === "object") {
    const sanitized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_PUBLIC_KEY.test(key) && entry !== null && entry !== undefined
          ? publicOperationalErrorText(`${key} is sensitive`)
          : redactSensitivePublicValues(entry),
      ])
    );
    return sanitized as T;
  }
  return value;
}

const DIAGNOSTIC_VALUE_KEYS = new Set([
  "error",
  "lastError",
  "lastShadowError",
  "lastShadowLifecycleError",
  "failureReason",
  "detail",
]);
const DIAGNOSTIC_LIST_KEYS = new Set(["errors", "shadowErrors"]);

/** Route-level projection for scheduler/provider result objects. */
export function sanitizePublicOperationalPayload<T>(value: T): T {
  function visit(entry: unknown, key: string | null): unknown {
    if (typeof entry === "string" && key && DIAGNOSTIC_VALUE_KEYS.has(key)) {
      return publicOperationalErrorText(entry);
    }
    if (Array.isArray(entry)) {
      if (key && DIAGNOSTIC_LIST_KEYS.has(key)) {
        return entry.map((item) => publicOperationalErrorText(item));
      }
      return entry.map((item) => visit(item, null));
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry).map(([childKey, child]) => [
          childKey,
          visit(child, childKey),
        ])
      );
    }
    return redactSensitivePublicValues(entry);
  }
  return visit(value, null) as T;
}

/**
 * Public projection for the shadow read model. The internal report keeps the
 * original lifecycle diagnostic for operators; public consumers receive only
 * a stable category and message.
 */
export function sanitizePublicShadowReport<T>(value: T): T {
  return sanitizePublicOperationalPayload(value);
}

export function publicOperationalErrorText(value: unknown): string {
  if (typeof value === "string" && isPublicOperationalErrorText(value)) {
    return value;
  }
  const error = classifyPublicOperationalError(value);
  return `${error.category}: ${error.message}`;
}

export function isPublicOperationalErrorText(value: string): boolean {
  return PUBLIC_OPERATIONAL_ERROR_CATEGORIES.some(
    (category) => value === `${category}: ${PUBLIC_MESSAGES[category]}`
  );
}

export function publicFailureBody(error: string, cause: unknown): {
  error: string;
  category: PublicOperationalErrorCategory;
  message: string;
} {
  const classified = classifyPublicOperationalError(cause);
  return { error, ...classified };
}

/** Raw details stay in private runtime logs, never in the returned value. */
export function recordInternalOperationalError(scope: string, error: unknown): void {
  console.error(`[${scope}]`, error);
}
