import { NextResponse } from "next/server";
import { upcomingMatchForecasts } from "@/lib/match-forecast/service";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    return NextResponse.json(
      { competition: "premier-league", support: "production", matches: upcomingMatchForecasts(8) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("[/api/matches/upcoming] error:", error);
    return NextResponse.json(
      { error: "UPCOMING_MATCHES_UNAVAILABLE", matches: [] },
      { status: 503 }
    );
  }
}
