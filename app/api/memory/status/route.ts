import { NextResponse } from "next/server";
import { countPredictions, mongoConnected } from "@/lib/db/mongodb";
import { getNewsStats, newsMode } from "@/lib/news/newsIngestor";
import { llmConfigured } from "@/lib/llm/provider";
import { geminiConfigured } from "@/lib/llm/gemini";
import { geminiAgentEnabled } from "@/lib/llm/geminiAgent";
import { getTournamentState, liveProviderConfigured } from "@/lib/live-sports/tournamentState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/memory/status
 * Compatibility endpoint for private storage and archived research-data status:
 * backend, news mode/provider, counts, and last update.
 * Always succeeds.
 */
export async function GET() {
  try {
    const [connected, preds, newsStats, tState] = await Promise.all([
      mongoConnected(),
      countPredictions(),
      getNewsStats(),
      getTournamentState(),
    ]);
    const mode = newsMode();
    return NextResponse.json({
      mongo: {
        configured: Boolean(process.env.MONGODB_URI),
        connected,
        backend: connected ? "MongoDB Atlas" : "In-memory fallback",
      },
      predictions: { total: preds.total, source: preds.source },
      teamNews: {
        total: newsStats.total,
        source: newsStats.source,
        lastUpdate: newsStats.lastUpdate,
        mode: mode.mode, // "api" | "demo"
        provider: mode.provider, // e.g. "GNews" | null
      },
      // Cost-aware LLM router config (booleans only — never any key/value).
      llm: {
        deepseek: llmConfigured(), // low-cost default
        gemini: geminiConfigured(), // premium escalation + fallback
        defaultProvider: llmConfigured() ? "deepseek" : geminiConfigured() ? "gemini" : "none",
        // Gemini function-calling agent loop (lib/llm/geminiAgent.ts): when a
        // Gemini key is present, Gemini can drive the pipeline by choosing which
        // deterministic tools to call. Off (deterministic pipeline) otherwise.
        geminiFunctionCalling: geminiAgentEnabled(),
      },
      // Live tournament state (deterministic elimination source of truth).
      tournamentState: {
        configured: liveProviderConfigured(),
        mode: tState.mode, // "live" | "cache" | "demo" | "unavailable"
        source: tState.source,
        fetchedAt: tState.fetchedAt,
        eliminatedCount: tState.eliminatedCount,
      },
    });
  } catch (err) {
    console.error("[/api/memory/status] error:", err);
    return NextResponse.json(
      {
        mongo: { configured: false, connected: false, backend: "In-memory fallback" },
        predictions: { total: 0, source: "memory" },
        teamNews: { total: 0, source: "memory", lastUpdate: null, mode: "demo", provider: null },
      },
      { status: 200 }
    );
  }
}
