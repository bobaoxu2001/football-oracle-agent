import type { BigFiveCompetitionId, CompetitionConfig, CompetitionId } from "./types";
import { BIG_FIVE_COMPETITION_IDS, COMPETITION_IDS } from "./types";
import { WORLD_CUP_CONFIG } from "./world-cup/config";
import { PREMIER_LEAGUE_CONFIG } from "./premier-league/config";
import {
  BUNDESLIGA_CONFIG,
  LA_LIGA_CONFIG,
  LIGUE_1_CONFIG,
  SERIE_A_CONFIG,
} from "./big-five/configs";

const REGISTRY: Record<CompetitionId, CompetitionConfig> = {
  "world-cup": WORLD_CUP_CONFIG,
  "premier-league": PREMIER_LEAGUE_CONFIG,
  "la-liga": LA_LIGA_CONFIG,
  bundesliga: BUNDESLIGA_CONFIG,
  "serie-a": SERIE_A_CONFIG,
  "ligue-1": LIGUE_1_CONFIG,
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
  return (COMPETITION_IDS as readonly string[]).includes(value);
}

/** The five domestic leagues tracked by the 2026-27 match ledger. */
export function listBigFiveCompetitions(): CompetitionConfig[] {
  return BIG_FIVE_COMPETITION_IDS.map((id) => getCompetition(id));
}

export function getBigFiveCompetition(id: BigFiveCompetitionId): CompetitionConfig {
  return getCompetition(id);
}

/**
 * Resolve which competition a query is about.
 *
 * Premier League is in-scope. Other domestic leagues / UEFA club cups stay
 * out of scope in Phase 1. World Cup remains an archived research plugin.
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

/**
 * Query hints for the four ledger-only leagues.
 *
 * These route MATCH-HISTORY questions. Production forecasting stays Premier
 * League-only: resolveCompetitionId still refuses to send a production
 * prediction request their way. Labeled research 1X2 lives on
 * /research/big-five and is not returned by this resolver.
 */
const LEDGER_LEAGUE_QUERY: [Exclude<BigFiveCompetitionId, "premier-league">, RegExp][] = [
  ["la-liga", /la ?liga|primera divisi[oó]n|spanish league|西甲/i],
  ["bundesliga", /bundesliga|german league|德甲/i],
  ["serie-a", /serie ?a\b|italian league|意甲/i],
  ["ligue-1", /ligue ?1\b|french league|法甲/i],
];

/**
 * Resolve a Big Five competition from free text for LEDGER/history lookups.
 * Returns null when the query names none of them.
 */
export function resolveLedgerCompetitionId(query: string): BigFiveCompetitionId | null {
  const q = query.toLowerCase();
  for (const [id, re] of LEDGER_LEAGUE_QUERY) {
    if (re.test(q)) return id;
  }
  if (PREMIER_LEAGUE_QUERY.test(q)) return "premier-league";
  return null;
}
