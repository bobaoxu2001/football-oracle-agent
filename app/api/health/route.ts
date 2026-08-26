import { NextResponse } from "next/server";
import { buildPublicHealthResponse } from "@/lib/competitions/premier-league/ops/public-health";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildPublicHealthResponse());
  } catch (err) {
    return NextResponse.json(
      { error: "health_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
