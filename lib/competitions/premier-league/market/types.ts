/**
 * Phase 2B0 market recorder types.
 * Isolated from the forecasting engine. Observational only.
 */

export const MARKET_SCHEMA_VERSION = "market-recorder-v0.1.0";
export const MARKET_SOURCE_THE_ODDS_API = "the-odds-api";
export const MARKET_TYPE_H2H = "h2h";
export const DEVIG_PROPORTIONAL_V1 = "proportional-v1";
export const CONSENSUS_MEDIAN_V1 = "median-fair-v1";

export type MarketOrigin = "LIVE_RECORDED" | "HISTORICAL_PROVIDER" | "TEST";
export type MarketMappingStatus = "MATCHED" | "AMBIGUOUS" | "UNMATCHED" | "CONFLICT";
export type MarketPollStatus = "PENDING" | "SUCCEEDED" | "SKIPPED" | "FAILED" | "DEGRADED";
export type MarketHealthState = "HEALTHY" | "DEGRADED" | "UNCONFIGURED";

export interface Decimal1x2 {
  home: number;
  draw: number;
  away: number;
}

export interface Fair1x2 extends Decimal1x2 {}

export interface MarketSourceEvent {
  source: string;
  sourceEventId: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string | null;
  bookmakers: MarketSourceBookmaker[];
}

export interface MarketSourceBookmaker {
  bookmakerKey: string;
  bookmakerName: string;
  lastUpdate: string | null;
  outcomes: { name: string; price: number }[];
}

export interface MarketSourceFetchResult {
  source: string;
  retrievedAt: string;
  region: string;
  sportKey: string;
  marketType: string;
  events: MarketSourceEvent[];
  quota: MarketQuotaTelemetry;
}

export interface MarketQuotaTelemetry {
  remaining: number | null;
  used: number | null;
  lastRequestCost: number | null;
}

export interface MarketEventMapping {
  mappingId: string;
  source: string;
  sourceEventId: string;
  canonicalFixtureId: string | null;
  mappingStatus: MarketMappingStatus;
  mappedAt: string;
  mappingEvidence: string;
  sourceHome: string;
  sourceAway: string;
  sourceCommenceTime: string | null;
  resolvedHomeSlug: string | null;
  resolvedAwaySlug: string | null;
}

export interface MarketObservation {
  observationId: string;
  marketSchemaVersion: string;
  origin: MarketOrigin;
  source: string;
  sourceEventId: string;
  canonicalFixtureId: string;
  mappingStatus: "MATCHED";
  bookmakerKey: string;
  bookmakerName: string;
  marketType: string;
  retrievedAt: string;
  bookmakerLastUpdate: string | null;
  commenceTime: string | null;
  homeOddsDecimal: number;
  drawOddsDecimal: number;
  awayOddsDecimal: number;
  rawImpliedHome: number;
  rawImpliedDraw: number;
  rawImpliedAway: number;
  overround: number;
  bookmakerMargin: number;
  devigMethod: typeof DEVIG_PROPORTIONAL_V1;
  fairHome: number;
  fairDraw: number;
  fairAway: number;
  sourceRegion: string;
  pollJobId: string;
}

export interface Dispersion {
  min: number;
  max: number;
  stdev: number;
  iqr: number;
}

export interface MarketConsensusSnapshot {
  consensusId: string;
  marketSchemaVersion: string;
  origin: MarketOrigin;
  source: string;
  canonicalFixtureId: string;
  marketType: string;
  retrievedAt: string;
  computedAt: string;
  pollJobId: string;
  bookmakerCount: number;
  consensusMethod: typeof CONSENSUS_MEDIAN_V1;
  fairHome: number;
  fairDraw: number;
  fairAway: number;
  marginMin: number;
  marginMax: number;
  dispersionHome: Dispersion;
  dispersionDraw: Dispersion;
  dispersionAway: Dispersion;
}

export interface MarketPollJob {
  pollJobId: string;
  scheduledFor: string;
  executedAt: string | null;
  status: MarketPollStatus;
  cadenceMs: number;
  eventsReturned: number;
  fixturesCovered: number;
  fixturesMatched: number;
  fixturesUnmatched: number;
  fixturesAmbiguous: number;
  bookmakersObserved: number;
  observationsWritten: number;
  observationsDeduped: number;
  consensusWritten: number;
  quotaCost: number | null;
  quotaRemaining: number | null;
  error: string | null;
}

export interface MarketRecorderState {
  source: string;
  sourceConfigured: boolean;
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  lastSkipAt: string | null;
  lastError: string | null;
  lastQuota: MarketQuotaTelemetry;
  nextPollAt: string | null;
  currentCadenceMs: number | null;
  firstMarketObservationAt: string | null;
  firstPollSource: string | null;
  firstPollSchemaVersion: string | null;
  firstPollDeployment: string | null;
  polls: number;
}

export interface MarketDataSource {
  id: string;
  configured: boolean;
  fetchH2h(nowIso: string): Promise<MarketSourceFetchResult>;
}
