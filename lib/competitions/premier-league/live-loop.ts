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
import { PRODUCTION_MODEL_VERSION } from "./model-tracks";

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
  void options;
  throw new Error(
    "Manual LIVE_OOS freezing is disabled. Use the guarded operations scheduler so every production forecast is bound to a PIT-verified input manifest."
  );
}

export function productionModelVersion(): string {
  return PRODUCTION_MODEL_VERSION;
}
