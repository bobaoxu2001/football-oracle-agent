/**
 * Explanation Generator — the agent's "explain it like a human" step.
 *
 * Turns the model's numbers into a plain-English "Why?", a punchy fan insight,
 * and an optional TikTok-style script. Always produces strong deterministic
 * prose; if GOOGLE_API_KEY is set, Gemini polishes the same content into a
 * livelier voice. The deterministic path means the demo never depends on an API.
 */

import { geminiGenerate } from "@/lib/llm/gemini";
import type { PredictionBundle, ChampionAnswer } from "./types";

/** Build the deterministic "Why?" explanation from the model bundle. */
export function buildExplanation(b: PredictionBundle): string {
  const { prediction: p, teamA, teamB, simulation: sim } = b;
  const favIsA = p.teamAWinProbability >= p.teamBWinProbability;
  const fav = favIsA ? teamA : teamB;
  const dog = favIsA ? teamB : teamA;
  const favWin = favIsA ? p.teamAWinProbability : p.teamBWinProbability;
  // p.eloA / p.eloB reflect any scenario override, so the prose stays consistent
  // with the adjusted numbers in a what-if re-analysis.
  const favElo = favIsA ? p.eloA : p.eloB;
  const dogElo = favIsA ? p.eloB : p.eloA;
  const eloGap = Math.abs(p.eloA - p.eloB);

  const reasons: string[] = [];
  if (eloGap >= 30)
    reasons.push(
      `${fav.name} carries the higher Elo rating (${favElo} vs ${dogElo}) — a ${eloGap}-point edge in the model's strength scale.`
    );
  else reasons.push(`The two sides are closely matched on Elo (${p.eloA} vs ${p.eloB}).`);

  const hostFactor = p.factors.find((f) => f.label === "Host advantage");
  if (hostFactor) reasons.push(hostFactor.detail);

  reasons.push(
    `The Dixon-Coles goal model projects an expected score of ${p.expectedScore}, with ${p.mostLikelyScoreline} the single most-likely result.`
  );
  reasons.push(
    `Across ${sim.simulationsRun.toLocaleString()} Monte Carlo runs, ${fav.name} won ${(favWin * 100).toFixed(
      0
    )}% of the time — model confidence is ${p.confidenceLevel.toLowerCase()} (${p.confidenceScore}/100).`
  );
  if (p.upsetRisk !== "Low")
    reasons.push(
      `Upset risk is ${p.upsetRisk}: ${dog.name} still win outright in ~${(sim.upsetProbability * 100).toFixed(
        0
      )}% of simulations, so this isn't a lock.`
    );

  const lead =
    favWin >= 0.5
      ? `${fav.name} is favoured to beat ${dog.name}.`
      : `${fav.name} edges ${dog.name} in a tight, high-variance matchup.`;

  return `${lead}\n\n• ${reasons.join("\n• ")}`;
}

/** Punchy one/two-line fan insight (deterministic). */
export function buildFanInsight(b: PredictionBundle): string {
  const { prediction: p, teamA, teamB } = b;
  const favIsA = p.teamAWinProbability >= p.teamBWinProbability;
  const fav = favIsA ? teamA : teamB;
  const dog = favIsA ? teamB : teamA;
  const favWin = favIsA ? p.teamAWinProbability : p.teamBWinProbability;
  const dogWin = favIsA ? p.teamBWinProbability : p.teamAWinProbability;
  const gap = favWin - dogWin;

  if (favWin >= 0.6)
    return `${fav.flag} ${fav.name} should handle this one — ${(favWin * 100).toFixed(
      0
    )}% to win. ${dog.name} need a special day.`;
  if (gap >= 0.15)
    return `${fav.flag} ${fav.name} are the clear pick at ${(favWin * 100).toFixed(0)}%, but ${
      dog.flag
    } ${dog.name} (${(dogWin * 100).toFixed(0)}%) can spring it on the right night.`;
  if (p.drawProbability >= 0.3)
    return `${fav.flag} ${fav.name} vs ${dog.flag} ${dog.name} screams "cagey draw" — ${(
      p.drawProbability * 100
    ).toFixed(0)}% of runs end level. Don't bet the house.`;
  return `Coin-flip energy: ${fav.flag} ${fav.name} ${(favWin * 100).toFixed(0)}% vs ${dog.flag} ${
    dog.name
  } ${(dogWin * 100).toFixed(0)}%. One moment of magic decides it.`;
}

/** Deterministic TikTok-style hype script. */
export function buildTiktokScript(b: PredictionBundle): string {
  const { prediction: p, teamA, teamB, simulation: sim } = b;
  const favIsA = p.teamAWinProbability >= p.teamBWinProbability;
  const fav = favIsA ? teamA : teamB;
  const dog = favIsA ? teamB : teamA;
  const favWin = favIsA ? p.teamAWinProbability : p.teamBWinProbability;

  return [
    `🎬 HOOK: "${teamA.name} vs ${teamB.name} — the AI just ran it 10,000 times. Here's what happened. 👀"`,
    `📊 STAT DROP: "${fav.flag} ${fav.name} wins ${(favWin * 100).toFixed(0)}% of simulations. Most likely score? ${p.mostLikelyScoreline}."`,
    `🔥 SPICE: "${dog.flag} ${dog.name} fans — there's a ${(sim.upsetProbability * 100).toFixed(
      0
    )}% upset lane. It's not over."`,
    `🎯 CTA: "Who you got? Drop it below. 👇 #WorldCup2026 #${teamA.name.replace(/\s/g, "")}vs${teamB.name.replace(
      /\s/g,
      ""
    )}"`,
  ].join("\n");
}

/** Champion-odds explanation (deterministic). */
export function buildChampionExplanation(c: ChampionAnswer): string {
  const top = c.contenders.slice(0, 5);
  const lines = top.map(
    (t, i) => `${i + 1}. ${t.flag} ${t.name} — ${(t.champion * 100).toFixed(1)}% (Elo ${t.elo})`
  );
  return (
    `The World Cup research model ran ${c.simulationsRun.toLocaleString()} full-tournament Monte Carlo simulations — every group, the best-third tiebreaks, and the knockout bracket — and tallied how often each nation lifted the trophy.\n\n` +
    `Top contenders:\n${lines.join("\n")}\n\n` +
    `Favourites are driven by Elo strength and a kinder simulated path; high-variance knockout football keeps the field wide open.`
  );
}

/**
 * Optionally polish a deterministic explanation with Gemini. Returns the
 * original text unchanged if Gemini is not configured or fails.
 */
export async function polishWithGemini(
  deterministic: string,
  context: string
): Promise<{ text: string; enhanced: boolean }> {
  const prompt =
    `You are the Football Oracle World Cup research analyst. ` +
    `Rewrite the analysis below into 2-3 tight, engaging paragraphs for a fan. ` +
    `Keep every number and fact EXACTLY as given — do not invent stats. Be confident and fun, not flowery.\n\n` +
    `Context: ${context}\n\nAnalysis to rewrite:\n${deterministic}`;
  const out = await geminiGenerate(prompt, { maxTokens: 450 });
  if (out && out.length > 40) return { text: out, enhanced: true };
  return { text: deterministic, enhanced: false };
}
