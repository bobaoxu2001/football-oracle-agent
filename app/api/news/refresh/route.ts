import { NextResponse } from "next/server";
import { refreshNews, TRACKED_TEAMS } from "@/lib/news/newsIngestor";
import { secretsMatch } from "@/lib/competitions/premier-league/ops/tick-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Full refresh paces ~10 teams behind GNews rate limits (~30s+), so give the
// cron headroom past the short default function timeout. 60s is the Hobby max;
// Pro/Enterprise can raise this further.
export const maxDuration = 60;

/**
 * Daily news refresh endpoint.
 *
 *   GET  /api/news/refresh            → refresh all tracked teams
 *   GET  /api/news/refresh?team=brazil → refresh one team
 *   POST /api/news/refresh            → same as GET (for schedulers that POST)
 *
 * Fetches recent news for tracked teams, classifies + scores each item, and
 * saves to MongoDB `team_news` (falling back to the in-memory store). With no
 * news API key configured it refreshes with curated demo signals, so it always
 * returns a useful summary and never breaks.
 *
 * ── Schedule it daily ─────────────────────────────────────────────────────
 * Vercel Cron (vercel.json):
 *   { "crons": [{ "path": "/api/news/refresh", "schedule": "0 6 * * *" }] }
 * GitHub Actions / any external scheduler:
 *   curl -fsS https://<your-app>/api/news/refresh
 */
async function handle(req: Request) {
  try {
    // Optional protection: when CRON_SECRET is set, require its bearer token.
    // Vercel Cron automatically sends `Authorization: Bearer ${CRON_SECRET}`
    // when that env var exists, so the daily schedule keeps working unchanged.
    // Without CRON_SECRET the route stays open (zero-config demo behavior).
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const header = req.headers.get("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!secretsMatch(presented, secret)) {
        return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      }
    }

    const url = new URL(req.url);
    const team = url.searchParams.get("team");
    const teams = team ? [team] : TRACKED_TEAMS;
    const summary = await refreshNews(teams);
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[/api/news/refresh] error:", err);
    // Never hard-fail a scheduler — report the problem with a 200-ish shape.
    return NextResponse.json(
      { ok: false, error: "Refresh failed but the app continues to run on existing data." },
      { status: 500 }
    );
  }
}

export const GET = handle;
export const POST = handle;
