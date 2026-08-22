/**
 * Prediction scheduler / planner.
 *
 * Produces candidate jobs. Does not mutate historical snapshots.
 * Timed stages require kickoffCertainty = CONFIRMED.
 * Missed windows are marked MISSED and never backfilled.
 */

import type { Fixture } from "@/lib/identity/types";
import type { CanonicalPredictionStage } from "@/lib/snapshots/types";
import { canScheduleTimedPrediction } from "../kickoff-certainty";
import { canonicalizeFixtureStatus } from "../ingest";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import type { PredictionJob, TimedStage } from "./types";
import { TIMED_STAGES } from "./types";
import { plannedAsOfIsBeforeKickoff, windowFor, windowState } from "./stage-windows";
import { getJob, jobIdOf, jobsForFixture, listJobs, updateJob, upsertJobs } from "./job-ledger";
import { snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import {
  archiveOperationalLiveOos,
  findScheduledSnapshot,
} from "./operational-archive";

export const MAX_JOB_RETRIES = 3;

export function isTimedSchedulingBlocked(fixture: Fixture): string | null {
  if (fixture.verificationStatus === "SOURCE_CONFLICT") {
    return "SOURCE_CONFLICT: kickoff disagreement; timed stages blocked";
  }
  const status = canonicalizeFixtureStatus(fixture.status);
  if (status === "POSTPONED") return "fixture POSTPONED";
  if (status === "CANCELLED") return "fixture CANCELLED";
  if (status === "ABANDONED") return "fixture ABANDONED";
  if (status === "SUSPENDED") return "fixture SUSPENDED";
  if (status === "FINISHED") return "fixture FINISHED";
  if (fixture.kickoffCertainty !== "CONFIRMED") {
    return `kickoffCertainty=${fixture.kickoffCertainty ?? "missing"} (CONFIRMED required)`;
  }
  if (!fixture.kickoffUtc && !fixture.kickoff) return "missing kickoff timestamp";
  return null;
}

export function buildJob(fixture: Fixture, stage: TimedStage, nowIso: string, modelVersion = PRODUCTION_MODEL_VERSION): PredictionJob {
  const kickoffUtc = (fixture.kickoffUtc ?? fixture.kickoff) as string;
  const w = windowFor(stage, kickoffUtc);
  const blocked = isTimedSchedulingBlocked(fixture);
  const ws = windowState(stage, kickoffUtc, Date.parse(nowIso));
  let status: PredictionJob["status"] = "PENDING";
  if (blocked) status = "BLOCKED";
  else if (ws === "eligible") status = "ELIGIBLE";
  else if (ws === "missed") status = "MISSED";
  return {
    jobId: jobIdOf(fixture.id, stage, kickoffUtc),
    fixtureId: fixture.id,
    season: fixture.season ?? PREMIER_LEAGUE_CURRENT_SEASON,
    stage,
    modelVersion,
    kickoffUtc,
    scheduledFor: w.scheduledFor,
    eligibleFrom: w.eligibleFrom,
    eligibleUntil: w.eligibleUntil,
    plannedAsOf: w.plannedAsOf,
    origin: "scheduled",
    status,
    snapshotKey: null,
    attemptedAt: null,
    completedAt: null,
    failureReason: null,
    failureClass: null,
    retryCount: 0,
    blockedReason: blocked,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function planPredictionJobs(input: {
  fixtures: Fixture[];
  now: string;
  modelVersion?: string;
}): { upserted: PredictionJob[]; cancelled: PredictionJob[] } {
  const nowIso = input.now;
  const nowMs = Date.parse(nowIso);
  const cancelled: PredictionJob[] = [];
  const planned: PredictionJob[] = [];

  for (const fixture of input.fixtures) {
    const existing = jobsForFixture(fixture.id);
    const kickoffUtc = fixture.kickoffUtc ?? fixture.kickoff ?? null;
    const status = canonicalizeFixtureStatus(fixture.status);
    const postponedLike = status === "POSTPONED" || status === "CANCELLED" || status === "ABANDONED";

    for (const job of existing) {
      const kickoffChanged = Boolean(kickoffUtc) && job.kickoffUtc !== kickoffUtc;
      const obsolete =
        (kickoffChanged || postponedLike) &&
        (job.status === "PENDING" || job.status === "ELIGIBLE" || job.status === "BLOCKED" || job.status === "FAILED");
      if (obsolete) {
        const next = updateJob(job.jobId, {
          status: "CANCELLED",
          blockedReason: postponedLike ? `cancelled: ${status}` : "cancelled: kickoff changed",
          updatedAt: nowIso,
        });
        cancelled.push(next);
      }
    }

    if (postponedLike || !kickoffUtc) continue;
    if (fixture.kickoffCertainty !== "CONFIRMED") {
      for (const job of jobsForFixture(fixture.id)) {
        if (["PENDING", "ELIGIBLE", "BLOCKED", "FAILED"].includes(job.status)) {
          cancelled.push(
            updateJob(job.jobId, {
              status: "CANCELLED",
              blockedReason: `cancelled: kickoffCertainty=${fixture.kickoffCertainty ?? "missing"}`,
              updatedAt: nowIso,
            })
          );
        }
      }
    }
    if (fixture.kickoffCertainty !== "CONFIRMED" && fixture.verificationStatus === "SOURCE_CONFLICT") {
      for (const stage of TIMED_STAGES) {
        planned.push(buildJob(fixture, stage, nowIso, input.modelVersion));
      }
      continue;
    }
    if (fixture.kickoffCertainty !== "CONFIRMED") continue;

    for (const stage of TIMED_STAGES) {
      if (!canScheduleTimedPrediction(fixture, stage)) continue;
      const job = buildJob(fixture, stage, nowIso, input.modelVersion);
      const prev = getJob(job.jobId);
      if (prev?.status === "SUCCEEDED" || prev?.status === "MISSED" || prev?.status === "CANCELLED") {
        continue;
      }
      if (prev?.status === "FAILED" && windowState(stage, job.kickoffUtc, nowMs) === "missed") {
        job.status = "MISSED";
      }
      planned.push(job);
    }
  }

  const upserted = upsertJobs(planned);
  return { upserted, cancelled };
}

export function refreshJobStatuses(nowIso: string): PredictionJob[] {
  const nowMs = Date.parse(nowIso);
  const out: PredictionJob[] = [];
  for (const job of listJobs()) {
    if (job.status === "SUCCEEDED" || job.status === "CANCELLED") {
      out.push(job);
      continue;
    }
    if (job.status === "RUNNING") {
      out.push(job);
      continue;
    }
    const ws = windowState(job.stage, job.kickoffUtc, nowMs);
    if (job.status === "MISSED") {
      out.push(job);
      continue;
    }
    if (ws === "missed") {
      out.push(
        updateJob(job.jobId, {
          status: "MISSED",
          failureReason: "window closed without a successful freeze; not backfilled",
          completedAt: nowIso,
          updatedAt: nowIso,
        })
      );
      continue;
    }
    if (job.status === "BLOCKED") {
      out.push(job);
      continue;
    }
    if (ws === "eligible" && job.status !== "FAILED") {
      out.push(updateJob(job.jobId, { status: "ELIGIBLE", updatedAt: nowIso }));
      continue;
    }
    if (ws === "future" && job.status !== "PENDING" && job.status !== "FAILED") {
      out.push(updateJob(job.jobId, { status: "PENDING", updatedAt: nowIso }));
      continue;
    }
    out.push(job);
  }
  return out;
}

export interface FreezeContext {
  homeSlug: string;
  awaySlug: string;
  season: string;
  kickoffUtc: string;
  fixtureId: string;
}

export function executeEligibleJobs(input: {
  fixtures: Fixture[];
  now: string;
  freeze?: typeof freezeScheduledStage;
}): { attempted: number; succeeded: number; failed: number; skipped: number } {
  const freeze = input.freeze ?? freezeScheduledStage;
  const nowIso = input.now;
  const byId = new Map(input.fixtures.map((f) => [f.id, f]));
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const job of listJobs()) {
    if (job.status !== "ELIGIBLE" && !(job.status === "FAILED" && job.retryCount < MAX_JOB_RETRIES)) {
      continue;
    }
    const ws = windowState(job.stage, job.kickoffUtc, Date.parse(nowIso));
    if (ws !== "eligible") {
      skipped += 1;
      continue;
    }
    const fixture = byId.get(job.fixtureId);
    if (!fixture) {
      updateJob(job.jobId, {
        status: "FAILED",
        failureReason: "fixture missing from current store",
        failureClass: "permanent-validation",
        retryCount: job.retryCount + 1,
        attemptedAt: nowIso,
      });
      failed += 1;
      continue;
    }
    const blocked = isTimedSchedulingBlocked(fixture);
    if (blocked) {
      updateJob(job.jobId, { status: "BLOCKED", blockedReason: blocked, updatedAt: nowIso });
      skipped += 1;
      continue;
    }

    const existing = findScheduledSnapshot({
      fixtureId: job.fixtureId,
      stage: job.stage,
      modelVersion: job.modelVersion,
      plannedAsOf: job.plannedAsOf,
    });
    if (existing) {
      updateJob(job.jobId, {
        status: "SUCCEEDED",
        snapshotKey: existing.provenance.uniqueKey,
        completedAt: existing.createdAt,
        updatedAt: nowIso,
      });
      succeeded += 1;
      continue;
    }

    attempted += 1;
    updateJob(job.jobId, { status: "RUNNING", attemptedAt: nowIso, updatedAt: nowIso });
    try {
      const snap = freeze(fixture, job.stage, job.plannedAsOf, nowIso);
      updateJob(job.jobId, {
        status: "SUCCEEDED",
        snapshotKey: snap.provenance.uniqueKey,
        completedAt: nowIso,
        failureReason: null,
        updatedAt: nowIso,
      });
      succeeded += 1;
    } catch (err) {
      // Always FAILED. Terminality is decided elsewhere, on purpose:
      //   • the loop guard above stops retrying once retryCount hits
      //     MAX_JOB_RETRIES, and
      //   • refreshJobStatuses flips a FAILED job to MISSED once its window
      //     closes, which is what makes "never backfilled" true.
      // A closed window must NOT be recorded as anything other than a real
      // failure here, or the miss would be laundered into a success path.
      updateJob(job.jobId, {
        status: "FAILED",
        failureReason: (err as Error).message,
        failureClass: "store-failure",
        retryCount: job.retryCount + 1,
        attemptedAt: nowIso,
        updatedAt: nowIso,
      });
      failed += 1;
    }
  }

  return { attempted, succeeded, failed, skipped };
}

export function freezeScheduledStage(
  fixture: Fixture,
  stage: CanonicalPredictionStage,
  plannedAsOf: string,
  computedAt: string
) {
  if (!canScheduleTimedPrediction(fixture, stage)) {
    throw new Error(
      `Refusing ${stage} for ${fixture.id}: kickoffCertainty=${fixture.kickoffCertainty ?? "missing"}`
    );
  }
  const kickoff = fixture.kickoffUtc ?? fixture.kickoff;
  if (!kickoff) throw new Error(`Refusing ${stage}: missing kickoff`);
  if (!plannedAsOfIsBeforeKickoff(plannedAsOf, kickoff)) {
    throw new Error(`Refusing ${stage}: plannedAsOf ${plannedAsOf} is not < kickoff ${kickoff}`);
  }
  if (Date.parse(computedAt) >= Date.parse(kickoff)) {
    throw new Error(`Refusing ${stage}: computedAt ${computedAt} is not < kickoff ${kickoff}`);
  }
  const snap = snapshotPremierLeagueMatch(fixture.homeSlug, fixture.awaySlug, {
    asOf: plannedAsOf,
    kickoff,
    fixtureId: fixture.id,
    season: fixture.season ?? PREMIER_LEAGUE_CURRENT_SEASON,
    predictionStage: stage,
    evaluationClass: "LIVE_OOS",
    origin: "scheduled",
    computedAt,
    fixtureDataVersion: fixture.sourceId ?? fixture.source ?? undefined,
  });
  archiveOperationalLiveOos([snap]);
  return snap;
}

export function nextScheduledJob(nowIso: string): PredictionJob | null {
  const now = Date.parse(nowIso);
  const future = listJobs()
    .filter((j) => j.status === "PENDING" || j.status === "ELIGIBLE")
    .filter((j) => Date.parse(j.eligibleFrom) >= now || j.status === "ELIGIBLE")
    .sort((a, b) => a.eligibleFrom.localeCompare(b.eligibleFrom));
  return future[0] ?? null;
}
