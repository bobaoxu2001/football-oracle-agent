import { NextResponse } from "next/server";
import { runGeminiAgent, geminiAgentEnabled } from "@/lib/llm/geminiAgent";
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
 * POST /api/agent/gemini-tools   { "query": "Will the USA beat Argentina?" }
 *
 * Runs the Gemini function-calling agent loop: Gemini chooses which
 * deterministic tools to call (resolve_team, predict_match, get_team_news,
 * get_tournament_state), and we execute them and feed the results back until it
 * settles on an answer. The response includes the tool-call trace so the agentic
 * loop is inspectable.
 *
 * Fail-soft: returns HTTP 200 with `available:false` when no Gemini key is
 * configured (the rest of the app runs on the deterministic pipeline), so this
 * endpoint never errors the demo.
 */
export async function POST(req: Request) {
  if (requestBodyTooLarge(req)) {
    return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  const rate = await takeDurablePublicAiRateLimit("gemini-tools", anonymousRateLimitKey(forwarded), Date.now(), 6);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many Gemini agent requests. Please retry shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }
  if (!geminiAgentEnabled()) {
    return NextResponse.json({
      available: false,
      reason: "No Gemini API key configured — the app runs on the deterministic pipeline.",
    });
  }

  let query = "";
  try {
    const body = await readBoundedJson<{ query?: unknown }>(req);
    if (typeof body.query === "string") query = body.query.trim();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    /* empty/invalid body handled below */
  }
  if (!query) {
    return NextResponse.json({ available: true, error: "Provide a non-empty `query`." }, { status: 400 });
  }
  if (query.length > 300) {
    return NextResponse.json({ available: true, error: "Query must be 300 characters or fewer." }, { status: 413 });
  }

  let result;
  try {
    result = await runAiRequestDeduplicated(
      aiRequestFingerprint("gemini-tools", { query }),
      () => withAiRouteTimeout(runGeminiAgent(query, { maxRounds: 4, maxDurationMs: 18_000 }), 20_000)
    );
  } catch (error) {
    if (error instanceof AiRouteTimeoutError) {
      return NextResponse.json(
        { available: true, settled: false, error: "AGENT_TIMEOUT" },
        { status: 504 }
      );
    }
    console.error("[/api/agent/gemini-tools] error:", error);
    return NextResponse.json(
      { available: true, settled: false, error: "PROVIDER_UNAVAILABLE" },
      { status: 503 }
    );
  }
  if (!result) {
    return NextResponse.json({
      available: true,
      settled: false,
      note: "Gemini did not settle on an answer; the app would fall back to the deterministic pipeline.",
    });
  }

  return NextResponse.json(
    {
      available: true,
      settled: true,
      query,
      answer: result.text,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
      },
    }
  );
}
