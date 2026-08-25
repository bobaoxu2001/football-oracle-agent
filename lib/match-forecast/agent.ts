import { createHash } from "node:crypto";
import { polishNarrative, type ActiveProvider } from "@/lib/llm/provider";
import type { MatchForecast, MatchIntelligence } from "./types";
import { getMatchContext } from "./tools";

export type MatchAgentToolName =
  | "get_match_context"
  | "get_match_forecast"
  | "get_score_distribution"
  | "get_market_probabilities"
  | "get_forecast_provenance"
  | "get_team_news"
  | "get_team_availability"
  | "get_probability_history"
  | "compare_forecast_snapshots"
  | "run_supported_scenario";

export interface MatchAgentToolTrace {
  name: MatchAgentToolName;
  source: "deterministic";
  forecastId?: string;
  summary: string;
}

export interface MatchAgentResponse {
  matchId: string;
  answer: string;
  sections: {
    modelFact: string;
    evidence: string;
    interpretation: string;
  };
  numericEvidence: Record<string, number>;
  tools: MatchAgentToolTrace[];
  forecastId: string;
  modelVersion: string;
  cutoffAt: string;
  modelRole: "production";
  narration: {
    mode: "deterministic-template" | "grounded-llm";
    provider: ActiveProvider | null;
    numericGroundingValidated: true;
  };
  privacy: {
    rawPromptPersisted: false;
    publicConversationCreated: false;
  };
}

