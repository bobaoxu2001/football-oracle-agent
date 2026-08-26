/** Read-only production composition for the pure Phase 4B0 benchmark. */

import { liveFixtures } from "../fixture-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { loadSettlements } from "../settlement";
import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { productionModelVersion } from "../shadow/track";
import {
  countConsensus,
  listLatestConsensusAtOrBeforeByFixture,
  loadMarketState,
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
  const [state, consensusStored] = await Promise.all([
    loadMarketState(),
    countConsensus(),
  ]);
  const firstMarketAt = state.firstMarketObservationAt
    ? Date.parse(state.firstMarketObservationAt)
    : null;
  const cutoffByFixture = new Map(
    selection.latestSnapshots
      .filter(
        (snapshot) =>
          firstMarketAt === null || Date.parse(snapshot.asOf) >= firstMarketAt
      )
      .map((snapshot) => [snapshot.fixtureId, snapshot.asOf])
  );
  const consensus = cutoffByFixture.size
    ? await listLatestConsensusAtOrBeforeByFixture(cutoffByFixture)
    : [];
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
