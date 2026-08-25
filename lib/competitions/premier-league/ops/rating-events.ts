/**
 * Exactly-once rating updates after VERIFIED_FINAL results.
 *
 * Identity is fixtureId. A repeated ingest cannot apply Elo twice.
 * Corrections append a separate record and do not mutate this event.
 */

import type { Fixture } from "@/lib/identity/types";
import { applyFixtureToRatings, ratingOf, ratingsAsOf, type RatingState } from "../ratings";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import type { RatingAppliedEvent } from "./types";
import { appendJsonl, readJsonl, unlinkIfExists, writeJsonFile } from "./jsonl";
import { ratingEventPath, ratingStateSnapshotPath } from "./paths";

export const RATING_FORMULA_VERSION = "elo-pl-live-v0.2.0";

const g = globalThis as unknown as {
  __foaRatingEvents?: { byFixture: Map<string, RatingAppliedEvent>; loadedFrom: string | null };
};

function mem() {
  if (!g.__foaRatingEvents) g.__foaRatingEvents = { byFixture: new Map(), loadedFrom: null };
  return g.__foaRatingEvents;
}

function load(): void {
  const file = ratingEventPath();
  const state = mem();
  if (state.loadedFrom === file) return;
  state.byFixture.clear();
  state.loadedFrom = file;
  for (const row of readJsonl<RatingAppliedEvent>(file)) {
    if (!state.byFixture.has(row.fixtureId)) state.byFixture.set(row.fixtureId, row);
  }
}

export function resetRatingEventCache(): void {
  g.__foaRatingEvents = { byFixture: new Map(), loadedFrom: null };
}

export function clearRatingEventsForTests(): void {
  resetRatingEventCache();
  unlinkIfExists(ratingEventPath());
  unlinkIfExists(ratingStateSnapshotPath());
}

export function listRatingEvents(): RatingAppliedEvent[] {
  load();
  return [...mem().byFixture.values()].sort(
    (a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc) || a.fixtureId.localeCompare(b.fixtureId)
  );
}

export function getRatingEvent(fixtureId: string): RatingAppliedEvent | null {
  load();
  return mem().byFixture.get(fixtureId) ?? null;
}

/**
 * Rating evidence that was genuinely available at a forecast cutoff.
 *
 * Both guards are required. A match must already have kicked off, and this
 * system must already have verified/applied its result. Filtering by kickoff
 * alone would let a late result leak into a snapshot whose cutoff is backdated
 * to before the result was known.
 */
export function ratingEventsAsOf(asOf: string): RatingAppliedEvent[] {
  const cutoffMs = Date.parse(asOf.length === 10 ? `${asOf}T00:00:00.000Z` : asOf);
  if (!Number.isFinite(cutoffMs)) throw new Error(`Invalid rating cutoff: ${asOf}`);
  return listRatingEvents().filter((event) => {
    const kickoffMs = Date.parse(event.kickoffUtc);
    const appliedMs = Date.parse(event.appliedAt);
    return (
      Number.isFinite(kickoffMs) &&
      Number.isFinite(appliedMs) &&
      kickoffMs < cutoffMs &&
      appliedMs >= kickoffMs &&
      appliedMs <= cutoffMs
    );
  });
}

function persistStateSnapshot(events: RatingAppliedEvent[], at: string): void {
  writeJsonFile(ratingStateSnapshotPath(), {
    asOf: at,
    modelVersion: PRODUCTION_MODEL_VERSION,
    formulaVersion: RATING_FORMULA_VERSION,
    appliedCount: events.length,
    lastFixtureId: events[events.length - 1]?.fixtureId ?? null,
    lastKickoffUtc: events[events.length - 1]?.kickoffUtc ?? null,
  });
}

export function applyVerifiedRatingUpdate(input: {
  fixture: Fixture;
  appliedAt?: string;
  priorState?: RatingState;
}): { event: RatingAppliedEvent; applied: boolean; state: RatingState } {
  load();
  const existing = mem().byFixture.get(input.fixture.id);
  const kickoffUtc = input.fixture.kickoffUtc ?? input.fixture.kickoff ?? `${input.fixture.date}T00:00:00.000Z`;
  const appliedAt = input.appliedAt ?? new Date().toISOString();

  if (existing) {
    return {
      event: existing,
      applied: false,
      state: input.priorState ?? liveStateFromEvents(appliedAt),
    };
  }

  if (input.fixture.homeGoals === null || input.fixture.awayGoals === null) {
    throw new Error(`Cannot apply rating update without a score for ${input.fixture.id}`);
  }

  const state = input.priorState ?? liveStateFromEvents(kickoffUtc);
  const preHome = ratingOf(state, input.fixture.homeSlug);
  const preAway = ratingOf(state, input.fixture.awaySlug);
  applyFixtureToRatings(state, {
    ...input.fixture,
    status: "FINISHED",
  });
  const event: RatingAppliedEvent = {
    eventId: `rating-apply::${input.fixture.id}`,
    fixtureId: input.fixture.id,
    season: input.fixture.season,
    kickoffUtc,
    homeSlug: input.fixture.homeSlug,
    awaySlug: input.fixture.awaySlug,
    homeGoals: input.fixture.homeGoals,
    awayGoals: input.fixture.awayGoals,
    preHome,
    preAway,
    postHome: ratingOf(state, input.fixture.homeSlug),
    postAway: ratingOf(state, input.fixture.awaySlug),
    formulaVersion: RATING_FORMULA_VERSION,
    modelVersion: PRODUCTION_MODEL_VERSION,
    appliedAt,
  };
  mem().byFixture.set(event.fixtureId, event);
  appendJsonl(ratingEventPath(), event);
  persistStateSnapshot(listRatingEvents(), appliedAt);
  return { event, applied: true, state };
}

export function applyVerifiedResultsInOrder(
  fixtures: Fixture[],
  appliedAt: string
): { applied: RatingAppliedEvent[]; skipped: string[] } {
  const ordered = fixtures.slice().sort((a, b) => {
    const ka = a.kickoffUtc ?? a.kickoff ?? a.date;
    const kb = b.kickoffUtc ?? b.kickoff ?? b.date;
    return ka.localeCompare(kb) || a.id.localeCompare(b.id);
  });
  const applied: RatingAppliedEvent[] = [];
  const skipped: string[] = [];
  // Same-kickoff matches share the prior state. No club plays twice at once,
  // so sequential apply by fixtureId is equivalent to a simultaneous batch.
  for (const f of ordered) {
    const result = applyVerifiedRatingUpdate({ fixture: f, appliedAt });
    if (result.applied) applied.push(result.event);
    else skipped.push(f.id);
  }
  return { applied, skipped };
}

export function liveStateFromEvents(asOf: string): RatingState {
  const dateCutoff = asOf.length >= 10 ? asOf.slice(0, 10) : asOf;
  const state = ratingsAsOf(dateCutoff);
  const events = ratingEventsAsOf(asOf);
  for (const e of events) {
    applyFixtureToRatings(state, {
      id: e.fixtureId,
      competition: "premier-league",
      season: e.season,
      date: e.kickoffUtc.slice(0, 10),
      kickoffUtc: e.kickoffUtc,
      homeSlug: e.homeSlug,
      awaySlug: e.awaySlug,
      homeGoals: e.homeGoals,
      awayGoals: e.awayGoals,
      status: "FINISHED",
      venue: "home",
    });
  }
  return state;
}
