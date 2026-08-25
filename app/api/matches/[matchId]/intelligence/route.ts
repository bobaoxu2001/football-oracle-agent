import { NextResponse } from "next/server";
import { getMatchIntelligence, MatchForecastError } from "@/lib/match-forecast/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ matchId: string }> }
) {
  try {
    const { matchId } = await params;
    const intelligence = await getMatchIntelligence(matchId);
    return NextResponse.json(intelligence, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof MatchForecastError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("[/api/matches/:matchId/intelligence] error:", error);
    return NextResponse.json(
      { error: "INTELLIGENCE_FAILED", message: "Match intelligence is temporarily unavailable." },
      { status: 500 }
    );
  }
}
