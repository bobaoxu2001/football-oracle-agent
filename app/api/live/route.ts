import { NextResponse } from "next/server";
import {
  livePerformanceReport,
  publicLivePerformanceReport,
} from "@/lib/competitions/premier-league/live-ledger";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { evaluateDataGate, upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";

export const dynamic = "force-dynamic";

export async function GET() {
  await hydrateDurableOps();
  const report = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const publicReport = publicLivePerformanceReport(report);
  const ledgerMetrics = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const health = buildHealthReport();
  const upcoming = upcomingLiveFixtures().slice(0, 8).map((f) => ({
    fixtureId: f.id,
    date: f.date,
    kickoffUtc: f.kickoffUtc,
    kickoffLocal: f.kickoffLocal,
    kickoffCertainty: f.kickoffCertainty ?? null,
    scheduledDate: f.scheduledDate ?? f.date,
    home: getClub(f.homeSlug).name,
    away: getClub(f.awaySlug).name,
    status: f.status,
  }));
  return NextResponse.json({
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    honesty: currentHonestyText(),
    model: loadProductionParams(),
    dataGate: evaluateDataGate(),
    ledgerMetrics,
    ledger: {
      role: "production",
      totalForecastSnapshots: ledgerMetrics.production.totalForecastSnapshots,
      settledForecastSnapshots: ledgerMetrics.production.settledForecastSnapshots,
      unsettledForecastSnapshots: ledgerMetrics.production.unsettledForecastSnapshots,
      uniqueFixturesForecast: ledgerMetrics.production.uniqueFixturesForecast,
      uniqueFixturesSettled: ledgerMetrics.production.uniqueFixturesSettled,
      committedForecastSnapshots: ledgerMetrics.production.committedForecastSnapshots,
      operationalForecastSnapshots: ledgerMetrics.production.operationalForecastSnapshots,
    },
    settlements: ledgerMetrics.settlements,
    freshness: health.freshness,
    productionPerformance: publicReport,
    stagePerformance: publicReport.byStage,
    upcoming,
  });
}
