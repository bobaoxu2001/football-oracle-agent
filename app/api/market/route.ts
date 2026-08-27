import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { listLatestConsensus, loadMarketState } from "@/lib/competitions/premier-league/market/store";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import { productionMarketBenchmarkReport } from "@/lib/competitions/premier-league/market/benchmark-report";
import { marketQualityFlags } from "@/lib/competitions/premier-league/market/benchmark";
import { sanitizePublicMarketHealthReport } from "@/lib/competitions/premier-league/ops/public-health";
import { recordInternalOperationalError } from "@/lib/competitions/premier-league/ops/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    const [internalHealth, state, consensus, benchmark] = await Promise.all([
      buildMarketHealthReport(),
      loadMarketState(),
      listLatestConsensus(),
      productionMarketBenchmarkReport(),
    ]);
    const health = sanitizePublicMarketHealthReport(internalHealth);
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
          qualityFlags: marketQualityFlags(c),
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
      benchmark: {
        schemaVersion: benchmark.schemaVersion,
        status: benchmark.status,
        observationalOnly: benchmark.observationalOnly,
        affectsProductionForecast: benchmark.affectsProductionForecast,
        independentUnit: benchmark.independentUnit,
        aggregationUnit: benchmark.aggregationUnit,
        temporalRule: benchmark.temporalRule,
        definitions: benchmark.definitions,
        counts: benchmark.counts,
        maturity: benchmark.maturity,
        performance: benchmark.performance,
      },
      fixtures: rows,
    });
  } catch (err) {
    recordInternalOperationalError("api.market-summary", err);
    return NextResponse.json(
      {
        error: "market_summary_unavailable",
        note: "Observational market data is temporarily unavailable. Production forecasts are independent and unaffected.",
      },
      { status: 503 }
    );
  }
}
