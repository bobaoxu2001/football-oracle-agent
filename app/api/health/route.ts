import { NextResponse } from "next/server";
import { buildPublicHealthResponse } from "@/lib/competitions/premier-league/ops/public-health";
import {
  publicFailureBody,
  recordInternalOperationalError,
} from "@/lib/competitions/premier-league/ops/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildPublicHealthResponse());
  } catch (err) {
    recordInternalOperationalError("api.health", err);
    return NextResponse.json(
      publicFailureBody("health_failed", err),
      { status: 500 }
    );
  }
}
