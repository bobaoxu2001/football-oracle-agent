/**
 * Operational health. Prefer a visible failure over silent corruption.
 */

import { evaluateDataGate } from "../data-gate";
import { liveCompetitionSeason, liveFixtures } from "../fixture-store";
import { kickoffCertaintyCounts } from "../kickoff-certainty";
import { canonicalizeFixtureStatus } from "../ingest";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import {
  canonicalLedgerMetrics,
  type CanonicalLedgerMetrics,
} from "../ledger-metrics";
import { jobCounts, listJobs } from "./job-ledger";
import { loadOpsTickState, TICK_CADENCE_MS } from "./tick";
import { loadScheduleRevisions } from "./fixture-sync";
import { listRatingEvents } from "./rating-events";
import { loadVerifications, resultConflicts, loadSettlementCorrections } from "./result-feed";
import { nextScheduledJob } from "./scheduler";
import { apiFootballConfigured, footballDataConfigured } from "./sources";
import type { DataConflict, HealthState } from "./types";
import { durableStatus } from "./durable-store";
import { isProductionRuntime } from "./tick-auth";
import { mongoConfigured } from "@/lib/db/mongodb";
import {
  PRODUCTION_FRESHNESS_POLICY_VERSION,
  evaluateFixtureSyncFreshness,
  evaluateSchedulerFreshness,
  summarizeForecastCoverage,
  type FixtureForecastFreshness,
  type FixtureSyncFreshness,
  type ForecastCoverageFreshness,
  type OperationalFreshness,
} from "./production-freshness";
import { listLiveSnapshots } from "./live-snapshot-reader";
import { forecastFreshness } from "@/lib/match-forecast/service";

const HOUR = 3_600_000;
const RESULT_STALE_AFTER_KICKOFF_MS = 6 * HOUR;

export interface HealthReport {
  overall: HealthState;
  overallScope: "production_operations";
  reasons: string[];
  /** Canonical, explicitly scoped count contract shared with every public API. */
  ledgerMetrics: CanonicalLedgerMetrics;
  season: {
    label: string;
    status: string | null;
    dataVersion: string | null;
    dataReady: string;
    dataReadyReasons: string[];
  };
  fixtureSync: {
    lastAttempt: string | null;
    lastSuccess: string | null;
    stale: boolean;
    freshness: FixtureSyncFreshness;
    revisionCount: number;
    configuredLiveSources: string[];
  };
  kickoff: {
    confirmed: number;
    default: number;
    provisional: number;
    tbd: number;
    conflict: number;
    nextConfirmed: {
      fixtureId: string;
      kickoffUtc: string | null;
      home: string;
      away: string;
    } | null;
  };
  scheduler: {
    cadenceMs: number;
    host: string | null;
    jobs: ReturnType<typeof jobCounts>;
    activeJobs: number;
    nextJob: {
      jobId: string;
      stage: string;
      fixtureId: string;
      eligibleFrom: string;
      target: string;
      eligibleUntil: string;
      kickoff: string;
      certainty: string | null;
      status: string;
    } | null;
    lastTickAt: string | null;
    lastSuccessAt: string | null;
    tickStale: boolean;
    freshness: OperationalFreshness<"scheduler">;
  };
  freshness: {
    policyVersion: typeof PRODUCTION_FRESHNESS_POLICY_VERSION;
    evaluatedAt: string;
    operationsOverall: HealthState;
    forecastCoverage: ForecastCoverageFreshness;
    sampleUpcomingFixtureForecasts: FixtureForecastFreshness[];
    note: string;
  };
  persistence: {
    backend: string;
    durable: boolean;
    hydrated: boolean;
    lastHydratedAt: string | null;
    lastHydrateFailedAt: string | null;
    hydrateRefreshFailed: boolean;
    lastFlushAt: string | null;
    mongoConfigured: boolean;
  };
  sources: {
    footballData: boolean;
    apiFootball: boolean;
    officialBaseline: true;
  };
  productionLedger: {
    role: "production";
    totalForecastSnapshots: number;
    settledForecastSnapshots: number;
    unsettledForecastSnapshots: number;
    uniqueFixturesForecast: number;
    uniqueFixturesSettled: number;
    committedForecastSnapshots: number;
    operationalForecastSnapshots: number;
    forecastSnapshotsByStage: Record<string, number>;
  };
  results: {
    lastAttempt: string | null;
    lastSuccess: string | null;
    lastVerifiedAt: string | null;
    lastVerifiedFixtureId: string | null;
    pending: number;
    conflict: number;
    verified: number;
  };
  settlement: {
    scope: "all-tracks";
    persistedSnapshotSettlementRecords: number;
    linkedForecastSnapshotRecords: number;
    inconsistentLinkedSettlementRecords: number;
    orphanSettlementRecords: number;
    successfulSettlementEvents: null;
    eventCountStatus: "unavailable";
    eventCountNote: string;
    corrections: number;
  };
  ratings: {
    modelVersion: string;
    appliedEvents: number;
    lastFixtureId: string | null;
    lastAppliedAt: string | null;
  };
  conflicts: DataConflict[];
  lastError: string | null;
}

