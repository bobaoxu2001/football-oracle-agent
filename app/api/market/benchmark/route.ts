import { NextResponse } from "next/server";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { productionMarketBenchmarkReport } from "@/lib/competitions/premier-league/market/benchmark-report";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    return NextResponse.json(await productionMarketBenchmarkReport());
  } catch (err) {
    console.warn("[market-benchmark] report unavailable:", (err as Error).message);
    return NextResponse.json(
      {
        error: "market_benchmark_unavailable",
        note: "The observational benchmark is temporarily unavailable. Production forecasts are independent and unaffected.",
      },
      { status: 503 }
    );
  }
}
