/**
 * Production live ratings.
 *
 * Historical walk-forward stays date-strict (Phase 1 boundary).
 * Verified 2026-27 results enter only via RatingAppliedEvent and only
 * when kickoffUtc < asOf.
 */

import type { RatingState } from "../ratings";
import type { RatingAppliedEvent } from "./types";
import { liveStateFromEvents, ratingEventsAsOf } from "./rating-events";

export function liveRatingsAsOf(asOf: string): RatingState {
  return liveStateFromEvents(asOf);
}

export function liveRatingEventsAsOf(asOf: string): RatingAppliedEvent[] {
  return ratingEventsAsOf(asOf);
}

export function ratingStateAsOfLabel(asOf: string): string {
  return asOf;
}
