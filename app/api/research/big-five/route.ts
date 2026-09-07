import { NextResponse } from "next/server";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import {
  RESEARCH_FORECAST_COMPETITION_IDS,
  ResearchForecastError,
  isResearchForecastCompetitionId,
} from "@/lib/competitions/big-five/research-params";
import {
  loadResearchForecastBoard,
  loadResearchMatchForecast,
} from "@/lib/competitions/big-five/research-service";
import {
  publicFailureBody,
  recordInternalOperationalError,
} from "@/lib/competitions/premier-league/ops/public-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/research/big-five?competition=la-liga
 * GET /api/research/big-five?competition=la-liga&matchId=pd-2026-27-getafe-celta-vigo
 *
 * Research 1X2 only. Premier League is refused. Not a production snapshot.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requested = url.searchParams.get("competition") ?? "la-liga";
    const matchId = url.searchParams.get("matchId");
    const season = url.searchParams.get("season") || BIG_FIVE_CURRENT_SEASON;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    if (requested === "premier-league") {
      return NextResponse.json(
        {
          error: "PRODUCTION_ISOLATION",
          support: "research",
          production: false,
          message:
            "Premier League forecasts are frozen pl-live-v0.2.0 production artifacts. This research API will not mint a parallel Premier League number.",
        },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    if (!isResearchForecastCompetitionId(requested)) {
      return NextResponse.json(
        {
          error: "unknown competition",
          supported: RESEARCH_FORECAST_COMPETITION_IDS,
          production: false,
        },
        { status: 400, headers: { "Cache-Control": "private, no-store" } }
      );
    }

    if (matchId) {
      const forecast = await loadResearchMatchForecast({
        competition: requested,
        matchId,
        season,
      });
      return NextResponse.json(forecast, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const board = await loadResearchForecastBoard({
      competition: requested,
      season,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json(board, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ResearchForecastError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          support: "research",
          production: false,
        },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    recordInternalOperationalError("api.research.big-five", error);
    return NextResponse.json(publicFailureBody("research_forecast_failed", error), {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
