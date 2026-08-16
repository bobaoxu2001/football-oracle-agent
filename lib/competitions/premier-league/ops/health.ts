/**
 * Operational health. Prefer a visible failure over silent corruption.
 */

import { evaluateDataGate } from "../data-gate";
import { liveCompetitionSeason, liveFixtures } from "../fixture-store";
import { kickoffCertaintyCounts } from "../kickoff-certainty";
import { canonicalizeFixtureStatus } from "../ingest";
import { livePerformanceReport, operationalLiveOosUnion } from "../live-ledger";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import { jobCounts, listJobs } from "./job-ledger";
import { loadOpsTickState, TICK_CADENCE_MS } from "./tick";
import { loadScheduleRevisions } from "./fixture-sync";
import { listRatingEvents } from "./rating-events";
import { loadVerifications, resultConflicts, loadSettlementCorrections } from "./result-feed";
import { nextScheduledJob } from "./scheduler";
import { apiFootballConfigured, footballDataConfigured } from "./sources";
import type { DataConflict, HealthState } from "./types";
import { loadSettlements } from "../settlement";

const HOUR = 3_600_000;
const FIXTURE_SYNC_STALE_NEAR_MATCH_MS = 6 * HOUR;
const FIXTURE_SYNC_STALE_DEFAULT_MS = 36 * HOUR;
const TICK_STALE_MS = 15 * 60 * 1000;
const RESULT_STALE_AFTER_KICKOFF_MS = 6 * HOUR;

export interface HealthReport {
  overall: HealthState;
  reasons: string[];
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
    jobs: ReturnType<typeof jobCounts>;
    nextJob: {
      jobId: string;
      stage: string;
      fixtureId: string;
      eligibleFrom: string;
      status: string;
    } | null;
    lastTickAt: string | null;
    tickStale: boolean;
  };
  liveOos: {
    total: number;
    settled: number;
    unsettled: number;
    committed: number;
    operational: number;
    stages: Record<string, number>;
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
    succeeded: number;
    failed: number;
    pendingOrConflict: number;
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
  const live = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const union = operationalLiveOosUnion(PREMIER_LEAGUE_CURRENT_SEASON);
  const verifs = loadVerifications();
  const rConflicts = resultConflicts();
  const scheduleRevs = loadScheduleRevisions();
  const ratingEvents = listRatingEvents();
  const settlements = loadSettlements().filter((s) => s.evaluationClass === "LIVE_OOS");
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
  const syncAge = tick.lastFixtureSyncOkAt ? nowMs - Date.parse(tick.lastFixtureSyncOkAt) : Infinity;
  const syncStale = syncAge > (nearMatch ? FIXTURE_SYNC_STALE_NEAR_MATCH_MS : FIXTURE_SYNC_STALE_DEFAULT_MS);
  const tickStale = !tick.lastTickAt || nowMs - Date.parse(tick.lastTickAt) > TICK_STALE_MS;

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

  if (nearMatch && configuredLiveSources.length === 0) {
    if (overall !== "BLOCKED") overall = "DEGRADED";
    reasons.push("no live structured result source configured near matchday");
  }

  if (overall === "HEALTHY") {
    reasons.push("data ready, no conflicts, ops loop not blocked");
  }

  return {
    overall,
    reasons,
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
      jobs: counts,
      nextJob: nextJob
        ? {
            jobId: nextJob.jobId,
            stage: nextJob.stage,
            fixtureId: nextJob.fixtureId,
            eligibleFrom: nextJob.eligibleFrom,
            status: nextJob.status,
          }
        : null,
      lastTickAt: tick.lastTickAt,
      tickStale,
    },
    liveOos: {
      total: union.total,
      settled: live.nSettled,
      unsettled: Math.max(0, union.total - live.nSettled),
      committed: union.committed,
      operational: union.operational,
      stages: live.stages,
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
      succeeded: settlements.length,
      failed: 0,
      pendingOrConflict: verifs.filter((v) => v.status === "CONFLICT" || v.status === "PROVISIONAL").length,
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
