import { NextResponse } from "next/server";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await hydrateDurableOps();
    const health = buildHealthReport();
    return NextResponse.json(health);
  } catch (err) {
    return NextResponse.json(
      { error: "health_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
