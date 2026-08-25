import { NextResponse } from "next/server";
import { computeTrackRecord } from "@/lib/prediction-engine/trackRecord";
import { loadDcReport } from "@/lib/prediction-engine/dcReport";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import {
  livePerformanceReport,
  publicLivePerformanceReport,
} from "@/lib/competitions/premier-league/live-ledger";
import { shadowEvaluationReport } from "@/lib/competitions/premier-league/shadow/report";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/accuracy
 * Explicitly separated production, shadow, and historical-reconstruction
 * evidence. Snapshot and fixture units use the same canonical count contract
 * as /api/live and /api/health.
 */
export async function GET() {
  await hydrateDurableOps();
  const ledgerMetrics = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const production = publicLivePerformanceReport(
    livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON)
  );
  const shadow = shadowEvaluationReport(PREMIER_LEAGUE_CURRENT_SEASON);
  const track = computeTrackRecord();
  const dc = loadDcReport();
  return NextResponse.json(
    {
      ledgerMetrics,
      production,
      shadow,
      historicalReconstruction: { track, dc },
      // Back-compatible reconstruction aliases. These are never production evidence.
      track,
      dc,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
