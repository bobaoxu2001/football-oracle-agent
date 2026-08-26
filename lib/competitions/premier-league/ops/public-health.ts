import {
  buildMarketHealthReport,
  type MarketHealthReport,
  unavailableMarketHealthReport,
} from "../market/health";
import { hydrateDurableOps } from "./durable-store";
import { buildHealthReport } from "./health";

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
    market = unavailableMarketHealthReport(
      now,
      `market health unavailable: ${(err as Error).message}`
    );
  }
  return {
    ...health,
    freshness: {
      ...health.freshness,
      marketObserver: market.freshness,
    },
    market,
  };
}
