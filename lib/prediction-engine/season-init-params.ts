/**
 * Season-initialization coefficients for the production track.
 *
 * Loaded from disk after scripts/fit-season-init.ts. Until that file exists
 * (or if it is still labeled unfitted), callers fall back to the documented
 * placeholders. Benchmark code never imports this module.
 */

import fs from "node:fs";
import path from "node:path";
import type { SeasonInitCoefficients } from "./season-init";
import { PREMIER_LEAGUE_MEAN_ELO, PROMOTION_GAP, SEASON_SHRINK } from "./rating-core";

const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "data/processed/premier-league/season-init-params.json"
);

export const PLACEHOLDER_SEASON_INIT: SeasonInitCoefficients = {
  seasonShrink: SEASON_SHRINK,
  promotionGap: PROMOTION_GAP,
  leagueMean: PREMIER_LEAGUE_MEAN_ELO,
  fitted: false,
  version: "pl-season-init-placeholder-v0.1.0",
  note: "Placeholder coefficients. Not fitted. Do not treat as calibrated Premier League constants.",
};

export function loadSeasonInitCoefficients(): SeasonInitCoefficients {
  try {
    if (!fs.existsSync(DEFAULT_PATH)) return PLACEHOLDER_SEASON_INIT;
    const raw = JSON.parse(fs.readFileSync(DEFAULT_PATH, "utf8")) as SeasonInitCoefficients;
    if (typeof raw.seasonShrink !== "number" || typeof raw.promotionGap !== "number") {
      return PLACEHOLDER_SEASON_INIT;
    }
    return raw;
  } catch {
    return PLACEHOLDER_SEASON_INIT;
  }
}
