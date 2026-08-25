/**
 * Gemini function-calling agent loop — the "Gemini drives the pipeline" mode.
 *
 * The rest of the app uses Gemini/DeepSeek only as a narrator over a fully
 * deterministic result. THIS module is different: it hands Gemini a set of
 * declared TOOLS and lets the model decide which to call, in what order, over a
 * bounded multi-round loop — resolve a team, check who's eliminated, pull team
 * news, run the deterministic match engine — then synthesize a final answer from
 * the tool outputs. It is a genuine agentic tool-use loop, not a single prompt.
 *
 * The critical invariant is unchanged: **every number still comes from the
 * deterministic engine.** The tools return the engine's own probabilities and
 * the live tournament state; Gemini only chooses which tools to call and writes
 * the prose around their JSON outputs. The system instruction forbids inventing
 * probabilities, news, injuries, or eliminations.
 *
 * Fail-soft by construction:
 *   - No Gemini key, or the feature flag is off → runGeminiAgent() returns null
 *     and the caller keeps the existing deterministic pipeline.
 *   - Any transport/parse error, or the model never settles → returns null.
 *   - The transport is injectable, so the whole loop is unit-tested offline with
 *     a scripted fake model (see scripts/test-gemini-agent.ts) — no network, no
 *     key, no cost.
 */

import { predictMatch } from "../prediction-engine/engine";
import { resolveTeams, teamRef } from "../agent/matchResolver";
import { getTeam } from "../seed/world-cup-2026-groups";
import { getNewsForTeam } from "../news/newsIngestor";
import { getTournamentState, isEliminated } from "../live-sports/tournamentState";
import { geminiApiKey, GEMINI_MODEL, geminiAuthHeaders, geminiEndpoint } from "./gemini";

// ── Minimal Gemini REST shapes (only what we use) ────────────────────────────
export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}
export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}
export interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}
export interface GeminiRequest {
  contents: GeminiContent[];
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
}
export interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
}

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/** Injectable transport so the loop is testable without a network or a key. */
export type GeminiTransport = (
  req: GeminiRequest,
  options?: { timeoutMs?: number }
) => Promise<GeminiResponse>;

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  /** Compact human summary of what the tool returned (for the UI timeline). */
  resultSummary: string;
}

export interface GeminiAgentResult {
  text: string;
  toolCalls: ToolCallTrace[];
  rounds: number;
}

