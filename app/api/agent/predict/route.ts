import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import {
  AiRouteTimeoutError,
  aiRequestFingerprint,
  anonymousRateLimitKey,
  readBoundedJson,
  RequestBodyTooLargeError,
  requestBodyTooLarge,
  runAiRequestDeduplicated,
  takeDurablePublicAiRateLimit,
  withAiRouteTimeout,
} from "@/lib/match-forecast/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/agent/predict
 * Body: { query: string, isFollowUp?: boolean, contextTeams?: string[], language?: string }
 * Runs the full agent pipeline and returns an AgentResponse.
 */
export async function POST(req: Request) {
  if (requestBodyTooLarge(req)) {
    return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  const rate = await takeDurablePublicAiRateLimit("legacy-agent", anonymousRateLimitKey(forwarded), Date.now(), 8);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many agent requests. Please retry shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }
  try {
    type AgentBody = {
      query?: string;
      isFollowUp?: boolean;
      contextTeams?: string[];
      language?: string;
    };
    let body: AgentBody = {};
    try {
      body = await readBoundedJson<AgentBody>(req);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
    }
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

    const input = {
      query,
      isFollowUp: Boolean(body.isFollowUp),
      contextTeams: contextTeams?.length ? contextTeams : undefined,
      language: typeof body.language === "string" ? body.language.slice(0, 20) : undefined,
    };
    const response = await runAiRequestDeduplicated(
      aiRequestFingerprint("legacy-agent", input),
      () => withAiRouteTimeout(runAgent(input), 25_000)
    );

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
      },
    });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    if (err instanceof AiRouteTimeoutError) {
      return NextResponse.json(
        { error: "AGENT_TIMEOUT", message: "The agent timed out safely. Please try again." },
        { status: 504 }
      );
    }
    console.error("[/api/agent/predict] error:", err);
    return NextResponse.json(
      { error: "AGENT_UNAVAILABLE", message: "The agent is temporarily unavailable." },
      { status: 503 }
    );
  }
}
