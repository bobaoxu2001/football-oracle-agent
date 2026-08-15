/**
 * Temporary 2026-27 honesty layer.
 *
 * Official 2026-27 fixtures and the finalized promoted/relegated set are
 * NOT loaded. Any "current" PL output is a preseason baseline from the
 * previous season's 20-club field and ratings.
 */

import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { fixturesForSeason } from "./data";

export const PRESEASON_BASELINE_CAVEAT =
  "2026-27 official fixtures and the finalized promoted/relegated club set have not yet been loaded into this model. This is a temporary preseason baseline generated from the previous season's club/rating state and should not be treated as a live 2026-27 forecast.";

export function hasOfficialCurrentSeasonFixtures(): boolean {
  return fixturesForSeason(PREMIER_LEAGUE_CURRENT_SEASON).length > 0;
}

export function isPreseasonBaseline(): boolean {
  return !hasOfficialCurrentSeasonFixtures();
}

export function currentSeasonDisclaimer(): string | null {
  return isPreseasonBaseline() ? PRESEASON_BASELINE_CAVEAT : null;
}
