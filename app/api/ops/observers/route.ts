import { NextRequest, NextResponse } from "next/server";
import {
  liveOpsObserversDegraded,
  runLiveOpsObservers,
} from "@/lib/competitions/premier-league/ops/tick";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { hydrateDurableFixtures } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";
// Observers are isolated from the 60-second production forecast tick. The
// normal path is much faster, but a full five-league ingest must be allowed to
// finish and persist an explicit result when Atlas or a provider is briefly
// slow instead of being hard-killed at the old shared deadline.
export const maxDuration = 120;

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
