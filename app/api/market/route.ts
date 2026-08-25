import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { listLatestConsensus, loadMarketState } from "@/lib/competitions/premier-league/market/store";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    const [health, state, consensus] = await Promise.all([
      buildMarketHealthReport(),
      loadMarketState(),
      listLatestConsensus(),
    ]);
    const fixtures = liveFixtures();

    const rows = consensus
      .sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt))
      .map((c) => {
        const fx = fixtures.find((f) => f.id === c.canonicalFixtureId);
        return {
          fixtureId: c.canonicalFixtureId,
          home: fx ? getClub(fx.homeSlug).name : c.canonicalFixtureId,
          away: fx ? getClub(fx.awaySlug).name : "",
          kickoffUtc: fx?.kickoffUtc ?? fx?.kickoff ?? null,
          lastPoll: c.retrievedAt,
          bookmakersObserved: c.bookmakerCount,
          consensusMethod: c.consensusMethod,
          marketImpliedFairHome: c.fairHome,
          marketImpliedFairDraw: c.fairDraw,
          marketImpliedFairAway: c.fairAway,
          marginRange: { min: c.marginMin, max: c.marginMax },
          observationAgeMs: Date.now() - Date.parse(c.retrievedAt),
        };
      });

    return NextResponse.json({
      honesty:
        "Market-implied fair probabilities are another forecast (proportional de-vig of bookmaker 1X2). They are not a recommendation, edge, or stake.",
      schemaVersion: health.schemaVersion,
      origin: "LIVE_RECORDED",
      firstMarketObservationAt: state.firstMarketObservationAt,
      health,
      fixtures: rows,
    });
  } catch (err) {
    console.warn("[market] public summary unavailable:", (err as Error).message);
    return NextResponse.json(
      {
        error: "market_summary_unavailable",
        note: "Observational market data is temporarily unavailable. Production forecasts are independent and unaffected.",
      },
      { status: 503 }
    );
  }
}
