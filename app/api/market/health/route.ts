import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import { sanitizePublicMarketHealthReport } from "@/lib/competitions/premier-league/ops/public-health";
import {
  publicFailureBody,
  recordInternalOperationalError,
} from "@/lib/competitions/premier-league/ops/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    return NextResponse.json(
      sanitizePublicMarketHealthReport(await buildMarketHealthReport())
    );
  } catch (err) {
    recordInternalOperationalError("api.market-health", err);
    return NextResponse.json(
      publicFailureBody("market_health_failed", err),
      { status: 500 }
    );
  }
}
