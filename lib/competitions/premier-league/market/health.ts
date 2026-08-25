/**
 * Market-data health. Separate from forecast health.
 */

import { liveFixtures } from "../fixture-store";
import type { MarketHealthState, MarketRecorderState } from "./types";
import { marketSourceConfigured } from "./source";
import { loadMarketState, marketHealthCounts } from "./store";
import { QUOTA_CRITICAL, QUOTA_LOW } from "./cadence";

export interface MarketHealthReport {
  overall: MarketHealthState;
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
  fixturesMatched: number;
  unmatched: number;
  ambiguous: number;
  bookmakersObserved: number;
  observationsStored: number;
  consensusStored: number;
  firstMarketObservationAt: string | null;
  schemaVersion: string;
}

export const MARKET_HEALTH_SCHEDULER_JITTER_MS = 7 * 60_000;

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
