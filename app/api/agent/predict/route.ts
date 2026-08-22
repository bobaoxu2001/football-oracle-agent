import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agent/predict
 * Body: { query: string, isFollowUp?: boolean, contextTeams?: string[], language?: string }
 * Runs the full agent pipeline and returns an AgentResponse.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      query?: string;
      isFollowUp?: boolean;
      contextTeams?: string[];
      language?: string;
    };
    const query = (body.query ?? "").trim();
    if (!query) {
      return NextResponse.json({ error: "Missing 'query'." }, { status: 400 });
    }
    if (query.length > 300) {
      return NextResponse.json({ error: "Query too long." }, { status: 400 });
    }

    // Validate element-wise: the agent resolves these as team names, so a
    // non-string in the array would blow up deep in the pipeline as a 500.
    const contextTeams = Array.isArray(body.contextTeams)
      ? body.contextTeams
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map((t) => t.trim().slice(0, 60))
          .slice(0, 2)
      : undefined;

    const response = await runAgent({
      query,
      isFollowUp: Boolean(body.isFollowUp),
      contextTeams: contextTeams?.length ? contextTeams : undefined,
      language: typeof body.language === "string" ? body.language.slice(0, 20) : undefined,
    });

    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/agent/predict] error:", err);
    return NextResponse.json(
      { error: "The agent hit an unexpected error. Please try again." },
      { status: 500 }
    );
  }
}
