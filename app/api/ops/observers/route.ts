import { NextRequest, NextResponse } from "next/server";
import {
  liveOpsObserversDegraded,
  runGuardedLiveOpsObservers,
} from "@/lib/competitions/premier-league/ops/tick";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import {
  publicFailureBody,
  recordInternalOperationalError,
  sanitizePublicOperationalPayload,
} from "@/lib/competitions/premier-league/ops/public-errors";

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
    const result = await runGuardedLiveOpsObservers();
    return NextResponse.json(sanitizePublicOperationalPayload(result), {
      status: result.skipped ? 409 : liveOpsObserversDegraded(result) ? 503 : 200,
    });
  } catch (err) {
    recordInternalOperationalError("api.ops-observers", err);
    return NextResponse.json(
      publicFailureBody("observers_failed", err),
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
