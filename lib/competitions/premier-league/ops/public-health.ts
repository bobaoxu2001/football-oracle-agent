import {
  buildMarketHealthReport,
  type MarketHealthReport,
  unavailableMarketHealthReport,
} from "../market/health";
import { hydrateDurableOps } from "./durable-store";
import { buildHealthReport, type HealthReport } from "./health";
import {
  publicOperationalErrorText,
  redactSensitivePublicValues,
  recordInternalOperationalError,
} from "./public-errors";

const SAFE_HEALTH_REASONS = [
  /^\d+ unresolved source conflict\(s\)$/,
  /^\d+ failed prediction job\(s\)$/,
  /^fixture sync stale$/,
  /^ops tick stale \(expected ~5 minute cadence\)$/,
  /^\d+ fixture\(s\) inside 48h still not CONFIRMED$/,
  /^\d+ fixture\(s\) past kickoff without VERIFIED_FINAL$/,
  /^no live structured source configured$/,
  /^production ops store is ephemeral \(file backend\)$/,
  /^durable ops refresh failed; serving the last verified in-process state$/,
  /^durable ops state is not hydrated$/,
  /^production operations are healthy: data gate, source, durable store and scheduler are not blocked; fixture forecast coverage is reported separately$/,
] as const;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sanitizeHealthReason(reason: string): string {
  const normalized = reason.trim();
  if (SAFE_HEALTH_REASONS.some((pattern) => pattern.test(normalized))) {
    return normalized;
  }
  if (normalized.startsWith("DATA_BLOCKED:")) {
    return "DATA_VALIDATION_FAILED: Production data did not pass structural validation.";
  }
  if (normalized.startsWith("next production forecast is not PIT-evidence ready:")) {
    return "EVIDENCE_VALIDATION_FAILED: Forecast evidence did not pass validation.";
  }
  if (normalized === "Mongo ops store selected but MONGODB_URI is missing") {
    return "CONFIGURATION_INCOMPLETE: A required operational dependency is not configured.";
  }
  return publicOperationalErrorText(normalized);
}

/**
 * Remove diagnostic internals while retaining every health state, count and
 * freshness decision. This is deliberately separate from buildHealthReport so
 * operators and private logs keep the original failure details.
 */
export function sanitizePublicHealthReport(health: HealthReport): HealthReport {
  const nextForecast = health.provenanceCapture.nextForecast
    ? {
        ...health.provenanceCapture.nextForecast,
        reasons: unique(
          health.provenanceCapture.nextForecast.reasons.map((reason) =>
            publicOperationalErrorText(reason)
          )
        ),
      }
    : null;

  return redactSensitivePublicValues({
    ...health,
    reasons: unique(health.reasons.map(sanitizeHealthReason)),
    season: {
      ...health.season,
      dataReadyReasons: health.season.dataReadyReasons.length
        ? ["DATA_VALIDATION_FAILED: Production data did not pass structural validation."]
        : [],
    },
    scheduler: {
      ...health.scheduler,
      // Deployment hostnames are useful internally, not part of public health.
      host: null,
    },
    provenanceCapture: {
      ...health.provenanceCapture,
      nextForecast,
    },
    conflicts: health.conflicts.map((conflict) => ({
      ...conflict,
      sources: ["source-observations"],
      detail: "DATA_CONFLICT: Conflicting source observations require review.",
    })),
    lastError: health.lastError
      ? publicOperationalErrorText(health.lastError)
      : null,
  });
}

function safeMarketReason(reason: string): string {
  const normalized = reason.trim();
  if (
    normalized === "market recorder has not completed a successful poll" ||
    normalized === "market recorder has no next poll scheduled" ||
    normalized === "market recorder next poll timestamp is invalid" ||
    normalized === "market recorder configured; forecast health is independent" ||
    /^market recorder overdue since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized) ||
    /^quota (critical|low) \(\d+ remaining\); cadence (floored|reduced)$/.test(normalized)
  ) {
    return normalized;
  }
  if (normalized === "ODDS_API_KEY not configured") {
    return "CONFIGURATION_INCOMPLETE: A required operational dependency is not configured.";
  }
  return publicOperationalErrorText(normalized);
}

export function sanitizePublicMarketHealthReport(
  market: MarketHealthReport
): MarketHealthReport {
  return redactSensitivePublicValues({
    ...market,
    reasons: unique(market.reasons.map(safeMarketReason)),
    source: {
      ...market.source,
      id:
        market.source.id === "the-odds-api"
          ? market.source.id
          : "external-market-source",
      region: "uk",
      sport: "soccer_epl",
      market: "h2h",
    },
    lastError: market.lastError
      ? publicOperationalErrorText(market.lastError)
      : null,
    eventsHint: "Canonical fixture and observation counts are reported separately.",
    schemaVersion: /^[a-z0-9._-]{1,64}$/i.test(market.schemaVersion)
      ? market.schemaVersion
      : "unavailable",
  });
}

/** Composes the public health payload with a complete scoped market fallback. */
export async function buildPublicHealthResponse(options: {
  now?: Date;
  marketHealthBuilder?: (now?: Date) => Promise<MarketHealthReport>;
} = {}) {
  const now = options.now ?? new Date();
  await hydrateDurableOps();
  const health = buildHealthReport(now);
  const marketHealthBuilder = options.marketHealthBuilder ?? buildMarketHealthReport;
  let market: MarketHealthReport;
  try {
    market = await marketHealthBuilder(now);
  } catch (err) {
    recordInternalOperationalError("public-health.market", err);
    market = unavailableMarketHealthReport(
      now,
      publicOperationalErrorText(err)
    );
  }
  const publicHealth = sanitizePublicHealthReport(health);
  const publicMarket = sanitizePublicMarketHealthReport(market);
  return {
    ...publicHealth,
    freshness: {
      ...publicHealth.freshness,
      marketObserver: publicMarket.freshness,
    },
    market: publicMarket,
  };
}
