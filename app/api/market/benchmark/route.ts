import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { productionMarketBenchmarkReport } from "@/lib/competitions/premier-league/market/benchmark-report";
import { recordInternalOperationalError } from "@/lib/competitions/premier-league/ops/public-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    return NextResponse.json(await productionMarketBenchmarkReport());
  } catch (err) {
    recordInternalOperationalError("api.market-benchmark", err);
    return NextResponse.json(
      {
        error: "market_benchmark_unavailable",
        note: "The observational benchmark is temporarily unavailable. Production forecasts are independent and unaffected.",
      },
      { status: 503 }
    );
  }
}
