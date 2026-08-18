/**
 * Derived consensus. Not raw. Median of bookmaker fair probabilities.
 * Never described as a true probability.
 */

import { CONSENSUS_MEDIAN_V1, MARKET_SCHEMA_VERSION, type MarketConsensusSnapshot, type MarketObservation } from "./types";
import { dispersionOf, median } from "./odds-math";

export function consensusIdOf(fixtureId: string, pollJobId: string): string {
  return `consensus::${fixtureId}::${pollJobId}`;
}

export function buildConsensus(
  fixtureId: string,
  rows: MarketObservation[],
  pollJobId: string,
  computedAt: string
): MarketConsensusSnapshot | null {
  const matched = rows.filter((r) => r.canonicalFixtureId === fixtureId && r.mappingStatus === "MATCHED");
  if (!matched.length) return null;
  const homes = matched.map((r) => r.fairHome);
  const draws = matched.map((r) => r.fairDraw);
  const aways = matched.map((r) => r.fairAway);
  const margins = matched.map((r) => r.bookmakerMargin);
  const fairHome = median(homes);
  const fairDraw = median(draws);
  const fairAway = median(aways);
  const s = fairHome + fairDraw + fairAway;
  return {
    consensusId: consensusIdOf(fixtureId, pollJobId),
    marketSchemaVersion: MARKET_SCHEMA_VERSION,
    origin: matched[0].origin,
    source: matched[0].source,
    canonicalFixtureId: fixtureId,
    marketType: matched[0].marketType,
    retrievedAt: matched[0].retrievedAt,
    computedAt,
    pollJobId,
    bookmakerCount: matched.length,
    consensusMethod: CONSENSUS_MEDIAN_V1,
    fairHome: fairHome / s,
    fairDraw: fairDraw / s,
    fairAway: fairAway / s,
    marginMin: Math.min(...margins),
    marginMax: Math.max(...margins),
    dispersionHome: dispersionOf(homes),
    dispersionDraw: dispersionOf(draws),
    dispersionAway: dispersionOf(aways),
  };
}
