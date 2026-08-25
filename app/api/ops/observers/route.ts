import { NextRequest, NextResponse } from "next/server";
import {
  liveOpsObserversDegraded,
  runLiveOpsObservers,
} from "@/lib/competitions/premier-league/ops/tick";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { hydrateDurableFixtures } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = authorizeOpsTick(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason },
      { status: auth.status }
    );
  }
  try {
    await hydrateDurableFixtures();
    const result = await runLiveOpsObservers();
    return NextResponse.json(result, {
      status: liveOpsObserversDegraded(result) ? 503 : 200,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "observers_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
