import { NextResponse } from "next/server";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = buildHealthReport();
  return NextResponse.json(health);
}
