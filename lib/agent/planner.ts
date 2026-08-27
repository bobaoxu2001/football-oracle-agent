/**
 * Agent Planner — the agent's "decide what to do" step.
 *
 * Looks at the raw query (and whether this is a follow-up) and classifies the
 * intent, then names the plan of attack the timeline will visualise. Pure
 * heuristics — fast, deterministic, no API needed — so the agent always knows
 * its next move even with zero keys configured.
 */

import { resolveTeams, resolvePlayer } from "./matchResolver";
import { resolveAllClubSlugs } from "@/lib/competitions/premier-league/clubs";
import { looksLikeRulesQuestion } from "./rulesExplain";
import type { AgentIntent } from "./types";
import type { CompetitionId } from "@/lib/competitions/types";

export interface Plan {
  intent: AgentIntent;
  teamSlugs: string[]; // resolved team slugs (0, 1, or 2)
  player?: { player: string; slug: string };
  /** Group letter ("A".."L") when the question names one. */
  group?: string;
  competition: CompetitionId;
  /** Human-readable plan steps shown before execution. */
  planLabels: string[];
}

const CHAMPION_RE =
  /\b(win|lift|champion|champions?hip|trophy|whole thing|tournament|world cup)\b.*\b(2026|world cup|it all|tournament)\b|\b(best chance|most likely to win|who will win the 2026)\b/i;
// Broader tournament-forecast cues (incl. standalone "champion", favorites, 中文).
const TOURNAMENT_RE =
  /\b(world cup|champion|champions|championship|trophy|favou?rites?|win it all|go all the way|tournament winner|top \d+)\b|世界杯|夺冠|冠军|总冠军/i;
const TIKTOK_RE = /\b(tiktok|tik tok|reel|short|social|hype|preview)\b/i;
const SCENARIO_RE =
  /\b(what if|suppose|imagine|without|missing|unavailable|injured|out|suspended|sidelined|if .* (was|were|is|are)\b)/i;
// News-intelligence intent: user wants the latest team news / what changed.
const NEWS_RE =
  /\b(news|latest|updates?|injur(?:y|ies)|suspensions?|concerns?|roster|call[- ]?ups?|squad|locker[- ]?room|conflict|tension|bust[- ]?up|morale|what changed|who replaced|team news|this week)\b/i;
// References to (re)running a prediction — keeps a "does X news change the prediction?" follow-up on the match path.
const PREDICT_REF = /\b(predict|prediction|who (will )?win|odds|chance|affect|change the)\b/i;
// General two-team comparison (not a single match): "compare X and Y", "is X stronger than Y".
const COMPARE_RE =
  /\b(compare|comparison|side[- ]by[- ]side|stronger than|better than|who is stronger)\b|更强|相比|对比|谁更/i;
// Knockout path: "Argentina path to the final", "which opponents could Brazil face?".
const PATH_RE =
  /\b(path|road|route)\s+to\b|\bknockout (path|route)\b|\bpossible opponents\b|\bopponents could\b|路径|晋级之路|通往/i;
// Group qualification: "which teams qualify from Group A?", "can X get out of the group?".
const GROUPQ_RE =
  /\b(qualify|qualification|advance|progress|get (out of|through)|make it out)\b[\s\S]*\bgroup\b|\bgroup\s+[a-l]\b|小组出线|能出线|能不能出线/i;
// Single-team strength question: "is Argentina strong this year?", "how good is Germany?".
const ANALYSIS_RE =
  /\bis\s+[\w\s]+\s(strong|good|any good)\b|\bhow (good|strong) is\b|\bstrengths? (and|&) weakness/i;
const ANALYSIS_ZH_RE = /今年强吗|强不强|实力如何|实力怎么样|怎么样/;
// Model/agent self-explanation: "how does your model work?", "what data do you use?".
const MODEL_RE =
  /\bhow (does|do) (your|the|this) (model|agent|system|prediction)s? work\b|\bwhat data (do you|does (it|the model)) use\b|\bwhy did you (pick|choose)\b|\bhow (is|are) (the )?(probabilit|predictions?)\w* (calculated|computed|made)\b|模型怎么|你的模型|用什么数据|怎么算/i;

/** Extract an explicit group letter ("Group A" … "Group L" / A组). */
function detectGroupLetter(query: string): string | undefined {
  const m = query.match(/\bgroup\s+([a-l])\b/i) || query.match(/([A-La-l])\s*组/);
  return m ? m[1].toUpperCase() : undefined;
}

// Competitions this product does not model. Premier League is IN SCOPE.
// World Cup remains an archived research plugin. Other Big Five leagues stay out
// of Phase 1 on purpose.
const OTHER_COMP_RE =
  /\b(euros?\s*(20\d\d)?|uefa euro|champions league|europa league|la liga|serie a|bundesliga|ligue\s*1|copa am[eé]rica|nations league|club world cup|olympics?|gold cup|afcon)\b/i;
