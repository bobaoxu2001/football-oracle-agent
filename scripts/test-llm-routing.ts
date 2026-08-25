/**
 * Tests for the cost-aware LLM provider router.
 *
 * Run with:  npm run test:routing
 *
 * Verifies the PURE routing decisions (no network calls): DeepSeek is the
 * low-cost default, Gemini is the premium escalation for complex/ambiguous
 * queries, and the chain degrades to deterministic when no key is present.
 * These tests never touch probabilities, rules, or simulations — only which
 * LLM (if any) would write the prose.
 *
 * Exits with code 1 if any assertion fails.
 */

import assert from "node:assert";
import { assessComplexity, selectLLMProvider } from "@/lib/llm/provider";
import { resolveTeams } from "@/lib/agent/matchResolver";
import { planQuery, isOutOfScopeCompetition } from "@/lib/agent/planner";
import { isRelevantTeamNews } from "@/lib/news/newsClassifier";
import { buildTeamNewsDigest } from "@/lib/agent/impactAnalyzer";
import { buildPathAnalysis } from "@/lib/agent/analysis";

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAILED: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
}

// Helpers to simulate which keys are configured (read live by the router).
function setKeys({ deepseek, gemini }: { deepseek: boolean; gemini: boolean }) {
  if (deepseek) {
    process.env.DEEPSEEK_API_KEY = "x".repeat(20);
    process.env.AI_PROVIDER = "deepseek";
  } else {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.AI_PROVIDER;
  }
  if (gemini) process.env.GOOGLE_API_KEY = "x".repeat(20);
  else delete process.env.GOOGLE_API_KEY;
}

console.log("complexity heuristic:");
check("simple English champion is NOT complex", assessComplexity("Who will win the champion?") === false);
check("simple Chinese champion is NOT complex", assessComplexity("谁会赢得世界杯冠军？") === false);
check("team comparison (2 teams) is NOT complex", assessComplexity("Compare Argentina and France", { teamCount: 2, intent: "team-comparison" }) === false);
check("path-analysis intent IS complex", assessComplexity("Argentina's road", { intent: "path-analysis" }) === true);
check("group-qualification intent IS complex", assessComplexity("Group A?", { intent: "group-qualification" }) === true);
check("best third-place wording IS complex", assessComplexity("How do best third-place teams advance and who benefits?") === true);
check("path-to-final wording IS complex", assessComplexity("What is Brazil's path to the final?") === true);
check(">2 teams IS complex", assessComplexity("Argentina vs France vs Spain", { teamCount: 3 }) === true);
check("low confidence IS complex", assessComplexity("hmm", { confidence: 20 }) === true);
check("rules + prediction combined IS complex", assessComplexity("Given the tie-break rules, who wins the group and advances?") === true);
check("team comparison with low win-prob confidence is NOT complex", assessComplexity("Compare Argentina and France", { intent: "team-comparison", teamCount: 2, confidence: 39 }) === false);

console.log("provider selection — both keys present:");
setKeys({ deepseek: true, gemini: true });
check("simple English champion → deepseek", selectLLMProvider({ query: "Who will win the champion?", intent: "champion-odds" }) === "deepseek");
check("simple Chinese champion → deepseek", selectLLMProvider({ query: "谁会赢得世界杯冠军？", intent: "champion-odds", language: "zh-CN" }) === "deepseek");
check("team comparison → deepseek", selectLLMProvider({ query: "Compare Argentina and France", intent: "team-comparison", teamCount: 2 }) === "deepseek");
check("path-to-final → gemini", selectLLMProvider({ query: "Brazil's path to the final?", intent: "path-analysis" }) === "gemini");
check("group qualification → gemini", selectLLMProvider({ query: "Who qualifies from Group A?", intent: "group-qualification" }) === "gemini");
check("best third-place complex → gemini", selectLLMProvider({ query: "How do best third-place teams advance?", intent: "rules-explanation" }) === "gemini");

console.log("provider selection — Gemini key missing (DeepSeek only):");
setKeys({ deepseek: true, gemini: false });
check("complex query falls back to deepseek", selectLLMProvider({ query: "Brazil's path to the final?", intent: "path-analysis" }) === "deepseek");
check("simple query → deepseek", selectLLMProvider({ query: "Who will win the champion?" }) === "deepseek");

console.log("provider selection — DeepSeek key missing (Gemini only):");
setKeys({ deepseek: false, gemini: true });
check("simple query → gemini (only provider)", selectLLMProvider({ query: "Who will win the champion?" }) === "gemini");
check("complex query → gemini", selectLLMProvider({ query: "Brazil's path to the final?", intent: "path-analysis" }) === "gemini");

