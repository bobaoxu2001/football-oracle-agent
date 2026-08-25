import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This legacy public route intentionally returns no conversation records.
 * Anonymous prompts remain internal operational data until user-scoped
 * authentication exists; they are never a global public activity feed.
 */
export async function GET() {
  return NextResponse.json(
    {
      count: 0,
      items: [],
      visibility: "private",
      note: "Public enumeration of anonymous user conversations is disabled.",
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