const WC_RE = /world cup|世界杯|ワールドカップ/i;
const PL_RE =
  /\b(premier league|\bepl\b|english premier)\b/i;

export function isPremierLeagueQuery(query: string): boolean {
  return PL_RE.test(query);
}

export function isOutOfScopeCompetition(query: string): boolean {
  if (WC_RE.test(query) || PL_RE.test(query)) return false;
  return OTHER_COMP_RE.test(query);
}

// Match-result language (EN + 中文): "X vs Y", "who wins X against Y",
// "韩国打捷克", "预测…比赛结果", "今晚…比赛". When present, the question is about
// ONE match — it must never fall through to tournament/champion odds, even if
// only one (or neither) team resolves.
const MATCH_LANG_RE =
  /\bvs\.?\b|\bversus\b|\bagainst\b|\bwho (wins|will win)\b|\bmatch (result|prediction)\b|打(?![算入出击折])|对阵|对战|对决|交锋|比赛|谁赢/i;

export function hasMatchLanguage(query: string): boolean {
  return MATCH_LANG_RE.test(query);
}

// Well-known nations that did NOT qualify for the 2026 finals in this model's
// field. Asking "Can Italy win?" must get an honest "not in the field" answer —
// never the generic champion board (which reads as a misleading dodge).
const NON_QUALIFIED: { re: RegExp; en: string; zh: string }[] = [
  { re: /\bitaly\b|意大利|イタリア/i, en: "Italy", zh: "意大利" },
  { re: /\bchina\b|中国|中国队/i, en: "China", zh: "中国队" },
  { re: /\brussia\b|俄罗斯/i, en: "Russia", zh: "俄罗斯" },
  { re: /\bindia\b|印度/i, en: "India", zh: "印度" },
  { re: /\bgreece\b|希腊/i, en: "Greece", zh: "希腊" },
];

export function detectNonQualifiedTeam(query: string): { en: string; zh: string } | null {
  for (const t of NON_QUALIFIED) if (t.re.test(query)) return { en: t.en, zh: t.zh };
  return null;
}

export function planQuery(
  query: string,
  isFollowUp = false,
  hasContextMatchup = false
): Plan {
  const clubs = resolveAllClubSlugs(query);
  const nations = resolveTeams(query);
  const preferPremier =
    isPremierLeagueQuery(query) || (clubs.length >= 2 && !WC_RE.test(query));
  const competition: CompetitionId = preferPremier ? "premier-league" : "world-cup";
  const teamSlugs = preferPremier ? clubs.slice(0, 2) : nations.map((t) => t.slug);
  const player = resolvePlayer(query) ?? undefined;

  const group = detectGroupLetter(query);
  let intent: AgentIntent;

  // Out-of-scope competition → clarification, never World Cup odds in disguise.
  if (isOutOfScopeCompetition(query)) {
    intent = "unknown";
    return {
      intent,
      teamSlugs: [],
      player,
      competition,
      planLabels: ["Detect competition scope", "Redirect to supported questions"],
    };
  }

  // A named non-qualified nation (Italy, China, …) → honest "not in the field"
  // answer, never the generic champion board. World Cup only.
  if (competition === "world-cup" && detectNonQualifiedTeam(query)) {
    intent = "unknown";
    return {
      intent,
      teamSlugs: [],
      player,
      competition,
      planLabels: ["Check the 2026 finals field", "Explain the limitation"],
    };
  }

  // A follow-up that names a what-if scenario re-analyses the prior matchup.
  if (isFollowUp && (SCENARIO_RE.test(query) || player)) {
    intent = "scenario";
  } else if (isFollowUp && hasContextMatchup && PREDICT_REF.test(query) && teamSlugs.length < 2) {
    // "Does the injury news change the prediction?" → re-run the prior matchup
    // (runAgent supplies the two teams from context).
    intent = "match-prediction";
  } else if (MODEL_RE.test(query)) {
    // "How does your model work?" / "你的模型怎么算的？"
    intent = "model-explanation";
  } else if (TIKTOK_RE.test(query) && teamSlugs.length === 2) {
    intent = "tiktok-preview";
  } else if (SCENARIO_RE.test(query) && (teamSlugs.length === 2 || player)) {
    intent = "scenario";
  } else if (COMPARE_RE.test(query) && teamSlugs.length === 2) {
    // "Compare Argentina and France" / "阿根廷和法国谁更强？" — general
    // comparison, not one specific match.
    intent = "team-comparison";
  } else if (teamSlugs.length === 2) {
    intent = "match-prediction";
  } else if (PATH_RE.test(query) && teamSlugs.length === 1) {
    // "Argentina path to the final" / "阿根廷通往决赛的路径是什么？"
    intent = "path-analysis";
  } else if (group || (GROUPQ_RE.test(query) && teamSlugs.length === 1)) {
    // "Which teams qualify from Group A?" / "Can Argentina qualify from the group?"
    intent = "group-qualification";
  } else if (
    NEWS_RE.test(query) &&
    teamSlugs.length === 1 &&
    !(isFollowUp && PREDICT_REF.test(query))
  ) {
    // One team + a news cue → daily team-news digest. (As a follow-up asking
    // whether news changes the prediction, we keep it on the match path.)
    intent = "team-news";
  } else if (looksLikeRulesQuestion(query) && teamSlugs.length < 2) {
    // "How do best third-placed teams advance?" / "黄牌怎么影响小组排名？"
    intent = "rules-explanation";
  } else if (
    (ANALYSIS_RE.test(query) || ANALYSIS_ZH_RE.test(query)) &&
    teamSlugs.length === 1
  ) {
    // "Is Argentina strong this year?" / "阿根廷今年强吗？"
    intent = "team-analysis";
  } else if (hasMatchLanguage(query) && teamSlugs.length < 2 && !TOURNAMENT_RE.test(query)) {
    // Match-result wording but we couldn't resolve BOTH teams ("预测韩国队今晚比赛",
    // unsupported opponent, …) → ask for clarification. NEVER answer a match
    // question with tournament/champion odds.
    intent = "unknown";
  } else if (CHAMPION_RE.test(query) || TOURNAMENT_RE.test(query)) {
    intent = "champion-odds";
  } else if (teamSlugs.length === 1) {
    // One team named, no clear matchup → treat as title-contender question.
    intent = "champion-odds";
  } else {
    intent = "unknown";
  }

  const planLabels = planLabelsFor(intent, competition);
  return { intent, teamSlugs, player, group, competition, planLabels };
}

