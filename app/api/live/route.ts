import { NextResponse } from "next/server";
import { livePerformanceReport, ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { evaluateDataGate, upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { getClub } from "@/lib/competitions/premier-league/clubs";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const upcoming = upcomingLiveFixtures().slice(0, 8).map((f) => ({
    fixtureId: f.id,
    date: f.date,
    kickoffUtc: f.kickoffUtc,
    kickoffLocal: f.kickoffLocal,
    home: getClub(f.homeSlug).name,
    away: getClub(f.awaySlug).name,
    status: f.status,
  }));
  return NextResponse.json({
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    honesty: currentHonestyText(),
    model: loadProductionParams(),
    dataGate: evaluateDataGate(),
    ledger: ledgerCounts(PREMIER_LEAGUE_CURRENT_SEASON),
    liveOos: report,
    upcoming,
  });
}
