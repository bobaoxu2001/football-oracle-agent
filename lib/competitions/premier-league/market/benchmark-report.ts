/** Read-only production composition for the pure Phase 4B0 benchmark. */

import { liveFixtures } from "../fixture-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { loadSettlements } from "../settlement";
import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { productionModelVersion } from "../shadow/track";
import { listConsensus } from "./store";
import { buildMarketBenchmarkReport } from "./benchmark";

export async function productionMarketBenchmarkReport(now = new Date()) {
  const consensus = await listConsensus();
  return buildMarketBenchmarkReport({
    snapshots: listLiveSnapshots({
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      evaluationClass: "LIVE_OOS",
    }),
    consensus,
    fixtures: liveFixtures().filter(
      (fixture) => fixture.season === PREMIER_LEAGUE_CURRENT_SEASON
    ),
    settlements: loadSettlements(),
    productionModelVersion: productionModelVersion(),
    evaluatedAt: now.toISOString(),
  });
}
