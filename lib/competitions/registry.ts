import type { CompetitionConfig, CompetitionId } from "./types";
import { WORLD_CUP_CONFIG } from "./world-cup/config";
import { PREMIER_LEAGUE_CONFIG } from "./premier-league/config";

const REGISTRY: Record<CompetitionId, CompetitionConfig> = {
  "world-cup": WORLD_CUP_CONFIG,
  "premier-league": PREMIER_LEAGUE_CONFIG,
};

/** Default product competition for football-oracle-agent Phase 1. */
export const DEFAULT_COMPETITION_ID: CompetitionId = "premier-league";

export function getCompetition(id: CompetitionId): CompetitionConfig {
  const cfg = REGISTRY[id];
  if (!cfg) throw new Error(`Unknown competition: ${id}`);
  return cfg;
}

export function listCompetitions(): CompetitionConfig[] {
  return Object.values(REGISTRY);
}

export function isCompetitionId(value: string): value is CompetitionId {
  return value === "world-cup" || value === "premier-league";
}

/**
 * Resolve which competition a query is about.
 *
 * Premier League is in-scope. Other domestic leagues / UEFA club cups stay
 * out of scope in Phase 1. World Cup remains a first-class plugin.
 */
export function resolveCompetitionId(
  query: string,
  hint?: CompetitionId
): CompetitionId {
  if (hint) return hint;
  const q = query.toLowerCase();
  if (WORLD_CUP_QUERY.test(q)) return "world-cup";
  if (PREMIER_LEAGUE_QUERY.test(q)) return "premier-league";
  return DEFAULT_COMPETITION_ID;
}

const WORLD_CUP_QUERY =
  /world cup|世界杯|ワールドカップ|fifa 2026|wc2026|grupo [a-l]\b|group [a-l]\b/;

const PREMIER_LEAGUE_QUERY =
  /premier league|\bepl\b|\bpl\b|english premier|gw\s*\d+|gameweek|this weekend'?s? (pl|premier)/;
