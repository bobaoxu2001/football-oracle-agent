/**
 * Ingest the official 2026-27 Premier League membership + fixture list.
 * Safe to run twice: upserts by stable fixture identity.
 */
import { ingestAndPersist } from "@/lib/competitions/premier-league/fixture-store";
import { evaluateDataGate } from "@/lib/competitions/premier-league/data-gate";

const result = ingestAndPersist(new Date().toISOString());
const gate = evaluateDataGate();
console.log(
  JSON.stringify(
    {
      season: result.season.season,
      clubs: result.season.clubIds.length,
      fixtures: result.fixtures.length,
      completeness: result.season.scheduleCompleteness,
      verification: result.season.verificationStatus,
      promoted: result.season.promotedClubIds,
      relegated: result.season.relegatedClubIds,
      revisions: result.revisions.length,
      gate,
    },
    null,
    2
  )
);
