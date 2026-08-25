/**
 * Prompt builders for the optional LLM layer.
 *
 * Three uses, all strictly bounded:
 *   1. Intent classification → strict JSON labels only.
 *   2. Analyst narrative → prose grounded ONLY in a structured result the
 *      deterministic engine produced (numbers must be copied, never invented).
 *   3. Clarification → a short helpful redirect listing supported questions.
 */

import type { ChatMessage } from "./types";
import { LLM_INTENT_TYPES } from "./types";

export { LLM_INTENT_TYPES } from "./types";
export type { LlmIntentType, LlmIntentResult } from "./types";

export function intentClassificationMessages(
  query: string,
  deterministicGuess: string
): ChatMessage[] {
  const system =
    `You are an intent classifier for a FIFA World Cup 2026 prediction agent. ` +
    `Classify the user's question. Respond with STRICT JSON ONLY, no prose, matching:\n` +
    `{"intentType": one of [${LLM_INTENT_TYPES.join(", ")}], ` +
    `"language": "en" or "zh", "teams": [national team names in English, may be empty], ` +
    `"group": "A".."L" or null, "stage": tournament stage or null, ` +
    `"confidence": number 0..1, "reason": "short reason"}\n\n` +
    `Definitions:\n` +
    `- MATCH_PREDICTION: who wins a specific two-team match ("Argentina vs Germany").\n` +
    `- TOURNAMENT_FORECAST: who wins the whole tournament / champion / top favourites.\n` +
    `- GROUP_QUALIFICATION: who qualifies from a group / can team X get out of its group / third-place advancement for a SPECIFIC group or team.\n` +
    `- PATH_ANALYSIS: a team's likely route through the knockout rounds ("path to the final").\n` +
    `- TEAM_ANALYSIS: how good is ONE team (strength, weaknesses, outlook).\n` +
    `- TEAM_COMPARISON: compare two teams in general (not one specific match).\n` +
    `- NEWS_OR_INJURY: latest team news / injuries / suspensions.\n` +
    `- RULES_EXPLANATION: how tournament rules work (tie-breakers, third-place rule, cards, format).\n` +
    `- MODEL_EXPLANATION: how this prediction model/agent itself works.\n` +
    `- CLARIFICATION: unclear or unsupported.\n\n` +
    `IMPORTANT: You ONLY classify. Do NOT predict scores or probabilities, do NOT state any ` +
    `news, injuries, or suspensions, and do NOT invent facts. Output JSON only.`;

  const user =
    `Question: """${query}"""\n` +
    `A heuristic parser guessed: "${deterministicGuess}". ` +
    `Use it only as a weak hint; decide yourself. Return the JSON now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Analyst narrative: rewrite a structured, deterministic result as readable
 * analysis. The structured JSON is the ONLY source of truth.
 */
export function analystNarrativeMessages(
  structuredJson: string,
  language: "en" | "zh"
): ChatMessage[] {
  const langName = language === "zh" ? "Simplified Chinese (简体中文)" : "English";
  const system =
    `You are a careful football analyst for a FIFA World Cup 2026 forecasting agent. ` +
    `You will receive a structured JSON result produced by a deterministic statistical engine ` +
    `(Elo + Dixon-Coles + Monte Carlo). Write a concise, engaging analysis in ${langName}.\n\n` +
    `HARD RULES:\n` +
    `1. The JSON is the ONLY source of truth. Use ONLY numbers, rankings, factors and news items present in it — copy them exactly; never invent, change, or round differently.\n` +
    `2. Do NOT invent injuries, news, suspensions, sources, or real-time facts.\n` +
    `3. If the JSON marks data as demo/sample, say so plainly.\n` +
    `4. Mention the listed limitations briefly at the end.\n` +
    `5. 2-4 short paragraphs or tight bullet lists. No preamble, no JSON, no headings longer than a few words.`;
  const user = `Structured result:\n${structuredJson}\n\nWrite the analysis now in ${langName}.`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Single-string version of the analyst-narrative prompt, for providers with a
 * single-prompt API (e.g. Gemini). Same hard rules as the chat-message form.
 */
export function analystNarrativePrompt(structuredJson: string, language: "en" | "zh"): string {
  return analystNarrativeMessages(structuredJson, language)
    .map((m) => m.content)
    .join("\n\n");
}

const POLISH_SYSTEM =
  `You are the Football Oracle World Cup research analyst. ` +
  `Rewrite the analysis below into 2-3 tight, engaging paragraphs for a fan. ` +
  `Keep every number and fact EXACTLY as given — do not invent stats. Be confident and fun, not flowery.`;

/** Polish a deterministic explanation (chat-message form, e.g. DeepSeek). */
export function polishMessages(deterministic: string, context: string): ChatMessage[] {
  return [
    { role: "system", content: POLISH_SYSTEM },
    { role: "user", content: `Context: ${context}\n\nAnalysis to rewrite:\n${deterministic}` },
  ];
}

/** Polish a deterministic explanation (single-string form, e.g. Gemini). */
export function polishPrompt(deterministic: string, context: string): string {
  return polishMessages(deterministic, context)
    .map((m) => m.content)
    .join("\n\n");
}

/** Clarification: friendly redirect for unclear queries. */
export function clarificationMessages(
  query: string,
  supportedExamples: string[],
  language: "en" | "zh"
): ChatMessage[] {
  const langName = language === "zh" ? "Simplified Chinese" : "English";
  const system =
    `You are a FIFA World Cup 2026 prediction agent. The user's question could not be matched ` +
    `to a supported analysis. In ${langName}, write 1-2 friendly sentences acknowledging the ` +
    `question, then list the example questions you were given VERBATIM as suggestions. ` +
    `Do NOT answer the original question, do NOT predict anything, do NOT invent capabilities.`;
  const user = `User question: """${query}"""\nSupported examples:\n- ${supportedExamples.join("\n- ")}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Translation that must preserve every number/team name exactly. */
export function translationMessages(text: string, targetLanguage: string): ChatMessage[] {
  const system =
    `You are a precise translator for football analytics content. Translate the user's text into ` +
    `${targetLanguage}. Keep EVERY number, percentage, score and team name EXACTLY as written — ` +
    `do not change, round, or localize digits or team names. Preserve line breaks and **bold** ` +
    `markers. Return ONLY the translation.`;
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}
