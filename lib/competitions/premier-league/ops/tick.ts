/**
 * One live-ops tick. Idempotent. Safe to run every 5 minutes.
 */

import type { Fixture } from "@/lib/identity/types";
import { liveFixtures, replaceLiveFixtures, resetSeasonBundleCache } from "../fixture-store";
import { canSettle, settleFixtureDetailed } from "../settlement";
import { officialBaselineSource, defaultLiveSources, type FixtureSource } from "./sources";
import { collectSourceObservations, persistScheduleRevisions, syncFixturesFromObservations } from "./fixture-sync";
import { executeEligibleJobs, planPredictionJobs, refreshJobStatuses } from "./scheduler";
import { ingestAndVerifyResults } from "./result-feed";
import { applyVerifiedRatingUpdate } from "./rating-events";
import { listJobs } from "./job-ledger";
import type { DataConflict, LiveOpsTickState } from "./types";
import { readJsonFile, writeJsonFile } from "./jsonl";
import { tickStatePath } from "./paths";
import { flushDurableOps, hydrateDurableOps } from "./durable-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { acquireTickLock, releaseTickLock } from "./tick-lock";

export const TICK_CADENCE_MS = 5 * 60 * 1000;

export interface TickOptions {
  now?: string;
  fixtures?: Fixture[];
  sources?: FixtureSource[];
  persistFixtures?: boolean;
  persistObservations?: boolean;
  persistFixturePatches?: boolean;
  skipNetwork?: boolean;
  /** Skip the challenger freeze (baseline-isolation tests). */
  skipShadow?: boolean;
}

export interface TickResult {
  now: string;
  fixtureRevisions: number;
  fixtureConflicts: DataConflict[];
  jobsPlanned: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsMissed: number;
  resultConflicts: DataConflict[];
  /** New immutable settlement records inserted this tick; replay hits are excluded. */
  settled: number;
  ratingsApplied: number;
  /** Challenger snapshots frozen this tick. Never affects the baseline count. */
  shadowFrozen: number;
  errors: string[];
  state: LiveOpsTickState;
}

function loadTickState(): LiveOpsTickState {
  return (
    readJsonFile<LiveOpsTickState>(tickStatePath()) ?? {
      lastTickAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastFixtureSyncAt: null,
      lastFixtureSyncOkAt: null,
      lastResultSyncAt: null,
      lastResultSyncOkAt: null,
      lastVerifiedResultAt: null,
      lastVerifiedFixtureId: null,
      ticks: 0,
      lastShadowFreezeAt: null,
      lastShadowError: null,
      lastShadowFrozen: 0,
    }
  );
}

function saveTickState(state: LiveOpsTickState): void {
  writeJsonFile(tickStatePath(), state);
}

export function loadOpsTickState(): LiveOpsTickState {
  return loadTickState();
}

