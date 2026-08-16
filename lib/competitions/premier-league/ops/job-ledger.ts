/**
 * Prediction job ledger. Operational history for the scheduler.
 */

import type { TimedStage, JobStatus, PredictionJob, FailureClass } from "./types";
import { appendJsonl, readJsonl, rewriteJsonl, unlinkIfExists } from "./jsonl";
import { predictionJobPath } from "./paths";

const g = globalThis as unknown as { __foaJobs?: { byId: Map<string, PredictionJob>; loadedFrom: string | null } };

function mem() {
  if (!g.__foaJobs) g.__foaJobs = { byId: new Map(), loadedFrom: null };
  return g.__foaJobs;
}

export function jobIdOf(fixtureId: string, stage: TimedStage, kickoffUtc: string): string {
  return `${fixtureId}::${stage}::${kickoffUtc}`;
}

function load(): void {
  const file = predictionJobPath();
  const state = mem();
  if (state.loadedFrom === file && state.byId.size > 0) return;
  state.byId.clear();
  state.loadedFrom = file;
  for (const row of readJsonl<PredictionJob>(file)) {
    state.byId.set(row.jobId, row);
  }
}

export function resetJobCache(): void {
  g.__foaJobs = { byId: new Map(), loadedFrom: null };
}

export function clearJobsForTests(): void {
  resetJobCache();
  unlinkIfExists(predictionJobPath());
}

export function listJobs(): PredictionJob[] {
  load();
  return [...mem().byId.values()].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

export function getJob(jobId: string): PredictionJob | null {
  load();
  return mem().byId.get(jobId) ?? null;
}

export function jobsForFixture(fixtureId: string): PredictionJob[] {
  return listJobs().filter((j) => j.fixtureId === fixtureId);
}

function persistAll(jobs: PredictionJob[]): void {
  const state = mem();
  state.byId = new Map(jobs.map((j) => [j.jobId, j]));
  state.loadedFrom = predictionJobPath();
  rewriteJsonl(predictionJobPath(), jobs);
}

export function upsertJob(job: PredictionJob): PredictionJob {
  load();
  const existing = mem().byId.get(job.jobId);
  if (existing && existing.status === job.status && existing.snapshotKey === job.snapshotKey) {
    return existing;
  }
  const next = { ...job, updatedAt: job.updatedAt };
  mem().byId.set(next.jobId, next);
  persistAll([...mem().byId.values()]);
  return next;
}

export function upsertJobs(jobs: PredictionJob[]): PredictionJob[] {
  load();
  let dirty = false;
  for (const job of jobs) {
    const prev = mem().byId.get(job.jobId);
    if (!prev) {
      mem().byId.set(job.jobId, job);
      dirty = true;
      continue;
    }
    // Never revive a terminal status via a planner upsert.
    if (["SUCCEEDED", "MISSED", "CANCELLED"].includes(prev.status)) continue;
    const merged: PredictionJob = {
      ...prev,
      ...job,
      status: prev.status === "RUNNING" || prev.status === "FAILED" ? prev.status : job.status,
      retryCount: prev.retryCount,
      snapshotKey: prev.snapshotKey ?? job.snapshotKey,
      attemptedAt: prev.attemptedAt,
      completedAt: prev.completedAt,
      failureReason: prev.failureReason,
      updatedAt: job.updatedAt,
    };
    if (JSON.stringify(merged) !== JSON.stringify(prev)) {
      mem().byId.set(job.jobId, merged);
      dirty = true;
    }
  }
  if (dirty) persistAll([...mem().byId.values()]);
  return [...mem().byId.values()];
}

export function updateJob(
  jobId: string,
  patch: Partial<PredictionJob>
): PredictionJob {
  load();
  const prev = mem().byId.get(jobId);
  if (!prev) throw new Error(`Unknown job ${jobId}`);
  const next: PredictionJob = { ...prev, ...patch, jobId: prev.jobId, updatedAt: patch.updatedAt ?? new Date().toISOString() };
  mem().byId.set(jobId, next);
  persistAll([...mem().byId.values()]);
  return next;
}

export function markJobFailed(jobId: string, reason: string, failureClass: FailureClass, at: string): PredictionJob {
  const prev = getJob(jobId);
  const retryCount = (prev?.retryCount ?? 0) + 1;
  return updateJob(jobId, {
    status: "FAILED",
    failureReason: reason,
    failureClass,
    retryCount,
    attemptedAt: at,
    updatedAt: at,
  });
}

export function jobCounts(jobs = listJobs()): Record<JobStatus, number> {
  const out: Record<JobStatus, number> = {
    PENDING: 0,
    ELIGIBLE: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    MISSED: 0,
    CANCELLED: 0,
    BLOCKED: 0,
  };
  for (const j of jobs) out[j.status] += 1;
  return out;
}

/** Rewrite-on-upsert is used so status transitions stay a single current row. */
export function appendJobAudit(_job: PredictionJob): void {
  appendJsonl(predictionJobPath() + ".audit", _job);
}
