/** Read-only production composition for the pure Phase 4B0 benchmark. */

import { liveFixtures } from "../fixture-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { loadSettlements } from "../settlement";
import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { productionModelVersion } from "../shadow/track";
import {
  countConsensus,
  listLatestConsensusAtOrBeforeByFixture,
} from "./store";
import {
  buildMarketBenchmarkReport,
  selectMarketBenchmarkForecasts,
} from "./benchmark";

export async function productionMarketBenchmarkReport(now = new Date()) {
  const evaluatedAt = now.toISOString();
  const fixtures = liveFixtures().filter(
    (fixture) => fixture.season === PREMIER_LEAGUE_CURRENT_SEASON
  );
  const snapshots = listLiveSnapshots({
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    evaluationClass: "LIVE_OOS",
  });
  const modelVersion = productionModelVersion();
  const selection = selectMarketBenchmarkForecasts({
    snapshots,
    fixtures,
    productionModelVersion: modelVersion,
    evaluatedAt,
  });
  const cutoffByFixture = new Map(
    selection.latestSnapshots.map((snapshot) => [snapshot.fixtureId, snapshot.asOf])
  );
  const [consensus, consensusStored] = await Promise.all([
    listLatestConsensusAtOrBeforeByFixture(cutoffByFixture),
    countConsensus(),
  ]);
  return buildMarketBenchmarkReport({
    snapshots,
    consensus,
    marketConsensusSnapshotsStored: consensusStored,
    fixtures,
    settlements: loadSettlements(),
    productionModelVersion: modelVersion,
    evaluatedAt,
  });
}