function planLabelsFor(intent: AgentIntent, competition: CompetitionId = "world-cup"): string[] {
  switch (intent) {
    case "champion-odds":
      return competition === "premier-league"
        ? [
            "Identify Premier League title question",
            "Load walk-forward club Elo (as-of today)",
            "Simulate remaining / full-season table (Dixon-Coles samples)",
            "Rank champion and expected-position odds",
          ]
        : [
            "Identify the question scope (full tournament)",
            "Load all 48 team profiles & Elo ratings",
            "Run 10,000 full-tournament Monte Carlo simulations",
            "Rank contenders & generate the title report",
          ];
    case "scenario":
      return [
        "Detect the scenario change vs the base matchup",
        "Re-weight team strength for the new conditions",
        "Re-run the Monte Carlo simulation",
        "Explain what shifted and why",
      ];
    case "tiktok-preview":
      return [
        "Gather match data & team profiles",
        "Analyze team strength & storylines",
        "Run 10,000-match Monte Carlo simulation",
        "Write a punchy social-ready preview",
      ];
    case "match-prediction":
      return [
        "Gather match data & identify the teams",
        "Pull recent team news (injuries, squad, tactics)",
        "Analyze team strength + news impact",
        "Run 10,000-match Monte Carlo simulation",
        "Generate the news-aware prediction report",
      ];
    case "team-news":
      return [
        "Identify the team",
        "Pull the latest team news",
        "Classify each item (category & impact)",
        "Summarize what it means for the team",
      ];
    case "rules-explanation":
      return [
        "Identify the rules question",
        "Locate the relevant 2026 World Cup rule",
        "Explain it in plain language with examples",
      ];
    case "group-qualification":
      return [
        "Identify the group / team in question",
        "Simulate the group 20,000 times",
        "Rank qualification probabilities",
        "Explain top-2 and best-third routes",
      ];
    case "path-analysis":
      return [
        "Locate the team's group & bracket slots",
        "Read stage-by-stage simulation odds",
        "Map the official Round-of-32 routing",
        "Flag the key risk rounds",
      ];
    case "team-analysis":
      return [
        "Load the team's Elo profile",
        "Derive attack/defense proxies",
        "Check news & discipline signals",
        "Summarize the tournament outlook",
      ];
    case "team-comparison":
      return [
        "Load both teams' Elo profiles",
        "Compare attack, defense & title odds",
        "Compute a neutral-ground matchup",
        "Call the overall edge",
      ];
    case "model-explanation":
      return [
        "Collect the model's dimensions",
        "Explain engine, news & private-storage boundaries",
        "List the known limitations",
      ];
    default:
      return [
        "Parse the question",
        "Look for teams or a tournament-level intent",
        "Decide the best analysis to run",
      ];
  }
}
