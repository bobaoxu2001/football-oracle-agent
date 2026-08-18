import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    return NextResponse.json(await buildMarketHealthReport());
  } catch (err) {
    return NextResponse.json(
      { error: "market_health_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
