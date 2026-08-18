import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { listConsensus, listObservations, loadMarketState } from "@/lib/competitions/premier-league/market/store";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";

export const dynamic = "force-dynamic";

export async function GET() {
  await hydrateDurableOps();
  const [health, state, consensus, observations] = await Promise.all([
    buildMarketHealthReport(),
    loadMarketState(),
    listConsensus(),
    listObservations(),
  ]);
  const fixtures = liveFixtures();
  const latestByFixture = new Map<string, (typeof consensus)[number]>();
  for (const row of consensus) {
    const prev = latestByFixture.get(row.canonicalFixtureId);
    if (!prev || prev.retrievedAt < row.retrievedAt) latestByFixture.set(row.canonicalFixtureId, row);
  }
  const booksByFixture = new Map<string, Set<string>>();
  const lastObsByFixture = new Map<string, string>();
  for (const row of observations) {
    const set = booksByFixture.get(row.canonicalFixtureId) ?? new Set<string>();
    set.add(row.bookmakerKey);
    booksByFixture.set(row.canonicalFixtureId, set);
    const prev = lastObsByFixture.get(row.canonicalFixtureId);
    if (!prev || prev < row.retrievedAt) lastObsByFixture.set(row.canonicalFixtureId, row.retrievedAt);
  }

  const rows = [...latestByFixture.values()]
    .sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt))
    .map((c) => {
      const fx = fixtures.find((f) => f.id === c.canonicalFixtureId);
      return {
        fixtureId: c.canonicalFixtureId,
        home: fx ? getClub(fx.homeSlug).name : c.canonicalFixtureId,
        away: fx ? getClub(fx.awaySlug).name : "",
        kickoffUtc: fx?.kickoffUtc ?? fx?.kickoff ?? null,
        lastPoll: lastObsByFixture.get(c.canonicalFixtureId) ?? c.retrievedAt,
        bookmakersObserved: booksByFixture.get(c.canonicalFixtureId)?.size ?? c.bookmakerCount,
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
}
