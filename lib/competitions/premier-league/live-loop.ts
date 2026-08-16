/**
 * Live result loop.
 *
 *   Fixture finishes
 *     → result verified
 *     → settle frozen predictions
 *     → update team ratings (via ratingsAsOf on next call)
 *     → new model STATE (not a new model version)
 *     → predict future fixtures
 *
 * Unverified / live / postponed scores never become training data.
 */

import type { Fixture } from "@/lib/identity/types";
import { canonicalizeFixtureStatus } from "./ingest";
import { applyFixturePatch, liveFixtures } from "./fixture-store";
import { canSettle, settleFixture, type SettlementRecord } from "./settlement";
import { snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { upcomingLiveFixtures } from "./data-gate";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { PRODUCTION_MODEL_VERSION } from "./model-tracks";
import { stageFromTiming } from "./stages";
import { isBeforeKickoff } from "./timezone";

export interface ResultIngest {
  fixtureId: string;
  homeGoals: number;
  awayGoals: number;
  finishedAt?: string;
  resultSource: string;
  verified: boolean;
}

export function ingestVerifiedResult(input: ResultIngest): {
  fixture: Fixture;
  settlements: SettlementRecord[];
} {
  const existing = liveFixtures().find((f) => f.id === input.fixtureId);
  if (!existing) throw new Error(`Unknown fixture ${input.fixtureId}`);
  const status = canonicalizeFixtureStatus(existing.status);
  if (status === "POSTPONED" || status === "CANCELLED" || status === "SUSPENDED") {
    throw new Error(`Refusing to settle ${existing.id} as a normal result (status=${status})`);
  }
  if (!input.verified) {
    throw new Error(`Refusing to persist unverified score for ${existing.id}`);
  }
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const fixture = applyFixturePatch(input.fixtureId, {
    homeGoals: input.homeGoals,
    awayGoals: input.awayGoals,
    status: "FINISHED",
    resultSource: input.resultSource,
    finishedAt,
    statusUpdatedAt: finishedAt,
  });
  if (!canSettle(fixture)) return { fixture, settlements: [] };
  return { fixture, settlements: settleFixture(fixture, finishedAt) };
}

export function freezeUpcomingForecasts(options: {
  asOf?: string;
  limit?: number;
} = {}): number {
  const asOf = options.asOf ?? new Date().toISOString();
  const upcoming = upcomingLiveFixtures(new Date(asOf));
  const take = options.limit ?? upcoming.length;
  let n = 0;
  for (const f of upcoming.slice(0, take)) {
    const kick = f.kickoffUtc ?? f.kickoff ?? null;
    if (kick && !isBeforeKickoff(asOf, kick)) continue;
    snapshotPremierLeagueMatch(f.homeSlug, f.awaySlug, {
      asOf,
      kickoff: kick ?? undefined,
      fixtureId: f.id,
      season: f.season ?? PREMIER_LEAGUE_CURRENT_SEASON,
      predictionStage: stageFromTiming(asOf, kick),
      evaluationClass: "LIVE_OOS",
    });
    n += 1;
  }
  return n;
}

export function productionModelVersion(): string {
  return PRODUCTION_MODEL_VERSION;
}
