import { NextResponse } from "next/server";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    const health = buildHealthReport();
    let market = null;
    try {
      const { buildMarketHealthReport } = await import("@/lib/competitions/premier-league/market/health");
      market = await buildMarketHealthReport();
    } catch (err) {
      market = { overall: "DEGRADED", reasons: [`market health unavailable: ${(err as Error).message}`] };
    }
    return NextResponse.json({ ...health, market });
  } catch (err) {
    return NextResponse.json(
      { error: "health_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
