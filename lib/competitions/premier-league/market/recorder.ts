/**
 * Market poll planner + executor.
 * Isolated from prediction jobs. Failures never throw into forecast ticks.
 */

import { randomUUID } from "node:crypto";
import type { Fixture } from "@/lib/identity/types";
import { liveFixtures } from "../fixture-store";
import { canonicalizeFixtureStatus } from "../ingest";
import type { MarketDataSource, MarketObservation, MarketOrigin, MarketPollJob } from "./types";
import { MARKET_SCHEMA_VERSION, MARKET_TYPE_H2H } from "./types";
import { defaultMarketSource, marketSourceConfigured } from "./source";
import { extractH2hOdds } from "./the-odds-api";
import { evaluateDecimal1x2, fairSumsToOne } from "./odds-math";
import { mapMarketEvent } from "./mapping";
import { buildConsensus } from "./consensus";
import { effectiveCadenceMs, nearestFutureKickoffMs, nextPollAt, pollIsDue, QUOTA_CRITICAL } from "./cadence";
import {
  countConsensus,
  countObservations,
  getMapping,
  insertConsensus,
  insertObservation,
  insertPollJob,
  loadMarketState,
  saveMarketState,
  upsertMapping,
} from "./store";

export function observationIdOf(input: {
  source: string;
  sourceEventId: string;
  bookmakerKey: string;
  pollJobId: string;
}): string {
  return `${input.source}::${input.sourceEventId}::${input.bookmakerKey}::${MARKET_TYPE_H2H}::${input.pollJobId}`;
}

function kickoffsOf(fixtures: Fixture[]): Array<string | null> {
  return fixtures
    .filter((f) => {
      const s = canonicalizeFixtureStatus(f.status);
      return s === "SCHEDULED" || s === "LIVE";
    })
    .map((f) => f.kickoffUtc ?? f.kickoff ?? null);
}