console.log("provider selection — no keys:");
setKeys({ deepseek: false, gemini: false });
check("simple query → none (deterministic)", selectLLMProvider({ query: "Who will win the champion?" }) === "none");
check("complex query → none (deterministic)", selectLLMProvider({ query: "Brazil's path to the final?", intent: "path-analysis" }) === "none");

console.log("team resolution (FIFA-code stopwords):");
const canQ = resolveTeams("Can Portugal still win the World Cup?");
check('"Can …" does not resolve to Canada', !canQ.some((t) => t.slug === "canada"));
check('"Can Portugal still win…" resolves only Portugal', canQ.length === 1 && canQ[0].slug === "portugal");
const canPlan = planQuery("Can Portugal still win the World Cup?", false, false);
check('"Can Portugal still win…" routes to champion odds, not a match', canPlan.intent === "champion-odds" && canPlan.teamSlugs[0] === "portugal");
check('"Canada vs Portugal" still resolves both teams', resolveTeams("Canada vs Portugal").length === 2);
check('"on par with Morocco in March" resolves only Morocco', resolveTeams("Is Spain on par with Morocco?").every((t) => ["spain", "morocco"].includes(t.slug)));

console.log("news-intent routing (contextual signals):");
check('"Brazil locker room conflict" → team-news', planQuery("Brazil locker room conflict", false, false).intent === "team-news");
check('"Does Portugal have any suspension or injury concerns?" → team-news', planQuery("Does Portugal have any suspension or injury concerns?", false, false).intent === "team-news");
check('"Portugal injury news" → team-news', planQuery("Portugal injury news", false, false).intent === "team-news");
check('"France suspension news" → team-news', planQuery("France suspension news", false, false).intent === "team-news");
check("generic card-rules question (no team) still rules-explanation", planQuery("How do yellow card suspensions work?", false, false).intent === "rules-explanation");

console.log("news relevance gate (no unrelated names as signals):");
check(
  "Ireland women's report mentioning Brazil is rejected for Brazil",
  isRelevantTeamNews("brazil", "Chloe Mustaki: Ireland women fall to defeat against Brazil", "Match report from the friendly in Dublin.") === false
);
check(
  "article not mentioning the team at all is rejected",
  isRelevantTeamNews("brazil", "Premier League roundup: top scorers this weekend", "Club football recap.") === false
);
check(
  "youth-squad article is rejected",
  isRelevantTeamNews("portugal", "Portugal U-21 squad named for qualifiers", "Youth call-ups announced.") === false
);
check(
  "men's national-team article passes",
  isRelevantTeamNews("brazil", "Brazil name squad for World Cup opener", "The seleção confirmed 26 players.") === true
);
check(
  "real Mustaki headline (2027 WWC qualification campaign) is rejected",
  isRelevantTeamNews(
    "brazil",
    "Mustaki's poise and steel strengthening charge for Brazil",
    "Chloe Mustaki's whole career has been a story of resilience, so it's fitting she's been so central to a World Cup qualification campaign defined by a healthy di"
  ) === false
);
check(
  "men's article that also mentions women's tournament passes when men's is explicit",
  isRelevantTeamNews("brazil", "Brazil men's team trains ahead of opener; women's side also in action", "") === true
);
const weakView = {
  team: { slug: "portugal", name: "Portugal", flag: "🇵🇹", elo: 1934 },
  items: [
    { title: "Group K preview", summary: "", category: "other", impactLevel: "low", direction: "neutral", affectedPlayers: [], demo: false },
  ],
  netDirection: "neutral",
  headline: "No major negative signals.",
} as any;
check(
  "weak live batch → digest says no strong signal found",
  buildTeamNewsDigest(weakView, "api").includes("no strong team-specific injury/suspension/conflict signal")
);
check(
  "demo batch → no false 'no strong signal' line (demo is labelled separately)",
  !buildTeamNewsDigest(weakView, "demo").includes("no strong team-specific")
);