// ── Tool declarations handed to Gemini ───────────────────────────────────────
const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "resolve_team",
    description:
      "Resolve a casual team name (e.g. 'USA', 'the Netherlands', 'Türkiye') to a canonical 2026 World Cup team. Call this first when the user names teams informally.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The team name as the user wrote it." } },
      required: ["name"],
    },
  },
  {
    name: "predict_match",
    description:
      "Run the deterministic Elo → Dixon-Coles → Monte Carlo engine for a single fixture and return win/draw/loss probabilities, expected score, confidence and the model's key factors. This is the ONLY source of match probabilities — never estimate them yourself.",
    parameters: {
      type: "object",
      properties: {
        teamA: { type: "string", description: "Canonical slug or name of the first team." },
        teamB: { type: "string", description: "Canonical slug or name of the second team." },
      },
      required: ["teamA", "teamB"],
    },
  },
  {
    name: "get_team_news",
    description:
      "Fetch the latest classified team-news signals (injuries, returns, suspensions, squad/tactics) for one team. Use these only as qualitative context; they never override the engine's numbers.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string", description: "Canonical slug or name of the team." },
        limit: { type: "integer", description: "Max signals to return (default 4)." },
      },
      required: ["team"],
    },
  },
  {
    name: "get_tournament_state",
    description:
      "Return the live tournament state: which teams are already eliminated (deterministic source of truth), the data source and freshness. Use this before claiming a team can still win, to avoid predicting eliminated teams.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_INSTRUCTION = `You are the WorldCup Oracle Agent for the 2026 FIFA World Cup.

You answer football questions by CALLING TOOLS, not by guessing. Rules you must never break:
- All match probabilities, expected scores and confidences come ONLY from predict_match. Never invent or estimate a probability yourself — call the tool and quote its numbers verbatim.
- Never invent injuries, suspensions, news or eliminations. Injuries/news come only from get_team_news; eliminations only from get_tournament_state.
- Resolve informal team names with resolve_team before predicting when unsure.
- Before saying a team "can still win", check get_tournament_state; if it is eliminated, say so plainly.
- When you have enough tool results, STOP calling tools and write a concise, friendly analyst answer (a few sentences). Quote the key probabilities and note any decisive news or elimination.
- Numbers are the engine's; the words are yours.`;

// ── Deterministic tool executor ──────────────────────────────────────────────
function slugFor(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  // Direct slug hit.
  try {
    const t = getTeam(raw.toLowerCase());
    if (t) return t.slug;
  } catch {
    /* not a slug — fall through to fuzzy resolution */
  }
  const found = resolveTeams(raw);
  return found[0]?.slug ?? null;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ response: Record<string, unknown>; summary: string }> {
  switch (name) {
    case "resolve_team": {
      const slug = slugFor(args.name);
      if (!slug) return { response: { resolved: false, query: args.name }, summary: `no team matched "${args.name}"` };
      const t = teamRef(slug);
      const meta = getTeam(slug);
      return {
        response: { resolved: true, slug: t.slug, name: t.name, confederation: meta.confederation, eloRating: Math.round(t.elo) },
        summary: `${args.name} → ${t.name}`,
      };
    }
    case "predict_match": {
      const a = slugFor(args.teamA);
      const b = slugFor(args.teamB);
      if (!a || !b) return { response: { ok: false, error: "could not resolve one or both teams" }, summary: `unresolved: ${args.teamA} / ${args.teamB}` };
      const p = predictMatch(a, b);
      const ta = getTeam(a), tb = getTeam(b);
      const pctA = Math.round(p.teamAWinProbability * 100);
      const pctD = Math.round(p.drawProbability * 100);
      const pctB = Math.round(p.teamBWinProbability * 100);
      return {
        response: {
          ok: true,
          teamA: ta.name,
          teamB: tb.name,
          winProbabilityA: p.teamAWinProbability,
          drawProbability: p.drawProbability,
          winProbabilityB: p.teamBWinProbability,
          expectedScore: p.expectedScore,
          mostLikelyScoreline: p.mostLikelyScoreline,
          confidence: p.confidenceScore,
          confidenceLevel: p.confidenceLevel,
          upsetRisk: p.upsetRisk,
          keyFactors: p.factors.slice(0, 3).map((f) => `${f.label}: ${f.detail}`),
        },
        summary: `${ta.name} ${pctA}% · draw ${pctD}% · ${tb.name} ${pctB}%`,
      };
    }
    case "get_team_news": {
      const slug = slugFor(args.team);
      if (!slug) return { response: { ok: false, error: "unresolved team" }, summary: `unresolved: ${args.team}` };
      const limit = Math.max(1, Math.min(8, Number(args.limit) || 4));
      const { items, source } = await getNewsForTeam(slug, limit);
      const t = getTeam(slug);
      return {
        response: {
          ok: true,
          team: t.name,
          source, // "api" (live) | "demo" (labelled sample)
          signals: items.map((it) => ({
            title: it.title,
            category: it.category,
            impact: it.impactLevel,
            direction: it.direction,
            demo: it.demo,
          })),
        },
        summary: `${items.length} ${source} signal(s) for ${t.name}`,
      };
    }
    case "get_tournament_state": {
      const state = await getTournamentState();
      const eliminated = state.eliminatedSlugs.map((s) => getTeam(s)?.name ?? s);
      return {
        response: {
          ok: true,
          source: state.source,
          mode: state.mode,
          fetchedAt: state.fetchedAt,
          eliminatedCount: state.eliminatedCount,
          eliminatedTeams: eliminated,
        },
        summary: `${state.eliminatedCount} eliminated · ${state.source}`,
      };
    }
    default:
      return { response: { ok: false, error: `unknown tool ${name}` }, summary: `unknown tool ${name}` };
  }
}

// ── Default network transport (real Gemini REST) ─────────────────────────────
const defaultTransport: GeminiTransport = async (req, options) => {
  const key = geminiApiKey();
  if (!key) throw new Error("no gemini key");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 8_000);
  try {
    const res = await fetch(geminiEndpoint(), {
      method: "POST",
      headers: geminiAuthHeaders(key),
      signal: controller.signal,
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    return (await res.json()) as GeminiResponse;
  } finally {
    clearTimeout(timeout);
  }
};

/** Is the function-calling agent loop available (key present + not disabled)? */
export function geminiAgentEnabled(): boolean {
  if (process.env.GEMINI_FUNCTION_CALLING === "0" || process.env.GEMINI_FUNCTION_CALLING === "off") return false;
  return geminiApiKey() !== null;
}

/**
 * Run the bounded Gemini tool-use loop over a natural-language query.
 *
 * @param query    the user's question
 * @param opts.transport  injected model transport (defaults to real Gemini REST)
 * @param opts.maxRounds  max model↔tool round-trips (default 6)
 * @param opts.force      run even if no key is configured (tests supply a transport)
 * @returns the final answer + a trace of the tools Gemini chose, or null on any
 *          failure so the caller falls back to the deterministic pipeline.
 */
export async function runGeminiAgent(
  query: string,
  opts: { transport?: GeminiTransport; maxRounds?: number; maxDurationMs?: number; force?: boolean } = {}
): Promise<GeminiAgentResult | null> {
  const transport = opts.transport ?? defaultTransport;
  const maxRounds = opts.maxRounds ?? 6;
  const deadline = Date.now() + (opts.maxDurationMs ?? 25_000);
  if (!opts.transport && !opts.force && !geminiAgentEnabled()) return null;

  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: query }] }];
  const toolCalls: ToolCallTrace[] = [];

  try {
    for (let round = 1; round <= maxRounds; round++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const req: GeminiRequest = {
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        generationConfig: { temperature: 0.3 },
      };
      const resp = await transport(req, { timeoutMs: Math.min(8_000, remainingMs) });
      const parts = resp.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p): p is Required<Pick<GeminiPart, "functionCall">> & GeminiPart => !!p.functionCall);

      if (calls.length === 0) {
        // Model settled on a text answer.
        const text = parts.map((p) => p.text ?? "").join("").trim();
        if (!text) return null;
        return { text, toolCalls, rounds: round };
      }

      // Record the model's function-call turn verbatim (Gemini requires the
      // matching functionCall/functionResponse pair in the transcript).
      contents.push({ role: "model", parts: calls.map((c) => ({ functionCall: c.functionCall })) });

      const responseParts: GeminiPart[] = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        const { response, summary } = await executeTool(name, args || {});
        toolCalls.push({ name, args: args || {}, resultSummary: summary });
        responseParts.push({ functionResponse: { name, response } });
      }
      contents.push({ role: "function", parts: responseParts });
    }
    // Ran out of rounds without a settled answer.
    return null;
  } catch (err) {
    console.warn("[gemini-agent] loop error:", (err as Error)?.message);
    return null;
  }
}
