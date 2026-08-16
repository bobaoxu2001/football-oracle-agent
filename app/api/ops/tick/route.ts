import { NextRequest, NextResponse } from "next/server";
import { runGuardedLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = authorizeOpsTick(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized", reason: auth.reason }, { status: auth.status });
  }
  try {
    const result = await runGuardedLiveOpsTick();
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