console.log("match-language routing (zh + en, never tournament forecast):");
check('"预测一下今晚韩国打捷克比赛的结果" → match-prediction', planQuery("预测一下今晚韩国打捷克比赛的结果", false, false).intent === "match-prediction");
check("…and resolves Korea + Czechia", JSON.stringify(resolveTeams("预测一下今晚韩国打捷克比赛的结果").map((t) => t.slug).sort()) === JSON.stringify(["czech-republic", "south-korea"]));
check('"韩国vs捷克谁赢" → match-prediction', planQuery("韩国vs捷克谁赢", false, false).intent === "match-prediction");
check('"今晚韩国打捷克" → match-prediction', planQuery("今晚韩国打捷克", false, false).intent === "match-prediction");
check('"South Korea vs Czech Republic prediction" → match-prediction', planQuery("South Korea vs Czech Republic prediction", false, false).intent === "match-prediction");
check('"Czechia vs Korea" → match-prediction', planQuery("Czechia vs Korea", false, false).intent === "match-prediction");
check('"预测韩国队今晚比赛" (no opponent) → clarification, not champion odds', planQuery("预测韩国队今晚比赛", false, false).intent === "unknown");
check('"谁会赢得世界杯冠军？" still tournament forecast', planQuery("谁会赢得世界杯冠军？", false, false).intent === "champion-odds");
check('"Can Portugal still win the World Cup?" still champion gating', planQuery("Can Portugal still win the World Cup?", false, false).intent === "champion-odds");
check('"How do best third-place teams advance?" still rules', planQuery("How do best third-place teams advance?", false, false).intent === "rules-explanation");

console.log("mixed-language match resolution (korean vs 捷克):");
const mixedPairs: string[] = [
  "who will win korean vs 捷克？",
  "korean vs 捷克",
  "South Korea vs 捷克",
  "韩国 vs Czech Republic",
  "捷克 vs korean",
  "who will win Korea vs Czech?",
];
for (const q of mixedPairs) {
  const plan = planQuery(q, false, false);
  const slugs = [...plan.teamSlugs].sort().join(",");
  check(
    `${JSON.stringify(q)} → match-prediction with both teams`,
    plan.intent === "match-prediction" && slugs === "czech-republic,south-korea"
  );
}
check(
  '"who will win Korean team?" (no opponent) → clarification, not champion odds',
  planQuery("who will win Korean team?", false, false).intent === "unknown"
);
check(
  '"Canada vs Portugal" still resolves Canada',
  resolveTeams("Canada vs Portugal").map((t) => t.slug).sort().join(",") === "canada,portugal"
);
check(
  '"who will win the World Cup?" still tournament forecast',
  planQuery("who will win the World Cup?", false, false).intent === "champion-odds"
);

console.log("non-qualified team guard (honest answer, no champion board):");
check('"中国队能赢世界杯吗" → clarification, not champion odds', planQuery("中国队能赢世界杯吗", false, false).intent === "unknown");
check('"意大利能赢2026世界杯吗" → clarification', planQuery("意大利能赢2026世界杯吗", false, false).intent === "unknown");
check('"Can Italy win the 2026 World Cup?" → clarification', planQuery("Can Italy win the 2026 World Cup?", false, false).intent === "unknown");
check('"Can Portugal still win the World Cup?" unaffected (qualified team)', planQuery("Can Portugal still win the World Cup?", false, false).intent === "champion-odds");
check('"谁会赢得世界杯冠军？" unaffected', planQuery("谁会赢得世界杯冠军？", false, false).intent === "champion-odds");

console.log("scope guard (other competitions):");
check('"Will Italy win Euro 2024?" is out of scope', isOutOfScopeCompetition("Will Italy win Euro 2024?") === true);
check('"Will Italy win Euro 2024?" plans unknown, not champion odds', planQuery("Will Italy win Euro 2024?", false, false).intent === "unknown");
check("Champions League question is out of scope", isOutOfScopeCompetition("Who wins the Champions League?") === true);
check("World Cup question is IN scope", isOutOfScopeCompetition("Who will win the World Cup?") === false);
check('"Who will win the champion?" stays champion-odds', planQuery("Who will win the champion?", false, false).intent === "champion-odds");

console.log("path-analysis potential path:");
const path = buildPathAnalysis({ slug: "argentina", name: "Argentina", flag: "🇦🇷", elo: 2064 });
check("pathBlock traces to the Final with match numbers", path.pathBlock.includes("Potential path") && path.pathBlock.includes("Final (Match 104)"));
check("pathBlock includes the scenario caveat", path.pathBlock.includes("scenario path, not a fixed bracket"));
check(
  "status line renders in the un-droppable pathBlock when provided",
  buildPathAnalysis({ slug: "argentina", name: "Argentina", flag: "🇦🇷", elo: 2064 }, "active").pathBlock.includes("Current status: **active**")
);

console.log(`\nAll ${passed} routing checks passed.`);