export function buildHealthReport(now = new Date()): HealthReport {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const gate = evaluateDataGate(now);
  const season = liveCompetitionSeason();
  const fixtures = liveFixtures();
  const kick = kickoffCertaintyCounts(fixtures);
  const tick = loadOpsTickState();
  const jobs = listJobs();
  const counts = jobCounts(jobs);
  const nextJob = nextScheduledJob(nowIso);
  const ledgerMetrics = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const verifs = loadVerifications();
  const rConflicts = resultConflicts();
  const scheduleRevs = loadScheduleRevisions();
  const ratingEvents = listRatingEvents();
  const corrections = loadSettlementCorrections();

  const fixtureConflicts: DataConflict[] = fixtures
    .filter((f) => f.verificationStatus === "SOURCE_CONFLICT")
    .map((f) => ({
      kind: "fixture-kickoff" as const,
      fixtureId: f.id,
      sources: ["live-sources"],
      detail: "SOURCE_CONFLICT on fixture metadata",
      recordedAt: f.retrievedAt ?? nowIso,
    }));
  const conflicts = [...fixtureConflicts, ...rConflicts];

  const nextConfirmed = fixtures
    .filter((f) => f.kickoffCertainty === "CONFIRMED" && canonicalizeFixtureStatus(f.status) === "SCHEDULED")
    .sort((a, b) => (a.kickoffUtc ?? a.date).localeCompare(b.kickoffUtc ?? b.date))[0];

  const nearMatch = fixtures.some((f) => {
    if (f.kickoffCertainty !== "CONFIRMED") return false;
    const k = Date.parse(f.kickoffUtc ?? f.kickoff ?? "");
    return Number.isFinite(k) && k - nowMs < 48 * HOUR && k > nowMs - 3 * HOUR;
  });
  const schedulerFreshness = evaluateSchedulerFreshness({
    evaluatedAt: nowIso,
    lastAttemptAt: tick.lastTickAt,
    lastSuccessAt: tick.lastSuccessAt,
    cadenceMs: TICK_CADENCE_MS,
    lastError: tick.lastError,
  });
  const fixtureSyncFreshness = evaluateFixtureSyncFreshness({
    evaluatedAt: nowIso,
    lastAttemptAt: tick.lastFixtureSyncAt,
    lastSuccessAt: tick.lastFixtureSyncOkAt,
    cadenceMs: TICK_CADENCE_MS,
    nearMatch,
  });
  const syncStale = fixtureSyncFreshness.status !== "FRESH";
  const tickStale = schedulerFreshness.status !== "FRESH";
  const allLiveSnapshots = listLiveSnapshots({
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    evaluationClass: "LIVE_OOS",
  });
  const upcomingForFreshness = fixtures.filter((fixture) => {
    const kickoff = Date.parse(fixture.kickoffUtc ?? fixture.kickoff ?? "");
    const status = canonicalizeFixtureStatus(fixture.status);
    return (
      Number.isFinite(kickoff) &&
      kickoff > nowMs &&
      status !== "FINISHED" &&
      status !== "POSTPONED" &&
      status !== "CANCELLED" &&
      status !== "ABANDONED"
    );
  });
  const upcomingFixtureForecasts = upcomingForFreshness.map((fixture) =>
    forecastFreshness(
      fixture,
      allLiveSnapshots.filter((snapshot) => snapshot.fixtureId === fixture.id),
      now,
      jobs.filter((job) => job.fixtureId === fixture.id)
    )
  );
  const forecastCoverage = summarizeForecastCoverage(upcomingFixtureForecasts);
  const persist = durableStatus();

  const configuredLiveSources = [
    footballDataConfigured() ? "football-data.org" : null,
    apiFootballConfigured() ? "api-football" : null,
  ].filter((x): x is string => Boolean(x));

  const reasons: string[] = [];
  let overall: HealthState = "HEALTHY";

  if (gate.status === "DATA_BLOCKED") {
    overall = "BLOCKED";
    reasons.push(`DATA_BLOCKED: ${gate.errors.join("; ") || "season data invalid"}`);
  }
  if (conflicts.length) {
    overall = "BLOCKED";
    reasons.push(`${conflicts.length} unresolved source conflict(s)`);
  }
  if (counts.FAILED > 0) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push(`${counts.FAILED} failed prediction job(s)`);
  }
  if (tick.lastError) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push(`last error: ${tick.lastError}`);
  }
  if (syncStale) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push("fixture sync stale");
  }
  if (tickStale) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push("ops tick stale (expected ~5 minute cadence)");
  }

  const soonDefault = fixtures.filter((f) => {
    if (f.kickoffCertainty === "CONFIRMED") return false;
    const k = Date.parse(f.kickoffUtc ?? f.kickoff ?? "");
    return Number.isFinite(k) && k - nowMs < 48 * HOUR && k > nowMs;
  });
  if (soonDefault.length) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push(`${soonDefault.length} fixture(s) inside 48h still not CONFIRMED`);
  }

  const overdueResults = fixtures.filter((f) => {
    const status = canonicalizeFixtureStatus(f.status);
    if (status === "FINISHED" || status === "POSTPONED" || status === "CANCELLED") return false;
    const k = Date.parse(f.kickoffUtc ?? f.kickoff ?? "");
    if (!Number.isFinite(k) || nowMs < k + RESULT_STALE_AFTER_KICKOFF_MS) return false;
    const v = verifs.find((x) => x.fixtureId === f.id);
    return !v || v.status !== "VERIFIED_FINAL";
  });
  if (overdueResults.length) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push(`${overdueResults.length} fixture(s) past kickoff without VERIFIED_FINAL`);
  }

  if (configuredLiveSources.length === 0) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push("no live structured source configured");
  }
  if (isProductionRuntime() && persist.backend === "file") {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push("production ops store is ephemeral (file backend)");
  }
  if (persist.backend === "mongo" && !mongoConfigured()) {
    overall = "BLOCKED";
    reasons.push("Mongo ops store selected but MONGODB_URI is missing");
  }
  if (persist.backend !== "file" && (!persist.hydrated || persist.hydrateRefreshFailed)) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push(
      persist.hydrated
        ? "durable ops refresh failed; serving the last verified in-process state"
        : "durable ops state is not hydrated"
    );
  }

  if (overall === "HEALTHY") {
    reasons.push(
      "production operations are healthy: data gate, source, durable store and scheduler are not blocked; fixture forecast coverage is reported separately"
    );
  }

  return {
    overall,
    overallScope: "production_operations",
    reasons,
    ledgerMetrics,
    season: {
      label: season?.season ?? PREMIER_LEAGUE_CURRENT_SEASON,
      status: season?.status ?? null,
      dataVersion: season?.dataVersion ?? null,
      dataReady: gate.status,
      dataReadyReasons: gate.errors,
    },
    fixtureSync: {
      lastAttempt: tick.lastFixtureSyncAt,
      lastSuccess: tick.lastFixtureSyncOkAt,
      stale: syncStale,
      freshness: fixtureSyncFreshness,
      revisionCount: scheduleRevs.length,
      configuredLiveSources,
    },
    kickoff: {
      confirmed: kick.CONFIRMED,
      default: kick.DEFAULT,
      provisional: kick.PROVISIONAL,
      tbd: kick.TBD,
      conflict: fixtures.filter((f) => f.verificationStatus === "SOURCE_CONFLICT").length,
      nextConfirmed: nextConfirmed
        ? {
            fixtureId: nextConfirmed.id,
            kickoffUtc: nextConfirmed.kickoffUtc ?? nextConfirmed.kickoff ?? null,
            home: nextConfirmed.homeSlug,
            away: nextConfirmed.awaySlug,
          }
        : null,
    },
    scheduler: {
      cadenceMs: TICK_CADENCE_MS,
      host: process.env.OPS_SCHEDULER_HOST ?? null,
      jobs: counts,
      activeJobs: counts.PENDING + counts.ELIGIBLE + counts.RUNNING,
      nextJob: nextJob
        ? {
            jobId: nextJob.jobId,
            stage: nextJob.stage,
            fixtureId: nextJob.fixtureId,
            eligibleFrom: nextJob.eligibleFrom,
            target: nextJob.scheduledFor,
            eligibleUntil: nextJob.eligibleUntil,
            kickoff: nextJob.kickoffUtc,
            certainty: fixtures.find((f) => f.id === nextJob.fixtureId)?.kickoffCertainty ?? null,
            status: nextJob.status,
          }
        : null,
      lastTickAt: tick.lastTickAt,
      lastSuccessAt: tick.lastSuccessAt,
      tickStale,
      freshness: schedulerFreshness,
    },
    freshness: {
      policyVersion: PRODUCTION_FRESHNESS_POLICY_VERSION,
      evaluatedAt: nowIso,
      operationsOverall: overall,
      forecastCoverage,
      sampleUpcomingFixtureForecasts: upcomingFixtureForecasts.slice(0, 8),
      note:
        "Operations liveness, fixture forecast stage coverage, fixture metadata sync and observational market freshness are separate scopes. A fresh scheduler can truthfully coexist with a missed fixture stage.",
    },
    persistence: {
      backend: persist.backend,
      durable: persist.durable,
      hydrated: persist.hydrated,
      lastHydratedAt: persist.lastHydratedAt,
      lastHydrateFailedAt: persist.lastHydrateFailedAt,
      hydrateRefreshFailed: persist.hydrateRefreshFailed,
      lastFlushAt: persist.lastFlushAt,
      mongoConfigured: mongoConfigured(),
    },
    sources: {
      footballData: footballDataConfigured(),
      apiFootball: apiFootballConfigured(),
      officialBaseline: true,
    },
    productionLedger: {
      role: "production",
      totalForecastSnapshots: ledgerMetrics.production.totalForecastSnapshots,
      settledForecastSnapshots: ledgerMetrics.production.settledForecastSnapshots,
      unsettledForecastSnapshots: ledgerMetrics.production.unsettledForecastSnapshots,
      uniqueFixturesForecast: ledgerMetrics.production.uniqueFixturesForecast,
      uniqueFixturesSettled: ledgerMetrics.production.uniqueFixturesSettled,
      committedForecastSnapshots: ledgerMetrics.production.committedForecastSnapshots,
      operationalForecastSnapshots: ledgerMetrics.production.operationalForecastSnapshots,
      forecastSnapshotsByStage: Object.fromEntries(
        ledgerMetrics.production.byStage.map((row) => [row.stage, row.totalForecastSnapshots])
      ),
    },
    results: {
      lastAttempt: tick.lastResultSyncAt,
      lastSuccess: tick.lastResultSyncOkAt,
      lastVerifiedAt: tick.lastVerifiedResultAt,
      lastVerifiedFixtureId: tick.lastVerifiedFixtureId,
      pending: verifs.filter((v) => v.status === "UNVERIFIED" || v.status === "PROVISIONAL").length,
      conflict: verifs.filter((v) => v.status === "CONFLICT").length,
      verified: verifs.filter((v) => v.status === "VERIFIED_FINAL").length,
    },
    settlement: {
      scope: ledgerMetrics.settlements.scope,
      persistedSnapshotSettlementRecords:
        ledgerMetrics.settlements.persistedSnapshotSettlementRecords,
      linkedForecastSnapshotRecords: ledgerMetrics.settlements.linkedForecastSnapshotRecords,
      inconsistentLinkedSettlementRecords:
        ledgerMetrics.settlements.inconsistentLinkedSettlementRecords,
      orphanSettlementRecords: ledgerMetrics.settlements.orphanSettlementRecords,
      successfulSettlementEvents: ledgerMetrics.settlements.successfulSettlementEvents,
      eventCountStatus: ledgerMetrics.settlements.eventCountStatus,
      eventCountNote: ledgerMetrics.settlements.eventCountNote,
      corrections: corrections.length,
    },
    ratings: {
      modelVersion: PRODUCTION_MODEL_VERSION,
      appliedEvents: ratingEvents.length,
      lastFixtureId: ratingEvents[ratingEvents.length - 1]?.fixtureId ?? null,
      lastAppliedAt: ratingEvents[ratingEvents.length - 1]?.appliedAt ?? null,
    },
    conflicts,
    lastError: tick.lastError,
  };
}
