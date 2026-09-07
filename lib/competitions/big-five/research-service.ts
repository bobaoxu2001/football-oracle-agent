/**
 * Ledger-backed loader for Big Five research forecasts.
 *
 * Read-only. Does not freeze snapshots, does not touch the Premier League
 * production tape, and does not ingest from the provider on page load.
 */

import { BIG_FIVE_CURRENT_SEASON } from "./configs";
import { listCanonicalMatches } from "@/lib/match-ledger/store";
import { loadLedgerState } from "@/lib/match-ledger/scheduler";
import {
  RESEARCH_FORECAST_COMPETITION_IDS,
  assertResearchForecastCompetition,
  type ResearchForecastCompetitionId,
} from "./research-params";
import {
  buildResearchForecastBoard,
  researchForecastForMatchId,
} from "./research-forecast";
import type { ResearchForecastBoard, ResearchMatchForecast } from "./research-types";

export async function loadResearchForecastBoard(options: {
  competition: string;
  season?: string;
  asOf?: string;
  limit?: number;
}): Promise<ResearchForecastBoard> {
  const competition = assertResearchForecastCompetition(options.competition);
  const season = options.season ?? BIG_FIVE_CURRENT_SEASON;
  const asOf = options.asOf ?? new Date().toISOString();
  const [matches, ledgerState] = await Promise.all([
    listCanonicalMatches({ competition, season }),
    loadLedgerState(),
  ]);
  return buildResearchForecastBoard({
    competition,
    season,
    asOf,
    matches,
    limit: options.limit,
    ledgerLastIngestAt: ledgerState.lastIngestOkAt,
    computedAt: asOf,
  });
}

export async function loadResearchMatchForecast(options: {
  competition: ResearchForecastCompetitionId | string;
  matchId: string;
  season?: string;
  asOf?: string;
}): Promise<ResearchMatchForecast> {
  const competition = assertResearchForecastCompetition(options.competition);
  const season = options.season ?? BIG_FIVE_CURRENT_SEASON;
  const asOf = options.asOf ?? new Date().toISOString();
  const matches = await listCanonicalMatches({ competition, season });
  return researchForecastForMatchId({
    matchId: options.matchId,
    competition,
    season,
    asOf,
    matches,
    computedAt: asOf,
  });
}

export async function loadAllResearchForecastBoards(options: {
  asOf?: string;
  limit?: number;
} = {}): Promise<ResearchForecastBoard[]> {
  const boards: ResearchForecastBoard[] = [];
  for (const competition of RESEARCH_FORECAST_COMPETITION_IDS) {
    boards.push(
      await loadResearchForecastBoard({
        competition,
        asOf: options.asOf,
        limit: options.limit,
      })
    );
  }
  return boards;
}
