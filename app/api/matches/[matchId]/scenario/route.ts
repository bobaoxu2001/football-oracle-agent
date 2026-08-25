import { NextResponse } from "next/server";
import {
  anonymousRateLimitKey,
  readBoundedJson,
  RequestBodyTooLargeError,
  requestBodyTooLarge,
  takeDurablePublicAiRateLimit,
} from "@/lib/match-forecast/rate-limit";
import { latestMatchForecast, MatchForecastError } from "@/lib/match-forecast/service";
import {
  MatchScenarioBoundaryError,
  parseMatchScenarioOverride,
  runMatchScenario,
} from "@/lib/match-forecast/scenario";
import type { RateLimitResult } from "@/lib/match-forecast/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ScenarioRequestBody {
  forecastId?: unknown;
  override?: unknown;
}

function safeHeaders(rate?: RateLimitResult): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    ...(rate
      ? {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        }
      : {}),
  };
}

function requestObject(value: unknown): value is ScenarioRequestBody {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "forecastId" || key === "override")
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ matchId: string }> }
) {
  if (requestBodyTooLarge(request)) {
    return NextResponse.json(
      { error: "REQUEST_TOO_LARGE", message: "Request body is too large." },
      { status: 413, headers: safeHeaders() }
    );
  }

  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0] ?? null;
  const rate = await takeDurablePublicAiRateLimit(
    "match-scenario",
    anonymousRateLimitKey(forwarded)
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "RATE_LIMITED", message: "Too many scenario requests. Please retry shortly." },
      {
        status: 429,
        headers: {
          ...safeHeaders(rate),
          "Retry-After": String(rate.retryAfterSeconds),
        },
      }
    );
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return NextResponse.json(
      { error: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must use application/json." },
      { status: 415, headers: safeHeaders(rate) }
    );
  }

  try {
    const { matchId } = await params;
    const decoded = await readBoundedJson<unknown>(request);
    if (!requestObject(decoded)) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", message: "Request body must be a JSON object." },
        { status: 400, headers: safeHeaders(rate) }
      );
    }
    const body = decoded;
    if (
      typeof body.forecastId !== "string" ||
      !body.forecastId.trim() ||
      body.forecastId !== body.forecastId.trim() ||
      body.forecastId.length > 1_024
    ) {
      return NextResponse.json(
        { error: "INVALID_FORECAST_ID", message: "Provide an immutable forecast ID." },
        { status: 400, headers: safeHeaders(rate) }
      );
    }
    const override = parseMatchScenarioOverride(body.override);
    if (!override) {
      return NextResponse.json(
        { error: "INVALID_SCENARIO", message: "Provide a bounded deterministic scenario override." },
        { status: 400, headers: safeHeaders(rate) }
      );
    }

    const baseline = await latestMatchForecast(matchId);
    if (body.forecastId !== baseline.provenance.immutableForecastId) {
      return NextResponse.json(
        {
          error: "FORECAST_MISMATCH",
          message: "The scenario baseline is not the selected immutable production forecast.",
        },
        { status: 409, headers: safeHeaders(rate) }
      );
    }

    const result = runMatchScenario({
      baseline,
      matchId,
      forecastId: body.forecastId,
      override,
    });
    return NextResponse.json(result, {
      status: 422,
      headers: {
        ...safeHeaders(rate),
      },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "REQUEST_TOO_LARGE", message: "Request body is too large." },
        { status: 413, headers: safeHeaders(rate) }
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "INVALID_JSON", message: "Request body must be valid JSON." },
        { status: 400, headers: safeHeaders(rate) }
      );
    }
    if (error instanceof MatchScenarioBoundaryError) {
      const status = error.code === "INVALID_OVERRIDE" ? 400 : 409;
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status, headers: safeHeaders(rate) }
      );
    }
    if (error instanceof MatchForecastError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: safeHeaders(rate) }
      );
    }
    console.error("[/api/matches/:matchId/scenario] error:", error);
    return NextResponse.json(
      { error: "SCENARIO_FAILED", message: "Scenario evaluation is temporarily unavailable." },
      { status: 500, headers: safeHeaders(rate) }
    );
  }
}