const answerCache = new Map<string, { expiresAt: number; response: MatchAgentResponse }>();
const CACHE_MS = 60_000;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pp(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function exactScoreProbability(forecast: MatchForecast, home: number, away: number): number | null {
  return forecast.scoreMatrix[home]?.[away] ?? null;
}

function baseTrace(intelligence: MatchIntelligence): MatchAgentToolTrace[] {
  return [
    {
      name: "get_match_context",
      source: "deterministic",
      summary: `${intelligence.match.home.name} vs ${intelligence.match.away.name} at ${intelligence.match.kickoffUtc}`,
    },
    {
      name: "get_match_forecast",
      source: "deterministic",
      forecastId: intelligence.audit.immutableForecastId,
      summary: `production ${intelligence.forecast.modelVersion} frozen at ${intelligence.forecast.cutoffAt}`,
    },
  ];
}

function resultAnswer(intelligence: MatchIntelligence) {
  const forecast = intelligence.forecast;
  const outcomes = [
    { label: forecast.home.name, value: forecast.result.homeWin },
    { label: "Draw", value: forecast.result.draw },
    { label: forecast.away.name, value: forecast.result.awayWin },
  ].sort((a, b) => b.value - a.value);
  return {
    modelFact:
      `${outcomes[0].label} are the production model favorite.\n` +
      `${forecast.home.name}: ${pct(forecast.result.homeWin)}\n` +
      `Draw: ${pct(forecast.result.draw)}\n` +
      `${forecast.away.name}: ${pct(forecast.result.awayWin)}\n` +
      `Expected goals: ${forecast.home.name} ${forecast.expectedGoals.home.toFixed(2)}, ` +
      `${forecast.away.name} ${forecast.expectedGoals.away.toFixed(2)}.`,
    evidence:
      `Frozen production forecast ${forecast.provenance.immutableForecastId}, cutoff ${forecast.cutoffAt}, model ${forecast.modelVersion}.`,
    interpretation:
      `The top-two separation is ${pct(forecast.uncertainty.topTwoSeparation)} (${forecast.uncertainty.separationLabel}). This is a probability ranking, not a guarantee.`,
    numericEvidence: {
      homeWin: forecast.result.homeWin,
      draw: forecast.result.draw,
      awayWin: forecast.result.awayWin,
      expectedHomeGoals: forecast.expectedGoals.home,
      expectedAwayGoals: forecast.expectedGoals.away,
      topTwoSeparation: forecast.uncertainty.topTwoSeparation,
    },
    tools: [] as MatchAgentToolTrace[],
  };
}

function marketAnswer(intelligence: MatchIntelligence, question: string) {
  const forecast = intelligence.forecast;
  const lower = question.toLowerCase();
  const thresholdMatch = lower.match(/([0-4]\.5)/);
  const threshold = thresholdMatch?.[1] ?? "2.5";
  const key = threshold.replace(".", "") as "05" | "15" | "25" | "35" | "45";
  const over = forecast.totals[`over${key}`];
  const under = forecast.totals[`under${key}`];
  const asksUnder = /\bunder\b|小于|低于/.test(lower);
  const selected = asksUnder ? under : over;
  const label = `${asksUnder ? "Under" : "Over"} ${threshold}`;
  return {
    modelFact: `${label}: ${pct(selected)}\nComplement: ${pct(asksUnder ? over : under)}`,
    evidence:
      `Both values are sums of cells in the same frozen 9x9 score matrix (${forecast.provenance.immutableForecastId}).`,
    interpretation:
      `${selected >= 0.5 ? label : asksUnder ? `Over ${threshold}` : `Under ${threshold}`} has the larger model probability.`,
    numericEvidence: { selected, over, under },
    tools: [
      {
        name: "get_market_probabilities" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: `O/U ${threshold} derived from score matrix`,
      },
    ],
  };
}

function bttsAnswer(intelligence: MatchIntelligence) {
  const forecast = intelligence.forecast;
  return {
    modelFact: `Both Teams To Score — Yes: ${pct(forecast.btts.yes)}\nBoth Teams To Score — No: ${pct(forecast.btts.no)}`,
    evidence:
      `BTTS Yes is the sum of frozen score-matrix cells where each team scores at least once.`,
    interpretation:
      `${forecast.btts.yes >= forecast.btts.no ? "Yes" : "No"} is the more likely model outcome.`,
    numericEvidence: { bttsYes: forecast.btts.yes, bttsNo: forecast.btts.no },
    tools: [
      {
        name: "get_market_probabilities" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: "BTTS derived from score matrix",
      },
    ],
  };
}

function scoreAnswer(intelligence: MatchIntelligence, question: string) {
  const forecast = intelligence.forecast;
  const requested = question.match(/\b([0-8])\s*[-–:]\s*([0-8])\b/);
  if (requested) {
    const home = Number(requested[1]);
    const away = Number(requested[2]);
    const probability = exactScoreProbability(forecast, home, away) as number;
    return {
      modelFact: `${forecast.home.name} ${home}-${away} ${forecast.away.name}: ${pct(probability)}`,
      evidence: `This is cell [${home}][${away}] in frozen score matrix ${forecast.provenance.immutableForecastId}.`,
      interpretation: "Exact scores are individually uncertain even when one is the modal outcome.",
      numericEvidence: { exactScore: probability },
      tools: [
        {
          name: "get_score_distribution" as const,
          source: "deterministic" as const,
          forecastId: forecast.provenance.immutableForecastId,
          summary: `score cell ${home}-${away}`,
        },
      ],
    };
  }
  const top = forecast.topScores.slice(0, /top\s*(?:ten|10)|前十/i.test(question) ? 10 : 5);
  return {
    modelFact:
      `Most likely score: ${top[0].homeGoals}-${top[0].awayGoals} (${pct(top[0].probability)})\n` +
      top.map((score) => `${score.homeGoals}-${score.awayGoals}: ${pct(score.probability)}`).join("\n"),
    evidence: `Every score is read directly from frozen score matrix ${forecast.provenance.immutableForecastId}.`,
    interpretation: "The top scoreline is the mode, not a high-certainty prediction.",
    numericEvidence: Object.fromEntries(
      top.map((score) => [`score_${score.homeGoals}_${score.awayGoals}`, score.probability])
    ),
    tools: [
      {
        name: "get_score_distribution" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: `top ${top.length} score cells`,
      },
    ],
  };
}

function expectedGoalsAnswer(intelligence: MatchIntelligence) {
  const forecast = intelligence.forecast;
  return {
    modelFact:
      `${forecast.home.name}: ${forecast.expectedGoals.home.toFixed(2)} expected goals\n` +
      `${forecast.away.name}: ${forecast.expectedGoals.away.toFixed(2)} expected goals\n` +
      `Expected total: ${forecast.expectedGoals.total.toFixed(2)}`,
    evidence:
      `These are the frozen Dixon-Coles goal expectations underlying matrix ${forecast.provenance.immutableForecastId}.`,
    interpretation: "These are model expectations over many hypothetical repetitions, not a predicted final score.",
    numericEvidence: {
      expectedHomeGoals: forecast.expectedGoals.home,
      expectedAwayGoals: forecast.expectedGoals.away,
      expectedTotalGoals: forecast.expectedGoals.total,
    },
    tools: [
      {
        name: "get_match_forecast" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: "frozen goal expectations",
      },
    ],
  };
}

interface ComparableMarket {
  key: string;
  label: string;
  value: number;
  matched: boolean;
}

function comparableMarkets(forecast: MatchForecast, question: string): ComparableMarket[] {
  const q = question.toLowerCase();
  const homeName = forecast.home.name.toLowerCase();
  const awayName = forecast.away.name.toLowerCase();
  const markets: ComparableMarket[] = [
    {
      key: "homeWin",
      label: `${forecast.home.name} win`,
      value: forecast.result.homeWin,
      matched:
        /\bhome\s+win\b/.test(q) ||
        q.includes(`${homeName} win`) ||
        q.includes(`${forecast.home.slug.replace(/-/g, " ")} win`),
    },
    {
      key: "draw",
      label: "Draw",
      value: forecast.result.draw,
      matched: /\bdraw(?![-\s]*no[-\s]*bet)(?: probability| chance)?\b/.test(q),
    },
    {
      key: "awayWin",
      label: `${forecast.away.name} win`,
      value: forecast.result.awayWin,
      matched:
        /\baway\s+win\b/.test(q) ||
        q.includes(`${awayName} win`) ||
        q.includes(`${forecast.away.slug.replace(/-/g, " ")} win`),
    },
    {
      key: "bttsYes",
      label: "BTTS Yes",
      value: forecast.btts.yes,
      matched: /btts\s*(?:yes)?|both teams.*score|双方.*进球/.test(q),
    },
    {
      key: "homeDnb",
      label: `${forecast.home.name} Draw No Bet`,
      value: forecast.drawNoBet.home,
      matched:
        /home\s*(?:draw[-\s]*)?no[-\s]*bet|home\s*dnb/.test(q) ||
        (/(?:draw[-\s]*no[-\s]*bet|dnb)/.test(q) && !q.includes(awayName) && !/\baway\b/.test(q)),
    },
    {
      key: "awayDnb",
      label: `${forecast.away.name} Draw No Bet`,
      value: forecast.drawNoBet.away,
      matched:
        /away\s*(?:draw[-\s]*)?no[-\s]*bet|away\s*dnb/.test(q) ||
        (/(?:draw[-\s]*no[-\s]*bet|dnb)/.test(q) && (q.includes(awayName) || /\baway\b/.test(q))),
    },
    {
      key: "oneX",
      label: `1X (${forecast.home.name} or draw)`,
      value: forecast.doubleChance.homeOrDraw,
      matched: /\b1x\b|home\s+or\s+draw/.test(q),
    },
    {
      key: "twelve",
      label: `12 (${forecast.home.name} or ${forecast.away.name})`,
      value: forecast.doubleChance.homeOrAway,
      matched: /\b12\b|home\s+or\s+away/.test(q),
    },
    {
      key: "xTwo",
      label: `X2 (draw or ${forecast.away.name})`,
      value: forecast.doubleChance.drawOrAway,
      matched: /\bx2\b|draw\s+or\s+away/.test(q),
    },
  ];
  for (const threshold of ["0.5", "1.5", "2.5", "3.5", "4.5"] as const) {
    const key = threshold.replace(".", "") as "05" | "15" | "25" | "35" | "45";
    markets.push(
      {
        key: `over${key}`,
        label: `Over ${threshold}`,
        value: forecast.totals[`over${key}`],
        matched: new RegExp(`\\bover\\s*${threshold.replace(".", "\\.")}`).test(q),
      },
      {
        key: `under${key}`,
        label: `Under ${threshold}`,
        value: forecast.totals[`under${key}`],
        matched: new RegExp(`\\bunder\\s*${threshold.replace(".", "\\.")}`).test(q),
      }
    );
  }
  return markets;
}

function comparisonAnswer(intelligence: MatchIntelligence, question: string) {
  const forecast = intelligence.forecast;
  const matched = comparableMarkets(forecast, question).filter((market) => market.matched);
  if (matched.length < 2) return null;
  const [first, second] = matched;
  const higher = first.value >= second.value ? first : second;
  const lower = higher === first ? second : first;
  const difference = higher.value - lower.value;
  return {
    modelFact:
      `${first.label}: ${pct(first.value)}\n` +
      `${second.label}: ${pct(second.value)}\n` +
      `Difference: ${(difference * 100).toFixed(1)} percentage points.`,
    evidence:
      `Both probabilities are deterministic derivations from frozen score matrix ${forecast.provenance.immutableForecastId}.`,
    interpretation:
      difference < 0.03
        ? `${higher.label} is only slightly higher; the two outcomes should be treated as similarly likely.`
        : `${higher.label} has the higher model probability.`,
    numericEvidence: {
      [first.key]: first.value,
      [second.key]: second.value,
      difference,
    },
    tools: [
      {
        name: "get_market_probabilities" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: `${first.label} vs ${second.label}`,
      },
    ],
  };
}

function dnbOrDoubleChanceAnswer(intelligence: MatchIntelligence, question: string) {
  const forecast = intelligence.forecast;
  const matched = comparableMarkets(forecast, question).filter(
    (market) => market.matched && ["homeDnb", "awayDnb", "oneX", "twelve", "xTwo"].includes(market.key)
  );
  if (!matched.length) return null;
  const market = matched[0];
  return {
    modelFact: `${market.label}: ${pct(market.value)}`,
    evidence:
      market.key.endsWith("Dnb")
        ? `Draw No Bet is the conditional 1X2 probability after removing draw mass from ${forecast.provenance.immutableForecastId}.`
        : `Double Chance is the sum of the corresponding 1X2 cells from ${forecast.provenance.immutableForecastId}.`,
    interpretation: "This is a derived probability, not a separate classifier or market-odds input.",
    numericEvidence: { [market.key]: market.value },
    tools: [
      {
        name: "get_market_probabilities" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: market.label,
      },
    ],
  };
}

function teamTotalAnswer(intelligence: MatchIntelligence, question: string) {
  const forecast = intelligence.forecast;
  const lower = question.toLowerCase();
  if (!/team\s+total|team.*over|team.*under|球队.*进球/.test(lower)) return null;
  const away = /\baway\b/.test(lower) || lower.includes(forecast.away.name.toLowerCase());
  const side = away ? "away" : "home";
  const team = away ? forecast.away.name : forecast.home.name;
  const threshold = lower.match(/([0-2]\.5)/)?.[1] ?? "1.5";
  const key = threshold.replace(".", "") as "05" | "15" | "25";
  const under = /\bunder\b|小于|低于/.test(lower);
  const probability = forecast.teamTotals[side][`${under ? "under" : "over"}${key}`];
  return {
    modelFact: `${team} team total ${under ? "Under" : "Over"} ${threshold}: ${pct(probability)}`,
    evidence: `This is the sum of score-matrix cells for ${team}'s goal count in ${forecast.provenance.immutableForecastId}.`,
    interpretation: "It is derived from the same score distribution as 1X2, BTTS and match totals.",
    numericEvidence: { teamTotal: probability },
    tools: [
      {
        name: "get_market_probabilities" as const,
        source: "deterministic" as const,
        forecastId: forecast.provenance.immutableForecastId,
        summary: `${team} team total ${under ? "Under" : "Over"} ${threshold}`,
      },
    ],
  };
}

function historyAnswer(intelligence: MatchIntelligence) {
  const comparison = intelligence.comparison;
  if (!comparison) {
    return {
      modelFact: "Only one immutable production snapshot is available for this match, so no verified change can be calculated.",
      evidence: `Available forecast: ${intelligence.forecast.provenance.immutableForecastId}.`,
      interpretation: "The agent will not infer a timeline from mutable current state.",
      numericEvidence: {},
      tools: [
        {
          name: "get_probability_history" as const,
          source: "deterministic" as const,
          forecastId: intelligence.audit.immutableForecastId,
          summary: "one production snapshot",
        },
      ],
    };
  }
  const changes = comparison.probabilityChanges;
  return {
    modelFact:
      `From ${comparison.fromCutoff} to ${comparison.toCutoff}:\n` +
      `${intelligence.match.home.name} win: ${pp(changes.homeWin)}\n` +
      `Draw: ${pp(changes.draw)}\n` +
      `${intelligence.match.away.name} win: ${pp(changes.awayWin)}\n` +
      `Over 2.5: ${pp(changes.over25)}.`,
    evidence:
      `${comparison.inputChanges.length} auditable input field(s) changed between the two immutable production snapshots.`,
    interpretation: comparison.causalNote,
    numericEvidence: { ...changes },
    tools: [
      {
        name: "get_probability_history" as const,
        source: "deterministic" as const,
        forecastId: intelligence.audit.immutableForecastId,
        summary: `${intelligence.timeline.length} production snapshots`,
      },
      {
        name: "compare_forecast_snapshots" as const,
        source: "deterministic" as const,
        forecastId: intelligence.audit.immutableForecastId,
        summary: `${comparison.fromCutoff} → ${comparison.toCutoff}`,
      },
    ],
  };
}

function auditAnswer(intelligence: MatchIntelligence) {
  const audit = intelligence.audit;
  return {
    modelFact:
      `Production model: ${audit.modelVersion}\n` +
      `Forecast cutoff: ${audit.cutoffAt}\n` +
      `Immutable forecast: ${audit.immutableForecastId}\n` +
      `Score distribution: ${audit.scoreDistributionArtifact}`,
    evidence:
      `Inputs: ${audit.inputsUsed.join("; ")}. Training window: ${audit.trainingWindow ? `${audit.trainingWindow.from} to ${audit.trainingWindow.to}` : "not recorded"}.`,
    interpretation:
      audit.reconstructionNote ?? "The displayed matrix is the complete probability artifact frozen with the forecast.",
    numericEvidence: {},
    tools: [
      {
        name: "get_forecast_provenance" as const,
        source: "deterministic" as const,
        forecastId: audit.immutableForecastId,
        summary: `${audit.modelVersion} / ${audit.scoreDistributionArtifact}`,
      },
    ],
  };
}

function whyAnswer(intelligence: MatchIntelligence) {
  const base = resultAnswer(intelligence);
  const source = intelligence.audit.inputSnapshots;
  const eloHome = typeof source.eloHome === "number" ? source.eloHome.toFixed(1) : "recorded in snapshot";
  const eloAway = typeof source.eloAway === "number" ? source.eloAway.toFixed(1) : "recorded in snapshot";
  return {
    ...base,
    evidence:
      `Approved pre-cutoff inputs: home Elo ${eloHome}, away Elo ${eloAway}, true home advantage, frozen Dixon-Coles rho, and the frozen goal mapping. Current news, current tactical profiles, market odds, and shadow outputs are not production inputs.`,
    interpretation:
      "The explanation identifies inputs and model mechanics. It does not claim that one factor caused the full probability difference.",
    tools: [
      {
        name: "get_forecast_provenance" as const,
        source: "deterministic" as const,
        forecastId: intelligence.audit.immutableForecastId,
        summary: "approved production inputs",
      },
      {
        name: "get_team_news" as const,
        source: "deterministic" as const,
        summary: `${intelligence.context.news.length} pre-cutoff contextual item(s), none used in forecast`,
      },
    ],
  };
}

function scenarioAnswer(intelligence: MatchIntelligence) {
  return {
    modelFact: "The current Premier League production model does not support player-level or arbitrary lineup counterfactual probabilities.",
    evidence:
      `Baseline production forecast remains ${intelligence.audit.immutableForecastId}; it has not been manually adjusted.`,
    interpretation: "No scenario probability is returned because there is no legitimate deterministic player-impact mechanism in this model version.",
    numericEvidence: {},
    tools: [
      {
        name: "run_supported_scenario" as const,
        source: "deterministic" as const,
        forecastId: intelligence.audit.immutableForecastId,
        summary: "unsupported scenario refused",
      },
    ],
  };
}

function chooseAnswer(intelligence: MatchIntelligence, question: string) {
  const lower = question.toLowerCase();
  if (/what if|scenario|unavailable|ruled out|rotat|lineup|如果|缺阵|轮换|首发/.test(lower)) {
    return scenarioAnswer(intelligence);
  }
  if (/what changed|since yesterday|moved from|history|timeline|变化|昨天|历史/.test(lower)) {
    return historyAnswer(intelligence);
  }
  if (/audit|provenance|where.*come from|trace|审计|来源|追溯/.test(lower)) {
    return auditAnswer(intelligence);
  }
  if (/why|explain|为什么|解释/.test(lower)) return whyAnswer(intelligence);
  const comparison = comparisonAnswer(intelligence, question);
  if (comparison) return comparison;
  if (/scoreline|exact score|most likely score|top\s*(?:five|5|ten|10)|比分|最可能.*比分|\b[0-8]\s*[-–:]\s*[0-8]\b/.test(lower)) {
    return scoreAnswer(intelligence, question);
  }
  if (/both teams|btts|双方.*进球/.test(lower)) return bttsAnswer(intelligence);
  if (/expected.*goal|total goals|进球期望|预期进球/.test(lower)) return expectedGoalsAnswer(intelligence);
  const teamTotal = teamTotalAnswer(intelligence, question);
  if (teamTotal) return teamTotal;
  const derivedMarket = dnbOrDoubleChanceAnswer(intelligence, question);
  if (derivedMarket) return derivedMarket;
  if (/\bover\b|\bunder\b|大于|小于|高于|低于/.test(lower)) return marketAnswer(intelligence, question);
  return resultAnswer(intelligence);
}

const TOKEN_NAMES = [
  "ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL",
  "INDIA", "JULIET", "KILO", "LIMA", "MIKE", "NOVEMBER", "OSCAR", "PAPA",
  "QUEBEC", "ROMEO", "SIERRA", "TANGO", "UNIFORM", "VICTOR", "WHISKEY", "XRAY",
  "YANKEE", "ZULU",
];

function maskNumericLines(text: string): { masked: string; facts: Map<string, string> } | null {
  const facts = new Map<string, string>();
  let index = 0;
  const lines = text.split("\n").map((line) => {
    if (!/\d/.test(line)) return line;
    const name = TOKEN_NAMES[index];
    if (!name) return line;
    const token = `⟦FACT_${name}⟧`;
    facts.set(token, line);
    index += 1;
    return token;
  });
  if (lines.some((line) => /\d/.test(line))) return null;
  return { masked: lines.join("\n"), facts };
}

async function groundedNarration(
  deterministic: string,
  question: string
): Promise<{ text: string; provider: ActiveProvider | null }> {
  if (process.env.MATCH_AGENT_LLM_ENABLED === "0") {
    return { text: deterministic, provider: null };
  }
  if (!/why|explain|what changed|compare|为什么|解释|变化|比较/i.test(question)) {
    return { text: deterministic, provider: null };
  }
  const masked = maskNumericLines(deterministic);
  if (!masked || masked.facts.size === 0) return { text: deterministic, provider: null };
  const polished = await polishNarrative(
    masked.masked,
    "Football match analysis. Preserve every opaque FACT token exactly once. Do not add numeric claims.",
    { query: question, intent: "match-intelligence" }
  );
  if (!polished.provider || polished.text.length > 4_000) {
    return { text: deterministic, provider: null };
  }
  let residue = polished.text;
  for (const token of masked.facts.keys()) {
    const count = residue.split(token).length - 1;
    if (count !== 1) return { text: deterministic, provider: null };
    residue = residue.replace(token, "");
  }
  const numberWords = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|half|double|twice|hundred)\b|[零一二三四五六七八九十百千万半两]/i;
  if (/\d/.test(residue) || numberWords.test(residue)) {
    return { text: deterministic, provider: null };
  }
  let text = polished.text;
  for (const [token, fact] of masked.facts) text = text.replace(token, fact);
  return { text, provider: polished.provider };
}

