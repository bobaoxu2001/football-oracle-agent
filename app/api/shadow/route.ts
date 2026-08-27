import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { shadowEvaluationReport } from "@/lib/competitions/premier-league/shadow/report";
import { compareFixture } from "@/lib/competitions/premier-league/shadow/compare";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { listCanonicalMatches } from "@/lib/match-ledger/store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { productionModelVersion } from "@/lib/competitions/premier-league/shadow/track";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import {
  publicFailureBody,
  recordInternalOperationalError,
  sanitizePublicOperationalPayload,
  sanitizePublicShadowReport,
} from "@/lib/competitions/premier-league/ops/public-errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/shadow                    → paired evaluation report
 * GET /api/shadow?fixture=<id>       → baseline vs shadow for one fixture
 *
 * The shadow model is EXPERIMENTAL and is never the served prediction. Every
 * response repeats `servingModelVersion` so a consumer cannot mistake the
 * challenger for production output.
 */
export async function GET(req: Request) {
  try {
    await hydrateDurableOps();
    const url = new URL(req.url);
    const fixtureId = url.searchParams.get("fixture");
    const season = PREMIER_LEAGUE_CURRENT_SEASON;
    const ledgerMetrics = canonicalLedgerMetrics(season);

    if (fixtureId) {
      const fixture = liveFixtures().find((f) => f.id === fixtureId);
      if (!fixture) {
        return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
      }
      const ledgerMatches = await listCanonicalMatches({
        competition: "premier-league",
        season,
      });
      const comparison = compareFixture({
        fixtureId,
        homeSlug: fixture.homeSlug,
        awaySlug: fixture.awaySlug,
        kickoffUtc: fixture.kickoffUtc ?? fixture.kickoff ?? null,
        ledgerMatches,
        season,
      });
      return NextResponse.json(sanitizePublicOperationalPayload({
        servingModelVersion: productionModelVersion(),
        ledgerMetrics,
        experimental: comparison.shadow.modelVersion,
        disclaimer:
          "The shadow model is a challenger under evaluation. It is never served as the product's prediction and a probability difference is not evidence that either model is better.",
        comparison,
      }));
    }

    const report = sanitizePublicShadowReport(shadowEvaluationReport(season));
    return NextResponse.json({
      servingModelVersion: productionModelVersion(),
      ledgerMetrics,
      disclaimer:
        "Paired forward out-of-sample evaluation. Headline metrics are withheld below the display threshold, and promotion is never automatic.",
      ...report,
    });
  } catch (err) {
    recordInternalOperationalError("api.shadow", err);
    return NextResponse.json(
      publicFailureBody("shadow_report_failed", err),
      { status: 500 }
    );
  }
}
