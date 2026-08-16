import { NextRequest, NextResponse } from "next/server";
import { runLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const query = req.nextUrl.searchParams.get("secret") ?? "";
  return bearer === secret || query === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runLiveOpsTick();
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  return GET(req);
}
