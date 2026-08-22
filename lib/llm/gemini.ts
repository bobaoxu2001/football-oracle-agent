/**
 * Gemini abstraction layer — the agent's optional "narrator".
 *
 * The agent's REASONING and NUMBERS are 100% deterministic (Elo + Dixon-Coles +
 * Monte Carlo). Gemini is used only to polish the explanation into livelier
 * prose when a GOOGLE_API_KEY is present. When it is not — which is the default
 * for the demo — every caller falls back to the deterministic generator and the
 * product works identically. No paid or unavailable API can break the demo.
 *
 * This is the single seam where Google Cloud / Gemini plugs in for the
 * Rapid Agent Hackathon.
 */

import { analystNarrativePrompt, polishPrompt } from "./prompts";

// Model is configurable via env so a deprecated default never silently disables
// Gemini. (gemini-2.0-flash was retired → 404.) Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Endpoint WITHOUT the key. The key goes in the `x-goog-api-key` header
 * (see {@link geminiAuthHeaders}) rather than the query string, so it can
 * never be captured by request logs, proxies, or an error message that echoes
 * the URL it failed on.
 */
const ENDPOINT = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Auth + content headers for a Gemini REST call. */
export function geminiAuthHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-goog-api-key": key };
}

/**
 * The Gemini API key, read from EITHER env var name. Different Google surfaces
 * document it differently (AI Studio → GEMINI_API_KEY, some Cloud docs →
 * GOOGLE_API_KEY), so we accept both rather than silently failing on the "wrong"
 * one. Returns null when neither is set to a plausible key.
 */
export function geminiApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  return key.length > 10 ? key : null;
}

export function geminiConfigured(): boolean {
  return geminiApiKey() !== null;
}

export { MODEL as GEMINI_MODEL, ENDPOINT as geminiEndpoint };

/**
 * Ask Gemini to rewrite/extend a piece of text. Returns null on any failure
 * (no key, network error, bad response) so callers can fall back cleanly.
 * Uses a short timeout so a slow API never stalls the demo.
 */
export async function geminiGenerate(
  prompt: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<string | null> {
  const key = geminiApiKey();
  if (!key) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);

  try {
    const res = await fetch(ENDPOINT(), {
      method: "POST",
      headers: geminiAuthHeaders(key),
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: opts.maxTokens ?? 400,
        },
      }),
    });
    if (!res.ok) {
      // Secret-safe: log status + short body so config issues (invalid key, API
      // not enabled, bad model) are diagnosable in runtime logs. Never logs the key.
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      console.warn(`[gemini] request failed: HTTP ${res.status} ${detail}`);
      return null;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) console.warn("[gemini] response had no text candidate");
    return text?.trim() || null;
  } catch (err) {
    console.warn("[gemini] request error:", (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Gemini analyst narrative from a structured result (the JSON is the only source
 * of truth). Used by the cost-aware router for complex/escalated queries.
 * Returns null on any failure so the router can fall back to DeepSeek.
 */
export async function geminiNarrative(
  structuredJson: string,
  language: "en" | "zh"
): Promise<string | null> {
  if (!geminiConfigured()) return null;
  const out = await geminiGenerate(analystNarrativePrompt(structuredJson, language), {
    maxTokens: 700,
    timeoutMs: 9000,
  });
  return out && out.length > 40 ? out : null;
}

/** Gemini polish of a deterministic English explanation (numbers preserved). */
export async function geminiPolish(
  deterministic: string,
  context: string
): Promise<string | null> {
  if (!geminiConfigured()) return null;
  const out = await geminiGenerate(polishPrompt(deterministic, context), {
    maxTokens: 450,
    timeoutMs: 9000,
  });
  return out && out.length > 40 ? out : null;
}
