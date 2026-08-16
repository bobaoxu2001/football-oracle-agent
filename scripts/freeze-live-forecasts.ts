/**
 * Freeze genuine pre-match LIVE_OOS snapshots for upcoming 2026-27 fixtures.
 * Refuses to label anything at or after kickoff as LIVE_OOS.
 */
import { freezeUpcomingForecasts } from "@/lib/competitions/premier-league/live-loop";
import { runAndPersistCurrentSeasonSimulation } from "@/lib/competitions/premier-league/sim-snapshot";
import { ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { archiveLiveOosSnapshots, listSnapshots } from "@/lib/snapshots/store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

const asOf = new Date().toISOString();
const n = freezeUpcomingForecasts({ asOf });
const sim = runAndPersistCurrentSeasonSimulation({ asOf, sims: 4000 });
const counts = ledgerCounts(PREMIER_LEAGUE_CURRENT_SEASON);
const upcoming = upcomingLiveFixtures();
const snaps = listSnapshots().filter(
  (s) => s.evaluationClass === "LIVE_OOS" && s.season === PREMIER_LEAGUE_CURRENT_SEASON
);
archiveLiveOosSnapshots(snaps);

console.log(
  JSON.stringify(
    {
      asOf,
      frozenThisRun: n,
      ledger: counts,
      simulation: {
        asOf: sim.simulationAsOf,
        completed: sim.completedFixturesIncluded,
        remaining: sim.remainingFixtureCount,
        modelVersion: sim.modelVersion,
        top: sim.clubs.slice(0, 5).map((c) => ({
          name: c.name,
          champion: Number(c.champion.toFixed(4)),
          expPos: Number(c.expectedPosition.toFixed(2)),
        })),
      },
      nextFixtures: upcoming.slice(0, 5).map((f) => ({
        id: f.id,
        home: getClub(f.homeSlug).name,
        away: getClub(f.awaySlug).name,
        kickoffUtc: f.kickoffUtc,
        kickoffLocal: f.kickoffLocal,
      })),
      firstForecasts: snaps
        .filter((s) => upcoming.slice(0, 5).some((f) => f.id === s.fixtureId))
        .map((s) => ({
          fixtureId: s.fixtureId,
          home: s.homeTeam,
          away: s.awayTeam,
          p: [s.homeProbability, s.drawProbability, s.awayProbability].map((x) => Number(x.toFixed(4))),
          lambda: [s.homeGoalExpectation, s.awayGoalExpectation].map((x) => Number(x.toFixed(2))),
          modelVersion: s.modelVersion,
          asOf: s.asOf,
          kickoff: s.kickoff,
          stage: s.predictionStage,
          evaluationClass: s.evaluationClass,
        })),
    },
    null,
    2
  )
);
