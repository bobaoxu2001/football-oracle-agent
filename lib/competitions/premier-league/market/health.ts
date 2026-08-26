/**
 * Market-data health. Separate from forecast health.
 */

import { liveFixtures } from "../fixture-store";
import type { MarketHealthState, MarketRecorderState } from "./types";
import { marketSourceConfigured } from "./source";
import { loadMarketState, marketHealthCounts } from "./store";
import { CADENCE_FAR_MS, QUOTA_CRITICAL, QUOTA_LOW } from "./cadence";
import {
  evaluateMarketObserverFreshness,
  type MarketObserverFreshness,
} from "../ops/production-freshness";
import { MARKET_SCHEMA_VERSION, MARKET_SOURCE_THE_ODDS_API } from "./types";

export interface MarketHealthReport {
  overall: MarketHealthState;
  freshness: MarketObserverFreshness;
  reasons: string[];
  source: {
    id: string;
    configured: boolean;
    region: string;
    sport: string;
    market: string;
  };
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  quotaRemaining: number | null;
  quotaUsed: number | null;
  lastRequestCost: number | null;
  nextScheduledPoll: string | null;
  currentCadenceMs: number | null;
  eventsHint: string;
  fixturesMatched: number | null;
  unmatched: number | null;
  ambiguous: number | null;
  bookmakersObserved: number | null;
  observationsStored: number | null;
  consensusStored: number | null;
  firstMarketObservationAt: string | null;
  schemaVersion: string;
}

export const MARKET_HEALTH_SCHEDULER_JITTER_MS = 7 * 60_000;

/** Full-shape, fail-closed response for an unavailable observational store. */
export function unavailableMarketHealthReport(
  now: Date,
  reason: string
): MarketHealthReport {
  const configured = marketSourceConfigured();
  const freshness = evaluateMarketObserverFreshness({
    evaluatedAt: now.toISOString(),
    configured,
    lastAttemptAt: null,
    lastSuccessAt: null,
    staleAfterMs: CADENCE_FAR_MS + MARKET_HEALTH_SCHEDULER_JITTER_MS,
    cadenceMs: null,
    lastError: reason,
  });
  return {
    overall: "DEGRADED",
    freshness,
    reasons: [reason],
    source: {
      id: MARKET_SOURCE_THE_ODDS_API,
      configured,
      region: "uk",
      sport: "soccer_epl",
      market: "h2h",
    },
    lastSuccessAt: null,
    lastFailedAt: null,
    lastError: reason,
    quotaRemaining: null,
    quotaUsed: null,
    lastRequestCost: null,
    nextScheduledPoll: null,
    currentCadenceMs: null,
    eventsHint: "market health unavailable; counts were not read",
    fixturesMatched: null,
    unmatched: null,
    ambiguous: null,
    bookmakersObserved: null,
    observationsStored: null,
    consensusStored: null,
    firstMarketObservationAt: null,
    schemaVersion: MARKET_SCHEMA_VERSION,
  };
}

/** Freshness truth independent of quota/source-error classification. */
export function marketRecorderFreshnessReasons(
  state: Pick<MarketRecorderState, "lastSuccessAt" | "nextPollAt">,
  now = new Date()
): string[] {
  if (!state.lastSuccessAt) {
    return ["market recorder has not completed a successful poll"];
  }
  if (!state.nextPollAt) {
    return ["market recorder has no next poll scheduled"];
  }
  const nextPollMs = Date.parse(state.nextPollAt);
  if (!Number.isFinite(nextPollMs)) {
    return ["market recorder next poll timestamp is invalid"];
  }
  if (now.getTime() > nextPollMs + MARKET_HEALTH_SCHEDULER_JITTER_MS) {
    return [`market recorder overdue since ${state.nextPollAt}`];
  }
  return [];
}

export async function buildMarketHealthReport(now = new Date()): Promise<MarketHealthReport> {
  const [state, counts] = await Promise.all([
    loadMarketState(),
    marketHealthCounts(),
  ]);
  const fixtures = liveFixtures();
  const configured = marketSourceConfigured();
  const lastAttemptAt = [state.lastSuccessAt, state.lastFailedAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const freshness = evaluateMarketObserverFreshness({
    evaluatedAt: now.toISOString(),
    configured,
    lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    staleAfterMs:
      (state.currentCadenceMs ?? CADENCE_FAR_MS) + MARKET_HEALTH_SCHEDULER_JITTER_MS,
    cadenceMs: state.currentCadenceMs,
    lastError:
      state.lastFailedAt && (!state.lastSuccessAt || state.lastFailedAt > state.lastSuccessAt)
        ? state.lastError
        : null,
  });
  const reasons: string[] = [];
  let overall: MarketHealthState = "HEALTHY";
  if (!configured) {
    overall = "UNCONFIGURED";
    reasons.push("ODDS_API_KEY not configured");
  } else {
    const freshnessReasons = marketRecorderFreshnessReasons(state, now);
    if (freshnessReasons.length) {
      overall = "DEGRADED";
      reasons.push(...freshnessReasons);
    }
    if (state.lastError && !state.lastSuccessAt) {
      overall = "DEGRADED";
      reasons.push(`market source error: ${state.lastError}`);
    }
    if (state.lastQuota.remaining != null && state.lastQuota.remaining < QUOTA_CRITICAL) {
      overall = "DEGRADED";
      reasons.push(`quota critical (${state.lastQuota.remaining} remaining); cadence floored`);
    } else if (state.lastQuota.remaining != null && state.lastQuota.remaining < QUOTA_LOW) {
      overall = "DEGRADED";
      reasons.push(`quota low (${state.lastQuota.remaining} remaining); cadence reduced`);
    }
    if (state.lastFailedAt && state.lastSuccessAt && state.lastFailedAt > state.lastSuccessAt) {
      overall = "DEGRADED";
      reasons.push(`last poll failed: ${state.lastError ?? "unknown"}`);
    }
  }
  if (overall === "HEALTHY") {
    reasons.push("market recorder configured; forecast health is independent");
  }

  return {
    overall,
    freshness,
    reasons,
    source: {
      id: state.source,
      configured,
      region: "uk",
      sport: "soccer_epl",
      market: "h2h",
    },
    lastSuccessAt: state.lastSuccessAt,
    lastFailedAt: state.lastFailedAt,
    lastError: state.lastError,
    quotaRemaining: state.lastQuota.remaining,
    quotaUsed: state.lastQuota.used,
    lastRequestCost: state.lastQuota.lastRequestCost,
    nextScheduledPoll: state.nextPollAt,
    currentCadenceMs: state.currentCadenceMs,
    eventsHint: `${fixtures.length} canonical fixtures; ${counts.consensusStored} consensus rows`,
    fixturesMatched: counts.fixturesMatched,
    unmatched: 0,
    ambiguous: 0,
    bookmakersObserved: counts.bookmakersObserved,
    observationsStored: counts.observationsStored,
    consensusStored: counts.consensusStored,
    firstMarketObservationAt: state.firstMarketObservationAt,
    schemaVersion: "market-recorder-v0.1.0",
  };
}
