/**
 * Market-data health. Separate from forecast health.
 */

import { liveFixtures } from "../fixture-store";
import type { MarketHealthState } from "./types";
import { marketSourceConfigured } from "./source";
import { countConsensus, countObservations, listConsensus, listObservations, loadMarketState } from "./store";
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

export async function buildMarketHealthReport(): Promise<MarketHealthReport> {
  const state = await loadMarketState();
  const [nObs, nCons, obs, cons] = await Promise.all([
    countObservations(),
    countConsensus(),
    listObservations(),
    listConsensus(),
  ]);
  const fixtures = liveFixtures();
  const matched = new Set(obs.map((o) => o.canonicalFixtureId));
  const books = new Set(obs.map((o) => o.bookmakerKey));
  const configured = marketSourceConfigured();
  const reasons: string[] = [];
  let overall: MarketHealthState = "HEALTHY";
  if (!configured) {
    overall = "UNCONFIGURED";
    reasons.push("ODDS_API_KEY not configured");
  } else if (state.lastError && !state.lastSuccessAt) {
    overall = "DEGRADED";
    reasons.push(`market source error: ${state.lastError}`);
  } else if (state.lastQuota.remaining != null && state.lastQuota.remaining < QUOTA_CRITICAL) {
    overall = "DEGRADED";
    reasons.push(`quota critical (${state.lastQuota.remaining} remaining); cadence floored`);
  } else if (state.lastQuota.remaining != null && state.lastQuota.remaining < QUOTA_LOW) {
    overall = "DEGRADED";
    reasons.push(`quota low (${state.lastQuota.remaining} remaining); cadence reduced`);
  } else if (state.lastFailedAt && state.lastSuccessAt && state.lastFailedAt > state.lastSuccessAt) {
    overall = "DEGRADED";
    reasons.push(`last poll failed: ${state.lastError ?? "unknown"}`);
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
    eventsHint: `${fixtures.length} canonical fixtures; ${cons.length} consensus rows`,
    fixturesMatched: matched.size,
    unmatched: 0,
    ambiguous: 0,
    bookmakersObserved: books.size,
    observationsStored: nObs,
    consensusStored: nCons,
    firstMarketObservationAt: state.firstMarketObservationAt,
    schemaVersion: "market-recorder-v0.1.0",
  };
}
