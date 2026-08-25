import { NextRequest, NextResponse } from "next/server";
import {
  durableStorageDiagnostics,
  migrateMongoJobsToCompressedStorage,
} from "@/lib/competitions/premier-league/ops/durable-store";
import { authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { acquireTickLock, releaseTickLock } from "@/lib/competitions/premier-league/ops/tick-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

export async function POST(req: NextRequest) {
  const auth = authorizeOpsTick(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized", reason: auth.reason },
      { status: auth.status }
    );
  }
  let leaseId: string | null = null;
  // Leave room inside the function ceiling for lock release and the response.
  const deadline = Date.now() + 50_000;
  try {
    const lock = await acquireTickLock("jobs-compression-migration");
    if (!lock.ok) {
      return NextResponse.json(
        { error: "migration_locked", reason: lock.reason },
        { status: lock.reason === "tick already running" ? 409 : 503 }
      );
    }
    leaseId = lock.leaseId;
    return NextResponse.json(await migrateMongoJobsToCompressedStorage(deadline));
  } catch (err) {
    return NextResponse.json(
      { error: "storage_migration_failed", message: (err as Error).message },
      { status: 500 }
    );
  } finally {
    await releaseTickLock(leaseId);
  }
}
