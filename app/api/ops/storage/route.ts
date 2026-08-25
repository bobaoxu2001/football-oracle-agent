import { NextRequest, NextResponse } from "next/server";
import { durableStorageDiagnostics } from "@/lib/competitions/premier-league/ops/durable-store";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = authorizeOpsTick(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason },
      { status: auth.status }
    );
  }
  try {
    return NextResponse.json(await durableStorageDiagnostics());
  } catch (err) {
    return NextResponse.json(
      { error: "storage_diagnostics_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
