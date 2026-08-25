import { NextRequest, NextResponse } from "next/server";
import { runGuardedLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { durableTickFreshness } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = authorizeOpsTick(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: auth.status });
  }
  try {
    if (req.nextUrl.searchParams.get("backup") === "1") {
      const freshness = await durableTickFreshness();
      if (freshness.fresh) {
        return NextResponse.json({
          skipped: true,
          skipReason: "primary tick is fresh",
          ...freshness,
        });
      }
    }
    const result = await runGuardedLiveOpsTick({
      skipObservers: req.nextUrl.searchParams.get("core") === "1",
    });
    if (result.skipped) {
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "tick_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
