import { NextResponse } from "next/server";
import { runMatchAgent } from "@/lib/match-forecast/agent";
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
import { MatchForecastError } from "@/lib/match-forecast/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ matchId: string }> }
) {
  if (requestBodyTooLarge(request)) {
    return NextResponse.json(
      { error: "REQUEST_TOO_LARGE", message: "Request body is too large." },
      { status: 413 }
    );
  }
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  const rate = await takeDurablePublicAiRateLimit("match-agent", anonymousRateLimitKey(forwarded));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many match-agent requests. Please retry shortly." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        },
      }
    );
  }

  try {
    const { matchId } = await params;
    let body: { question?: unknown } = {};
    try {
      body = await readBoundedJson<{ question?: unknown }>(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
    }
    if (typeof body.question !== "string" || !body.question.trim()) {
      return NextResponse.json(
        { error: "INVALID_QUESTION", message: "Provide a non-empty question." },
        { status: 400 }
      );
    }
    const question = body.question.trim();
    if (question.length > 500) {
      return NextResponse.json(
        { error: "QUESTION_TOO_LONG", message: "Question must be 500 characters or fewer." },
        { status: 413 }
      );
    }
    const response = await runAiRequestDeduplicated(
      aiRequestFingerprint("match-agent", { matchId, question: question.toLowerCase() }),
      () => withAiRouteTimeout(runMatchAgent(matchId, question), 22_000)
    );
    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
      },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "REQUEST_TOO_LARGE", message: "Request body is too large." },
        { status: 413 }
      );
    }
    if (error instanceof AiRouteTimeoutError) {
      return NextResponse.json(
        { error: "AGENT_TIMEOUT", message: "The match agent timed out safely." },
        { status: 504 }
      );
    }
    if (error instanceof MatchForecastError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("[/api/matches/:matchId/agent] error:", error);
    return NextResponse.json(
      { error: "AGENT_FAILED", message: "The match agent is temporarily unavailable." },
      { status: 500 }
    );
  }
}