function cacheKey(matchId: string, question: string, forecastId: string): string {
  return createHash("sha256")
    .update(`${matchId}\n${forecastId}\n${question.trim().toLowerCase()}`)
    .digest("hex");
}

export async function runMatchAgent(matchId: string, question: string): Promise<MatchAgentResponse> {
  // Resolve the match and establish one immutable tool context before intent
  // handling. Every subsequent numeric answer reads this same context.
  const { intelligence } = await getMatchContext(matchId);
  const key = cacheKey(matchId, question, intelligence.audit.immutableForecastId);
  const cached = answerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.response);

  const chosen = chooseAnswer(intelligence, question);
  const sections = {
    modelFact: chosen.modelFact,
    evidence: chosen.evidence,
    interpretation: chosen.interpretation,
  };
  const deterministic =
    `Model fact\n${sections.modelFact}\n\n` +
    `Evidence\n${sections.evidence}\n\n` +
    `Interpretation\n${sections.interpretation}`;
  const narration = await groundedNarration(deterministic, question);
  const response: MatchAgentResponse = {
    matchId,
    answer: narration.text,
    sections,
    numericEvidence: chosen.numericEvidence,
    tools: [...baseTrace(intelligence), ...chosen.tools],
    forecastId: intelligence.audit.immutableForecastId,
    modelVersion: intelligence.forecast.modelVersion,
    cutoffAt: intelligence.forecast.cutoffAt,
    modelRole: "production",
    narration: {
      mode: narration.provider ? "grounded-llm" : "deterministic-template",
      provider: narration.provider,
      numericGroundingValidated: true,
    },
    privacy: {
      rawPromptPersisted: false,
      publicConversationCreated: false,
    },
  };
  answerCache.set(key, { expiresAt: Date.now() + CACHE_MS, response });
  if (answerCache.size > 100) {
    const oldest = answerCache.keys().next().value;
    if (oldest) answerCache.delete(oldest);
  }
  return structuredClone(response);
}

export function clearMatchAgentCacheForTests(): void {
  answerCache.clear();
}
