/**
 * Timestamp-safe model/market joins. No lookahead.
 */

import type { MarketConsensusSnapshot, MarketObservation } from "./types";

export function latestAtOrBefore<T extends { retrievedAt: string }>(rows: T[], asOf: string): T | null {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return null;
  let best: T | null = null;
  for (const row of rows) {
    const r = Date.parse(row.retrievedAt);
    if (!Number.isFinite(r) || r > t) continue;
    if (!best || Date.parse(best.retrievedAt) < r) best = row;
  }
  return best;
}

/** Comparable market for a model snapshot at asOf = T: latest observation with retrievedAt <= T. */
export function alignMarketToModelAsOf(rows: MarketObservation[], asOf: string): MarketObservation | null {
  return latestAtOrBefore(rows, asOf);
}

export function alignConsensusToModelAsOf(
  rows: MarketConsensusSnapshot[],
  asOf: string
): MarketConsensusSnapshot | null {
  return latestAtOrBefore(rows, asOf);
}

/**
 * ClosingMarketSnapshot = latest valid LIVE_RECORDED pre-match consensus
 * with retrievedAt strictly before kickoffUtc.
 */
export function closingConsensus(
  rows: MarketConsensusSnapshot[],
  kickoffUtc: string
): MarketConsensusSnapshot | null {
  const k = Date.parse(kickoffUtc);
  if (!Number.isFinite(k)) return null;
  let best: MarketConsensusSnapshot | null = null;
  for (const row of rows) {
    if (row.origin !== "LIVE_RECORDED") continue;
    const r = Date.parse(row.retrievedAt);
    if (!Number.isFinite(r) || r >= k) continue;
    if (!best || Date.parse(best.retrievedAt) < r) best = row;
  }
  return best;
}

export function closingObservation(rows: MarketObservation[], kickoffUtc: string): MarketObservation | null {
  const k = Date.parse(kickoffUtc);
  if (!Number.isFinite(k)) return null;
  let best: MarketObservation | null = null;
  for (const row of rows) {
    if (row.origin !== "LIVE_RECORDED") continue;
    const r = Date.parse(row.retrievedAt);
    if (!Number.isFinite(r) || r >= k) continue;
    if (!best || Date.parse(best.retrievedAt) < r) best = row;
  }
  return best;
}
