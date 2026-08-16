/**
 * Live source dry run. Does not invent results. Does not write the frozen tape.
 *
 *   PATH=… FOOTBALL_DATA_API_KEY=… npx tsx scripts/dry-run-live-sources.ts
 */
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { kickoffCertaintyCounts } from "@/lib/competitions/premier-league/kickoff-certainty";
import {
  apiFootballConfigured,
  apiFootballSource,
  footballDataConfigured,
  footballDataSource,
  officialBaselineSource,
} from "@/lib/competitions/premier-league/ops/sources";
import { collectSourceObservations, syncFixturesFromObservations } from "@/lib/competitions/premier-league/ops/fixture-sync";

async function main() {
  const now = new Date().toISOString();
  const fixtures = liveFixtures();
  const before = kickoffCertaintyCounts(fixtures);
  const sources = [officialBaselineSource(fixtures), footballDataSource(), apiFootballSource()];
  const collected = await collectSourceObservations(sources, now);
  const sync = syncFixturesFromObservations({
    fixtures,
    observations: collected.observations,
    now,
    persistObservations: false,
  });
  const after = kickoffCertaintyCounts(sync.fixtures);
  const statusChanges = sync.revisions.filter((r) => String(r.oldStatus) !== String(r.newStatus)).length;
  const finishedIncoming = collected.observations.filter((o) => o.normalized.status === "FINISHED").length;
  console.log(
    JSON.stringify(
      {
        now,
        footballDataConfigured: footballDataConfigured(),
        apiFootballConfigured: apiFootballConfigured(),
        errors: collected.errors,
        observationCount: collected.observations.length,
        configuredLive: collected.configuredLive,
        fixtureMatches: sync.fixtures.length,
        changed: sync.changedFixtureIds.length,
        revisions: sync.revisions.length,
        statusChanges,
        conflicts: sync.conflicts,
        certaintyBefore: before,
        certaintyAfter: after,
        finishedObservations: finishedIncoming,
        note: "No persist. No fabricated results. Finished observations must be 0 before MW1.",
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
