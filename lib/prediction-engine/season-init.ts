/**
 * Explicit new-season rating initialization.
 *
 *   priorSeasonFinalRating
 *     → regression toward league mean          (staying clubs)
 *     → Championship translation + shrink      (promoted, if a prior exists)
 *     → flat placeholder prior                 (promoted, no Championship tape)
 *     → new-season initial rating
 *
 * Coefficients below are PLACEHOLDERS. They are not fitted. Phase 2A may
 * calibrate them; do not present them as empirical Premier League constants.
 */

import type { ClubSeason } from "@/lib/identity/types";
import {
  PREMIER_LEAGUE_MEAN_ELO,
  PROMOTION_GAP,
  SEASON_SHRINK,
  promotedPrior,
  shrinkTowardMean,
} from "./rating-core";

export type SeasonInitPath =
  | "staying-shrunk"
  | "promoted-from-championship"
  | "promoted-flat-prior"
  | "carried-non-member";

export interface SeasonInitInput {
  previousPlRatings: Record<string, number>;
  previousPlClubSlugs: string[];
  newSeasonClubSlugs: string[];
  /** Championship (or other feeder) ratings as-of the previous season end. */
  feederRatings?: Record<string, number>;
  mean?: number;
}

export interface SeasonInitResult {
  ratings: Record<string, number>;
  paths: Record<string, SeasonInitPath>;
  clubSeasons: ClubSeason[];
  /** Coefficients actually applied — labeled placeholders. */
  coefficients: {
    seasonShrink: number;
    promotionGap: number;
    leagueMean: number;
    fitted: false;
    note: string;
  };
}

export function initializeSeasonRatings(
  input: SeasonInitInput & { season?: string }
): SeasonInitResult {
  const mean = input.mean ?? PREMIER_LEAGUE_MEAN_ELO;
  const prevSet = new Set(input.previousPlClubSlugs);
  const ratings: Record<string, number> = {};
  const paths: Record<string, SeasonInitPath> = {};

  for (const slug of input.newSeasonClubSlugs) {
    const prev = input.previousPlRatings[slug];
    if (prevSet.has(slug) && typeof prev === "number") {
      ratings[slug] = shrinkTowardMean(prev, mean);
      paths[slug] = "staying-shrunk";
      continue;
    }
    const feeder = input.feederRatings?.[slug];
    if (typeof feeder === "number" && Number.isFinite(feeder)) {
      ratings[slug] = promotedPrior(feeder, mean);
      paths[slug] = "promoted-from-championship";
    } else {
      ratings[slug] = promotedPrior(undefined, mean);
      paths[slug] = "promoted-flat-prior";
    }
  }

  // Keep non-members (e.g. Championship-only clubs) so a later promotion can
  // still see their feeder rating. They are not in the PL table.
  for (const [slug, elo] of Object.entries(input.previousPlRatings)) {
    if (ratings[slug] === undefined) {
      ratings[slug] = elo;
      paths[slug] = "carried-non-member";
    }
  }
  if (input.feederRatings) {
    for (const [slug, elo] of Object.entries(input.feederRatings)) {
      if (ratings[slug] === undefined) {
        ratings[slug] = elo;
        paths[slug] = "carried-non-member";
      }
    }
  }

  const clubSeasons: ClubSeason[] = input.newSeasonClubSlugs.map((clubSlug) => ({
    clubSlug,
    competition: "premier-league",
    season: input.season ?? "unknown",
    division: "premier-league",
    entry:
      paths[clubSlug] === "staying-shrunk"
        ? "stayed"
        : paths[clubSlug]?.startsWith("promoted")
          ? "promoted"
          : "unknown",
  }));

  return {
    ratings,
    paths,
    clubSeasons,
    coefficients: {
      seasonShrink: SEASON_SHRINK,
      promotionGap: PROMOTION_GAP,
      leagueMean: mean,
      fitted: false,
      note: "Placeholder coefficients. Not fitted. Do not treat as calibrated Premier League constants.",
    },
  };
}
