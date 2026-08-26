import { NextResponse } from "next/server";
import { fixtureLiveView } from "@/lib/competitions/premier-league/live-ledger";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { getVerification } from "@/lib/competitions/premier-league/ops/result-feed";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { jobsForFixture } from "@/lib/competitions/premier-league/ops/job-ledger";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { forecastFreshness } from "@/lib/match-forecast/service";
import { effectiveSnapshotGeneratedAt } from "@/lib/snapshots/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await hydrateDurableOps();
  const now = new Date();
  const fixture = liveFixtures().find((f) => f.id === id);
  if (!fixture) return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
  const view = fixtureLiveView(id, fixture.season, now);
  const verification = getVerification(id);
  const jobs = jobsForFixture(id);
  const freshness = forecastFreshness(
    fixture,
    listLiveSnapshots({ fixtureId: id }),
    now,
    jobs
  );
  const currentKickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  return NextResponse.json({
    fixture: {
      id: fixture.id,
      home: getClub(fixture.homeSlug).name,
      away: getClub(fixture.awaySlug).name,
      kickoffUtc: fixture.kickoffUtc,
      kickoffCertainty: fixture.kickoffCertainty,
      status: fixture.status,
      homeGoals: fixture.homeGoals,
      awayGoals: fixture.awayGoals,
    },
    verification,
    freshness,
    stages: Object.fromEntries(
      Object.entries(view.byStage).map(([stage, row]) => [
        stage,
        {
          schedulerJob:
            jobs
              .filter((job) => job.stage === stage)
              .sort((a, b) => {
                const aCurrent = a.kickoffUtc === currentKickoff ? 1 : 0;
                const bCurrent = b.kickoffUtc === currentKickoff ? 1 : 0;
                return bCurrent - aCurrent || b.updatedAt.localeCompare(a.updatedAt);
              })[0] ?? null,
          predicted: row.snapshot
            ? {
                home: row.snapshot.homeProbability,
                draw: row.snapshot.drawProbability,
                away: row.snapshot.awayProbability,
                asOf: row.snapshot.asOf,
                generatedAt: effectiveSnapshotGeneratedAt(row.snapshot),
                kickoffAtFreeze: row.snapshot.kickoff,
                kickoffIdentityCurrent: row.kickoffIdentityCurrent,
                validForStagePolicy: row.validForStagePolicy,
                validForCurrentSelection: row.validForCurrentSelection,
                validityIssues: row.validityIssues,
                modelVersion: row.snapshot.modelVersion,
              }
            : null,
          settlement: row.settlement
            ? {
                actualOutcome: row.settlement.actualOutcome,
                actualScore: row.settlement.actualScore,
                brier: row.settlement.brier,
                rps: row.settlement.rps,
                logLoss: row.settlement.logLoss,
                topPickCorrect: row.settlement.topPickCorrect,
              }
            : null,
        },
      ])
    ),
    immutableTimeline: view.timeline.map(({ snapshot, ...validity }) => ({
      snapshotKey: snapshot.provenance.uniqueKey,
      stage: snapshot.predictionStage,
      cutoffAt: snapshot.asOf,
      generatedAt: effectiveSnapshotGeneratedAt(snapshot),
      kickoffAtFreeze: snapshot.kickoff,
      ...validity,
      modelVersion: snapshot.modelVersion,
    })),
  });
}