export async function maybeRunMarketRecorder(options: {
  now?: string;
  fixtures?: Fixture[];
  source?: MarketDataSource;
  origin?: MarketOrigin;
  force?: boolean;
} = {}): Promise<MarketPollJob | null> {
  const now = options.now ?? new Date().toISOString();
  const fixtures = options.fixtures ?? liveFixtures();
  const source = options.source ?? defaultMarketSource();
  const origin = options.origin ?? "LIVE_RECORDED";
  const state = await loadMarketState();
  const nowMs = Date.parse(now);
  const untilKick = nearestFutureKickoffMs(kickoffsOf(fixtures), nowMs);
  const cadenceMs = effectiveCadenceMs(untilKick, state.lastQuota.remaining);
  const due = options.force || pollIsDue(now, state.lastSuccessAt, cadenceMs);

  if (!source.configured && !options.force) {
    const skip: MarketPollJob = {
      pollJobId: `market-poll::skip::${now}`,
      scheduledFor: now,
      executedAt: now,
      status: "SKIPPED",
      cadenceMs: Number.isFinite(cadenceMs) ? cadenceMs : 0,
      eventsReturned: 0,
      fixturesCovered: 0,
      fixturesMatched: 0,
      fixturesUnmatched: 0,
      fixturesAmbiguous: 0,
      bookmakersObserved: 0,
      observationsWritten: 0,
      observationsDeduped: 0,
      consensusWritten: 0,
      quotaCost: null,
      quotaRemaining: state.lastQuota.remaining,
      error: "ODDS_API_KEY not configured",
    };
    await insertPollJob(skip);
    await saveMarketState({
      ...state,
      source: source.id,
      sourceConfigured: false,
      lastSkipAt: now,
      lastError: skip.error,
      currentCadenceMs: Number.isFinite(cadenceMs) ? cadenceMs : null,
      nextPollAt: now,
    });
    return skip;
  }

  if (!due) {
    return {
      pollJobId: `market-poll::not-due::${now}`,
      scheduledFor: state.nextPollAt ?? now,
      executedAt: now,
      status: "SKIPPED",
      cadenceMs: Number.isFinite(cadenceMs) ? cadenceMs : 0,
      eventsReturned: 0,
      fixturesCovered: 0,
      fixturesMatched: 0,
      fixturesUnmatched: 0,
      fixturesAmbiguous: 0,
      bookmakersObserved: 0,
      observationsWritten: 0,
      observationsDeduped: 0,
      consensusWritten: 0,
      quotaCost: null,
      quotaRemaining: state.lastQuota.remaining,
      error: "poll not due",
    };
  }

  const pollJobId = `market-poll::${now}::${randomUUID().slice(0, 8)}`;
  try {
    const fetched = await source.fetchH2h(now);
    const books = new Set<string>();
    const written: MarketObservation[] = [];
    let deduped = 0;
    let matched = 0;
    let unmatched = 0;
    let ambiguous = 0;
    let conflict = 0;

    for (const ev of fetched.events) {
      if (!ev.sourceEventId || !ev.homeTeam || !ev.awayTeam) {
        unmatched += 1;
        continue;
      }
      const prior = await getMapping(ev.source, ev.sourceEventId);
      const mapped = mapMarketEvent(ev, fixtures, now, prior);
      await upsertMapping(mapped);

      if (mapped.mappingStatus === "MATCHED") matched += 1;
      else if (mapped.mappingStatus === "AMBIGUOUS") ambiguous += 1;
      else if (mapped.mappingStatus === "CONFLICT") conflict += 1;
      else unmatched += 1;

      if (mapped.mappingStatus !== "MATCHED" || !mapped.canonicalFixtureId) continue;
      const kick = fixtures.find((f) => f.id === mapped.canonicalFixtureId);
      const kickMs = Date.parse(kick?.kickoffUtc ?? kick?.kickoff ?? "");
      if (Number.isFinite(kickMs) && kickMs <= nowMs) continue;

      for (const bk of ev.bookmakers) {
        if (!bk.bookmakerKey) continue;
        const extracted = extractH2hOdds(bk.outcomes, ev.homeTeam, ev.awayTeam);
        if (!extracted) continue;
        let math;
        try {
          math = evaluateDecimal1x2(extracted.home, extracted.draw, extracted.away);
        } catch {
          continue;
        }
        if (!fairSumsToOne(math.fair, 1e-9)) continue;
        books.add(bk.bookmakerKey);
        const row: MarketObservation = {
          observationId: observationIdOf({
            source: ev.source,
            sourceEventId: ev.sourceEventId,
            bookmakerKey: bk.bookmakerKey,
            pollJobId,
          }),
          marketSchemaVersion: MARKET_SCHEMA_VERSION,
          origin,
          source: ev.source,
          sourceEventId: ev.sourceEventId,
          canonicalFixtureId: mapped.canonicalFixtureId,
          mappingStatus: "MATCHED",
          bookmakerKey: bk.bookmakerKey,
          bookmakerName: bk.bookmakerName,
          marketType: MARKET_TYPE_H2H,
          retrievedAt: fetched.retrievedAt,
          bookmakerLastUpdate: bk.lastUpdate,
          commenceTime: ev.commenceTime,
          homeOddsDecimal: math.odds.home,
          drawOddsDecimal: math.odds.draw,
          awayOddsDecimal: math.odds.away,
          rawImpliedHome: math.rawImplied.home,
          rawImpliedDraw: math.rawImplied.draw,
          rawImpliedAway: math.rawImplied.away,
          overround: math.overround,
          bookmakerMargin: math.bookmakerMargin,
          devigMethod: math.devigMethod,
          fairHome: math.fair.home,
          fairDraw: math.fair.draw,
          fairAway: math.fair.away,
          sourceRegion: fetched.region,
          pollJobId,
        };
        const result = await insertObservation(row);
        if (result === "inserted") written.push(row);
        else deduped += 1;
      }
    }

    const byFixture = new Map<string, MarketObservation[]>();
    for (const row of written) {
      const list = byFixture.get(row.canonicalFixtureId) ?? [];
      list.push(row);
      byFixture.set(row.canonicalFixtureId, list);
    }
    let consensusWritten = 0;
    for (const [fixtureId, rows] of byFixture) {
      const snap = buildConsensus(fixtureId, rows, pollJobId, now);
      if (!snap) continue;
      const r = await insertConsensus(snap);
      if (r === "inserted") consensusWritten += 1;
    }

    const nextCadence = effectiveCadenceMs(untilKick, fetched.quota.remaining);
    const job: MarketPollJob = {
      pollJobId,
      scheduledFor: now,
      executedAt: now,
      status: fetched.quota.remaining != null && fetched.quota.remaining < QUOTA_CRITICAL ? "DEGRADED" : "SUCCEEDED",
      cadenceMs: Number.isFinite(nextCadence) ? nextCadence : 0,
      eventsReturned: fetched.events.length,
      fixturesCovered: byFixture.size,
      fixturesMatched: matched,
      fixturesUnmatched: unmatched,
      fixturesAmbiguous: ambiguous + conflict,
      bookmakersObserved: books.size,
      observationsWritten: written.length,
      observationsDeduped: deduped,
      consensusWritten,
      quotaCost: fetched.quota.lastRequestCost,
      quotaRemaining: fetched.quota.remaining,
      error: null,
    };
    await insertPollJob(job);
    const firstAt = state.firstMarketObservationAt ?? (written.length ? now : null);
    await saveMarketState({
      source: source.id,
      sourceConfigured: true,
      lastSuccessAt: now,
      lastFailedAt: state.lastFailedAt,
      lastSkipAt: state.lastSkipAt,
      lastError: null,
      lastQuota: fetched.quota,
      nextPollAt: nextPollAt(now, now, nextCadence),
      currentCadenceMs: Number.isFinite(nextCadence) ? nextCadence : null,
      firstMarketObservationAt: firstAt,
      firstPollSource: state.firstPollSource ?? (written.length ? source.id : null),
      firstPollSchemaVersion: state.firstPollSchemaVersion ?? (written.length ? MARKET_SCHEMA_VERSION : null),
      firstPollDeployment: state.firstPollDeployment ?? (written.length ? process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null : null),
      polls: state.polls + 1,
    });
    return job;
  } catch (err) {
    const job: MarketPollJob = {
      pollJobId,
      scheduledFor: now,
      executedAt: now,
      status: "FAILED",
      cadenceMs: Number.isFinite(cadenceMs) ? cadenceMs : 0,
      eventsReturned: 0,
      fixturesCovered: 0,
      fixturesMatched: 0,
      fixturesUnmatched: 0,
      fixturesAmbiguous: 0,
      bookmakersObserved: 0,
      observationsWritten: 0,
      observationsDeduped: 0,
      consensusWritten: 0,
      quotaCost: null,
      quotaRemaining: state.lastQuota.remaining,
      error: (err as Error).message,
    };
    await insertPollJob(job);
    await saveMarketState({
      ...state,
      source: source.id,
      sourceConfigured: marketSourceConfigured(),
      lastFailedAt: now,
      lastError: job.error,
      currentCadenceMs: Number.isFinite(cadenceMs) ? cadenceMs : null,
      nextPollAt: nextPollAt(now, state.lastSuccessAt, Number.isFinite(cadenceMs) ? cadenceMs : 6 * 3600_000),
    });
    return job;
  }
}

export async function marketCoverage() {
  const [nObs, nCons, state] = await Promise.all([countObservations(), countConsensus(), loadMarketState()]);
  return { observations: nObs, consensus: nCons, firstMarketObservationAt: state.firstMarketObservationAt };
}
