/**
 * Market source port. Only The Odds API is implemented in Phase 2B0.
 */

import type { MarketDataSource } from "./types";
import { TheOddsApiMarketSource, oddsApiConfigured } from "./the-odds-api";

export function defaultMarketSource(): MarketDataSource {
  return new TheOddsApiMarketSource();
}

export function marketSourceConfigured(): boolean {
  return oddsApiConfigured();
}