export async function runLiveOpsTick(options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? new Date().toISOString();
  const errors: string[] = [];
  const state = loadTickState();
  state.lastTickAt = now;
  state.ticks += 1;

  let fixtures = options.fixtures ?? liveFixtures();
  const sources =
    options.sources ??
    (options.skipNetwork ? [officialBaselineSource(fixtures)] : [officialBaselineSource(fixtures), ...defaultLiveSources()]);

  const collected = await collectSourceObservations(sources, now);
  errors.push(...collected.errors);
  state.lastFixtureSyncAt = now;
  state.lastResultSyncAt = now;

  const sync = syncFixturesFromObservations({
    fixtures,
    observations: collected.observations,
    now,
    persistObservations: options.persistObservations ?? true,
  });
  persistScheduleRevisions(sync.revisions);
  fixtures = sync.fixtures;
  if ((options.persistFixtures ?? true) && sync.changedFixtureIds.length) {
    try {
      replaceLiveFixtures(fixtures);
      resetSeasonBundleCache();
      if (!options.fixtures) fixtures = liveFixtures();
    } catch (err) {
      errors.push(`fixture persist: ${(err as Error).message}`);
    }
  }
  if (!collected.errors.length) {
    state.lastFixtureSyncOkAt = now;
    state.lastResultSyncOkAt = now;
  }

  const planned = planPredictionJobs({ fixtures, now });
  refreshJobStatuses(now);
  const exec = executeEligibleJobs({ fixtures, now });

  // Shadow (challenger) freeze — strictly after the baseline has been frozen,
  // inside the same lease because it writes snapshots. Additive only: it mints
  // records under a different model version and cannot alter a baseline one.
  // Any failure is captured, never propagated: the challenger must not be able
  // to break production forecasting.
  let shadowFrozen = 0;
  if (!options.skipShadow) {
    try {
      const [{ freezeShadowForCompletedJobs }, { shadowModelEnabled }, { listCanonicalMatches }] =
        await Promise.all([
          import("../shadow/freeze"),
          import("../shadow/track"),
          import("@/lib/match-ledger/store"),
        ]);
      if (shadowModelEnabled()) {
        const ledgerMatches = await listCanonicalMatches({
          competition: "premier-league",
          season: PREMIER_LEAGUE_CURRENT_SEASON,
        });
        const shadow = freezeShadowForCompletedJobs({ now, ledgerMatches });
        shadowFrozen = shadow.frozen;
        if (shadow.frozen > 0) {
          state.lastShadowFreezeAt = now;
          state.lastShadowFrozen = shadow.frozen;
        }
        if (shadow.errors.length) {
          state.lastShadowError = shadow.errors[shadow.errors.length - 1];
          errors.push(...shadow.errors.map((e) => `shadow: ${e}`));
        } else {
          state.lastShadowError = null;
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      state.lastShadowError = message;
      errors.push(`shadow freeze: ${message}`);
    }
  }

  const results = ingestAndVerifyResults({
    fixtures,
    observations: collected.observations,
    now,
    persistFixturePatches: options.persistFixturePatches ?? true,
  });

  let settled = 0;
  let ratingsApplied = 0;
  for (const v of results.verifiedFinal) {
    const fixture = fixtures.find((f) => f.id === v.fixtureId);
    if (!fixture || v.homeGoals === null || v.awayGoals === null) continue;
    const finished: Fixture = {
      ...fixture,
      status: "FINISHED",
      homeGoals: v.homeGoals,
      awayGoals: v.awayGoals,
      resultSource: v.sources.join("+"),
      finishedAt: v.verifiedAt,
    };
    if (!canSettle(finished)) continue;
    try {
      const batch = settleFixtureDetailed(finished, now, {
        evaluationClass: "LIVE_OOS",
        verificationId: `${v.fixtureId}::${v.verifiedAt ?? now}`,
      });
      settled += batch.inserted.length;
    } catch (err) {
      errors.push(`settle ${v.fixtureId}: ${(err as Error).message}`);
    }
    try {
      const rating = applyVerifiedRatingUpdate({ fixture: finished, appliedAt: now });
      if (rating.applied) ratingsApplied += 1;
    } catch (err) {
      errors.push(`rating ${v.fixtureId}: ${(err as Error).message}`);
    }
    state.lastVerifiedResultAt = now;
    state.lastVerifiedFixtureId = v.fixtureId;
  }

  if (errors.length) state.lastError = errors[errors.length - 1];
  else {
    state.lastSuccessAt = now;
    state.lastError = null;
  }
  saveTickState(state);

  const missed = listJobs().filter((j) => j.status === "MISSED").length;

  return {
    now,
    fixtureRevisions: sync.revisions.length,
    fixtureConflicts: sync.conflicts,
    jobsPlanned: planned.upserted.length,
    jobsSucceeded: exec.succeeded,
    jobsFailed: exec.failed,
    jobsMissed: missed,
    resultConflicts: results.conflicts,
    settled,
    ratingsApplied,
    shadowFrozen,
    errors,
    state,
  };
}

export async function runGuardedLiveOpsTick(options: TickOptions = {}): Promise<TickResult & { skipped?: boolean; skipReason?: string }> {
  await hydrateDurableOps();
  const lock = await acquireTickLock("ops-tick");
  if (!lock.ok) {
    const state = loadTickState();
    return {
      now: options.now ?? new Date().toISOString(),
      fixtureRevisions: 0,
      fixtureConflicts: [],
      jobsPlanned: 0,
      jobsSucceeded: 0,
      jobsFailed: 0,
      jobsMissed: 0,
      resultConflicts: [],
      settled: 0,
      ratingsApplied: 0,
      shadowFrozen: 0,
      errors: [],
      state,
      skipped: true,
      skipReason: lock.reason,
    };
  }
  try {
    const result = await runLiveOpsTick(options);
    await flushDurableOps();
    return result;
  } finally {
    await releaseTickLock(lock.leaseId);
    // Market recording is after the forecast lease. Outages must not block ticks.
    // skipNetwork ticks are forecast-isolation tests and must not call the odds API.
    if (!options.skipNetwork && process.env.MARKET_RECORDER_DISABLED !== "1") {
      try {
        const { maybeRunMarketRecorder } = await import("../market/recorder");
        await maybeRunMarketRecorder({ now: options.now });
      } catch (err) {
        console.warn("[market] recorder failed in isolation:", (err as Error).message);
      }
    }
    // Big Five match ledger, same isolation contract as the market recorder:
    // after the forecast lease, never able to fail a forecast tick, and rate
    // limited by its own cadence gate rather than a second scheduler.
    if (!options.skipNetwork && process.env.MATCH_LEDGER_DISABLED !== "1") {
      try {
        const { runLedgerTick } = await import("@/lib/match-ledger/tick");
        const led = await runLedgerTick({ now: options.now });
        if (led.ran && led.errors.length) {
          console.warn("[ledger] ingest reported errors:", led.errors.join("; "));
        }
      } catch (err) {
        console.warn("[ledger] pass failed in isolation:", (err as Error).message);
      }
    }
  }
}
