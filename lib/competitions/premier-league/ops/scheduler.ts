/**
 * Prediction scheduler / planner.
 *
 * Produces candidate jobs. Does not mutate historical snapshots.
 * T7D accepts an auditable published schedule; later timed stages require a
 * confirmed kickoff.
 * Missed windows are marked MISSED and never backfilled.
 */

import type { Fixture } from "@/lib/identity/types";
import { canScheduleTimedPrediction } from "../kickoff-certainty";
import { canonicalizeFixtureStatus } from "../ingest";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import type { PredictionJob, TimedStage } from "./types";
import { TIMED_STAGES } from "./types";
import { plannedAsOfIsBeforeKickoff, windowFor, windowState } from "./stage-windows";
import { jobIdOf, listJobs, updateJob, updateJobs, upsertJobs } from "./job-ledger";
import { snapshotPremierLeagueFromFrozenInputs } from "@/lib/prediction-engine/sealed-snapshot";
import {
  archiveOperationalLiveOos,
  findScheduledSnapshot,
  indexScheduledSnapshots,
  type ScheduledSnapshotIndex,
} from "./operational-archive";
import { freezeMatchContext, getFrozenMatchContext } from "./context-snapshots";
import { getSnapshotByKey } from "@/lib/snapshots/store";
import {
  canonicalizePredictionStage,
  snapshotUniqueKey,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import {
  assertForecastInputManifestReferences,
} from "../provenance/manifest";
import { resolveProspectiveForecastInput } from "../provenance/production";

export const MAX_JOB_RETRIES = 3;

function assertExactScheduledContextBinding(input: {
  snapshot: PredictionSnapshot;
  fixture: Fixture;
  stage: TimedStage;
  plannedAsOf: string;
  modelVersion: string;
}): void {
  const { snapshot, fixture, stage, plannedAsOf, modelVersion } = input;
  const kickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  const season = fixture.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const forecastSnapshotKey = snapshotUniqueKey({
    competition: "premier-league",
    season,
    fixtureId: fixture.id,
    modelVersion,
    predictionStage: stage,
    asOf: plannedAsOf,
  });
  const contextId = snapshot.sourceState.contextSnapshotId;
  const context = typeof contextId === "string" ? getFrozenMatchContext(contextId) : null;
  const expectedLineupAvailableAt = context
    ? [context.lineup.home.availableAt, context.lineup.away.availableAt]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null
    : null;
  const championClaimsContextUsage =
    modelVersion === PRODUCTION_MODEL_VERSION &&
    Boolean(
      context &&
      (context.usedInForecastEvidenceIds.length !== 0 ||
        snapshot.sourceState.contextModelUsedEvidenceCount !== 0 ||
        !Array.isArray(snapshot.sourceState.contextUsedInForecastEvidenceIds) ||
        snapshot.sourceState.contextUsedInForecastEvidenceIds.length !== 0)
    );
  const manifest = snapshot.inputManifest;
  const manifestRecords = snapshot.inputManifestRecords;
  if (manifest && manifestRecords) {
    assertForecastInputManifestReferences(manifest, manifestRecords);
  }
  if (
    !kickoff ||
    snapshot.provenance.uniqueKey !== forecastSnapshotKey ||
    snapshot.fixtureId !== fixture.id ||
    snapshot.season !== season ||
    snapshot.modelVersion !== modelVersion ||
    canonicalizePredictionStage(snapshot.predictionStage) !== stage ||
    snapshot.asOf !== plannedAsOf ||
    snapshot.dataCutoff !== plannedAsOf ||
    snapshot.kickoff !== kickoff ||
    snapshot.homeSlug !== fixture.homeSlug ||
    snapshot.awaySlug !== fixture.awaySlug ||
    snapshot.evaluationClass !== "LIVE_OOS" ||
    !context ||
    context.forecastSnapshotKey !== forecastSnapshotKey ||
    context.fixtureId !== fixture.id ||
    context.season !== season ||
    context.homeSlug !== fixture.homeSlug ||
    context.awaySlug !== fixture.awaySlug ||
    context.kickoffAt !== kickoff ||
    context.cutoffAt !== plannedAsOf ||
    snapshot.sourceState.contextSchemaVersion !== context.schemaVersion ||
    snapshot.sourceState.contextSnapshotCutoffAt !== context.cutoffAt ||
    snapshot.sourceState.contextSnapshotGeneratedAt !== context.generatedAt ||
    snapshot.sourceState.contextTemporalRule !== context.temporalRule ||
    snapshot.sourceState.contextEvidenceCount !== context.evidence.length ||
    snapshot.sourceState.contextModelUsedEvidenceCount !== context.usedInForecastEvidenceIds.length ||
    snapshot.sourceState.contextInformationalEvidenceCount !== context.evidence.length - context.usedInForecastEvidenceIds.length ||
    JSON.stringify(snapshot.sourceState.contextUsedInForecastEvidenceIds) !== JSON.stringify(context.usedInForecastEvidenceIds) ||
    snapshot.sourceState.contextLineupStatus !== context.lineup.overall ||
    snapshot.sourceState.contextLineupAvailableAt !== expectedLineupAvailableAt ||
    championClaimsContextUsage ||
    !manifest ||
    !manifestRecords ||
    snapshot.inputManifestId !== manifest.manifestId ||
    manifest.fixtureId !== fixture.id ||
    manifest.forecastStage !== stage ||
    manifest.cutoffAt !== plannedAsOf ||
    manifest.kickoffAtAsKnown !== kickoff ||
    manifest.modelVersion !== modelVersion ||
    manifest.generatedAt !== snapshot.sourceState.computedAt
  ) {
    throw new Error(
      `Refusing ${stage}: existing first-write forecast is not bound to an exact, available context snapshot`
    );
  }
}

export interface CutoffFixtureEvidence {
  fixtureRetrievedAt: string;
  kickoffCertainty: NonNullable<Fixture["kickoffCertainty"]>;
  fixtureDataVersion: string | null;
}

export function isTimedSchedulingBlocked(fixture: Fixture, stage: TimedStage): string | null {
  if (fixture.verificationStatus === "SOURCE_CONFLICT") {
    return "SOURCE_CONFLICT: kickoff disagreement; timed stages blocked";
  }
  const status = canonicalizeFixtureStatus(fixture.status);
  if (status === "POSTPONED") return "fixture POSTPONED";
  if (status === "CANCELLED") return "fixture CANCELLED";
  if (status === "ABANDONED") return "fixture ABANDONED";
  if (status === "SUSPENDED") return "fixture SUSPENDED";
  if (status === "FINISHED") return "fixture FINISHED";
  if (!fixture.kickoffUtc && !fixture.kickoff) return "missing kickoff timestamp";
  if (!canScheduleTimedPrediction(fixture, stage)) {
    const allowed = stage === "T7D" ? "CONFIRMED, PROVISIONAL, or DEFAULT" : "CONFIRMED";
    return `kickoffCertainty=${fixture.kickoffCertainty ?? "missing"} (${allowed} required for ${stage})`;
  }
  return null;
}

function admissibleFixtureEvidence(
  fixture: Fixture,
  stage: TimedStage,
  plannedAsOf: string
): CutoffFixtureEvidence | null {
  if (isTimedSchedulingBlocked(fixture, stage)) return null;
  const retrievedAt = fixture.retrievedAt;
  const retrievedAtMs = Date.parse(retrievedAt ?? "");
  const cutoffMs = Date.parse(plannedAsOf);
  if (!retrievedAt || !Number.isFinite(retrievedAtMs) || retrievedAtMs > cutoffMs) return null;
  return {
    fixtureRetrievedAt: retrievedAt,
    kickoffCertainty: fixture.kickoffCertainty!,
    fixtureDataVersion: fixture.sourceId ?? fixture.source ?? null,
  };
}

function evidenceFromJob(job: PredictionJob | null | undefined): CutoffFixtureEvidence | null {
  if (!job?.cutoffFixtureRetrievedAt || !job.cutoffKickoffCertainty) return null;
  return {
    fixtureRetrievedAt: job.cutoffFixtureRetrievedAt,
    kickoffCertainty: job.cutoffKickoffCertainty,
    fixtureDataVersion: job.cutoffFixtureDataVersion ?? null,
  };
}

function attachEvidence(job: PredictionJob, evidence: CutoffFixtureEvidence | null): void {
  job.cutoffFixtureRetrievedAt = evidence?.fixtureRetrievedAt ?? null;
  job.cutoffKickoffCertainty = evidence?.kickoffCertainty ?? null;
  job.cutoffFixtureDataVersion = evidence?.fixtureDataVersion ?? null;
}

export function buildJob(fixture: Fixture, stage: TimedStage, nowIso: string, modelVersion = PRODUCTION_MODEL_VERSION): PredictionJob {
  const kickoffUtc = (fixture.kickoffUtc ?? fixture.kickoff) as string;
  const w = windowFor(stage, kickoffUtc);
  const blocked = isTimedSchedulingBlocked(fixture, stage);
  const ws = windowState(stage, kickoffUtc, Date.parse(nowIso));
  let status: PredictionJob["status"] = "PENDING";
  if (blocked) status = "BLOCKED";
  else if (ws === "eligible") status = "ELIGIBLE";
  else if (ws === "missed") status = "MISSED";
  const job: PredictionJob = {
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
    cutoffFixtureRetrievedAt: null,
    cutoffKickoffCertainty: null,
    cutoffFixtureDataVersion: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  attachEvidence(job, admissibleFixtureEvidence(fixture, stage, w.plannedAsOf));
  return job;
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
  const currentJobs = listJobs();
  const jobsById = new Map(currentJobs.map((job) => [job.jobId, job]));
  const jobsByFixture = new Map<string, PredictionJob[]>();
  for (const job of currentJobs) {
    const fixtureJobs = jobsByFixture.get(job.fixtureId) ?? [];
    fixtureJobs.push(job);
    jobsByFixture.set(job.fixtureId, fixtureJobs);
  }
  let scheduledSnapshots: ScheduledSnapshotIndex | null = null;

  for (const fixture of input.fixtures) {
    const existing = jobsByFixture.get(fixture.id) ?? [];
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
        jobsById.set(next.jobId, next);
        cancelled.push(next);
      }
    }

    if (postponedLike || !kickoffUtc) continue;

    for (const stage of TIMED_STAGES) {
      const job = buildJob(fixture, stage, nowIso, input.modelVersion);
      const prev = jobsById.get(job.jobId);
      if (prev?.status === "SUCCEEDED" || prev?.status === "MISSED") {
        continue;
      }
      if (prev?.status === "CANCELLED" && job.status === "BLOCKED") {
        continue;
      }

      if (prev) job.createdAt = prev.createdAt;
      const evidence = [evidenceFromJob(prev), evidenceFromJob(job)]
        .filter((value): value is CutoffFixtureEvidence => Boolean(value))
        .sort((a, b) => a.fixtureRetrievedAt.localeCompare(b.fixtureRetrievedAt))
        .at(-1) ?? null;
      attachEvidence(job, evidence);

      const existingSnapshot = findScheduledSnapshot({
        fixtureId: job.fixtureId,
        stage,
        modelVersion: job.modelVersion,
        plannedAsOf: job.plannedAsOf,
      }, scheduledSnapshots ??= indexScheduledSnapshots());
      if (existingSnapshot) {
        try {
          assertExactScheduledContextBinding({
            snapshot: existingSnapshot,
            fixture,
            stage,
            plannedAsOf: job.plannedAsOf,
            modelVersion: job.modelVersion,
          });
        } catch (error) {
          const failureReason = error instanceof Error ? error.message : String(error);
          if (prev) {
            updateJob(prev.jobId, {
              status: "FAILED",
              failureReason,
              failureClass: "permanent-validation",
              blockedReason: null,
              updatedAt: nowIso,
            });
            continue;
          }
          job.status = "FAILED";
          job.failureReason = failureReason;
          job.failureClass = "permanent-validation";
          job.blockedReason = null;
          planned.push(job);
          continue;
        }
        if (prev) {
          updateJob(prev.jobId, {
            status: "SUCCEEDED",
            snapshotKey: existingSnapshot.provenance.uniqueKey,
            completedAt: existingSnapshot.createdAt,
            failureReason: null,
            blockedReason: null,
            updatedAt: nowIso,
          });
          continue;
        }
        job.status = "SUCCEEDED";
        job.snapshotKey = existingSnapshot.provenance.uniqueKey;
        job.completedAt = existingSnapshot.createdAt;
        job.blockedReason = null;
        planned.push(job);
        continue;
      }

      const plannedAsOfMs = Date.parse(job.plannedAsOf);
      const firstSeenAfterCutoff = !prev && nowMs > plannedAsOfMs;
      const blockedAfterCutoff = Boolean(job.blockedReason) && nowMs > plannedAsOfMs;
      const missingCutoffEvidenceAfterCutoff = !evidence && nowMs > plannedAsOfMs;
      if (firstSeenAfterCutoff || blockedAfterCutoff || missingCutoffEvidenceAfterCutoff) {
        job.status = "MISSED";
        job.failureReason = firstSeenAfterCutoff
          ? "stage cutoff passed before job was planned; not backfilled"
          : blockedAfterCutoff
            ? `${job.blockedReason}; stage cutoff passed while blocked; not backfilled`
            : `no cutoff-admissible fixture evidence exists for ${job.plannedAsOf}; not backfilled`;
        job.completedAt = nowIso;
        planned.push(job);
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
  const jobs = listJobs();
  const patches: Array<{ jobId: string; patch: Partial<PredictionJob> }> = [];
  for (const job of jobs) {
    if (job.status === "SUCCEEDED" || job.status === "CANCELLED") {
      continue;
    }
    if (job.status === "RUNNING") {
      continue;
    }
    const ws = windowState(job.stage, job.kickoffUtc, nowMs);
    if (job.status === "MISSED") {
      continue;
    }
    if (ws === "missed") {
      patches.push({
        jobId: job.jobId,
        patch: {
          status: "MISSED",
          failureReason: "window closed without a successful freeze; not backfilled",
          completedAt: nowIso,
          updatedAt: nowIso,
        },
      });
      continue;
    }
    if (job.status === "BLOCKED") {
      continue;
    }
    if (ws === "eligible" && job.status !== "FAILED") {
      patches.push({
        jobId: job.jobId,
        patch: { status: "ELIGIBLE", updatedAt: nowIso },
      });
      continue;
    }
    if (ws === "future" && job.status !== "PENDING" && job.status !== "FAILED") {
      patches.push({
        jobId: job.jobId,
        patch: { status: "PENDING", updatedAt: nowIso },
      });
    }
  }
  const changed = new Map(updateJobs(patches).map((job) => [job.jobId, job]));
  return jobs.map((job) => changed.get(job.jobId) ?? job);
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
  let scheduledSnapshots: ScheduledSnapshotIndex | null = null;

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
    const currentKickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
    if (currentKickoff !== job.kickoffUtc) {
      updateJob(job.jobId, {
        status: "CANCELLED",
        blockedReason: "cancelled: kickoff changed before freeze",
        completedAt: nowIso,
        updatedAt: nowIso,
      });
      skipped += 1;
      continue;
    }
    const blocked = isTimedSchedulingBlocked(fixture, job.stage);
    if (blocked) {
      updateJob(job.jobId, { status: "BLOCKED", blockedReason: blocked, updatedAt: nowIso });
      skipped += 1;
      continue;
    }
    const cutoffEvidence = evidenceFromJob(job);
    if (!cutoffEvidence) {
      updateJob(job.jobId, {
        status: "MISSED",
        failureReason: `no cutoff-admissible fixture evidence exists for ${job.plannedAsOf}; not backfilled`,
        failureClass: "permanent-validation",
        completedAt: nowIso,
        updatedAt: nowIso,
      });
      skipped += 1;
      continue;
    }

    const existing = findScheduledSnapshot({
      fixtureId: job.fixtureId,
      stage: job.stage,
      modelVersion: job.modelVersion,
      plannedAsOf: job.plannedAsOf,
    }, scheduledSnapshots ??= indexScheduledSnapshots());
    if (existing) {
      attempted += 1;
      try {
        assertExactScheduledContextBinding({
          snapshot: existing,
          fixture,
          stage: job.stage,
          plannedAsOf: job.plannedAsOf,
          modelVersion: job.modelVersion,
        });
        updateJob(job.jobId, {
          status: "SUCCEEDED",
          snapshotKey: existing.provenance.uniqueKey,
          completedAt: existing.createdAt,
          failureReason: null,
          blockedReason: null,
          updatedAt: nowIso,
        });
        succeeded += 1;
      } catch (error) {
        updateJob(job.jobId, {
          status: "FAILED",
          failureReason: error instanceof Error ? error.message : String(error),
          failureClass: "permanent-validation",
          retryCount: job.retryCount + 1,
          attemptedAt: nowIso,
          updatedAt: nowIso,
        });
        failed += 1;
      }
      continue;
    }

    attempted += 1;
    updateJob(job.jobId, { status: "RUNNING", attemptedAt: nowIso, updatedAt: nowIso });
    try {
      const snap = freeze(fixture, job.stage, job.plannedAsOf, nowIso, cutoffEvidence);
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
  stage: TimedStage,
  plannedAsOf: string,
  computedAt: string,
  suppliedEvidence?: CutoffFixtureEvidence
) {
  const evidence = suppliedEvidence ?? admissibleFixtureEvidence(fixture, stage, plannedAsOf);
  const evidencedFixture = evidence
    ? {
        ...fixture,
        kickoffCertainty: evidence.kickoffCertainty,
        retrievedAt: evidence.fixtureRetrievedAt,
      }
    : fixture;
  if (!evidence || !canScheduleTimedPrediction(evidencedFixture, stage)) {
    throw new Error(
      `Refusing ${stage} for ${fixture.id}: no cutoff-admissible fixture evidence`
    );
  }
  const kickoff = fixture.kickoffUtc ?? fixture.kickoff;
  if (!kickoff) throw new Error(`Refusing ${stage}: missing kickoff`);
  const plannedAsOfMs = Date.parse(plannedAsOf);
  const computedAtMs = Date.parse(computedAt);
  const kickoffAtMs = Date.parse(kickoff);
  if (!Number.isFinite(plannedAsOfMs) || !Number.isFinite(computedAtMs) || !Number.isFinite(kickoffAtMs)) {
    throw new Error(`Refusing ${stage}: invalid cutoff, generation, or kickoff timestamp`);
  }
  if (!plannedAsOfIsBeforeKickoff(plannedAsOf, kickoff)) {
    throw new Error(`Refusing ${stage}: plannedAsOf ${plannedAsOf} is not < kickoff ${kickoff}`);
  }
  if (computedAtMs < plannedAsOfMs) {
    throw new Error(`Refusing ${stage}: computedAt ${computedAt} is before cutoff ${plannedAsOf}`);
  }
  if (computedAtMs >= kickoffAtMs) {
    throw new Error(`Refusing ${stage}: computedAt ${computedAt} is not < kickoff ${kickoff}`);
  }
  const fixtureRetrievedMs = Date.parse(evidence.fixtureRetrievedAt);
  if (!Number.isFinite(fixtureRetrievedMs)) {
    throw new Error(`Refusing ${stage}: fixture retrieval timestamp is missing or invalid`);
  }
  if (fixtureRetrievedMs > plannedAsOfMs) {
    throw new Error(
      `Refusing ${stage}: fixture evidence ${evidence.fixtureRetrievedAt} is after cutoff ${plannedAsOf}`
    );
  }
  const season = fixture.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const snapshotKey = {
    competition: "premier-league",
    season,
    fixtureId: fixture.id,
    modelVersion: PRODUCTION_MODEL_VERSION,
    predictionStage: stage,
    asOf: plannedAsOf,
  } as const;
  const forecastSnapshotKey = snapshotUniqueKey(snapshotKey);
  const existing = getSnapshotByKey(snapshotKey);
  if (existing) {
    assertExactScheduledContextBinding({
      snapshot: existing,
      fixture,
      stage,
      plannedAsOf,
      modelVersion: PRODUCTION_MODEL_VERSION,
    });
    archiveOperationalLiveOos([existing]);
    return existing;
  }
  const resolved = resolveProspectiveForecastInput({
    fixtureId: fixture.id,
    stage,
    cutoffAt: plannedAsOf,
    generatedAt: computedAt,
  });
  if (
    resolved.references.fixtureRevision.homeSlug !== fixture.homeSlug ||
    resolved.references.fixtureRevision.awaySlug !== fixture.awaySlug ||
    resolved.references.fixtureRevision.kickoffAt !== kickoff
  ) {
    throw new Error(
      `Refusing ${stage}: current fixture does not match the cutoff-selected immutable revision`
    );
  }
  const context = freezeMatchContext({
    season,
    fixtureId: fixture.id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffAt: kickoff,
    cutoffAt: plannedAsOf,
    generatedAt: resolved.manifest.generatedAt,
    forecastSnapshotKey,
    // No structured Premier League availability/lineup provider is currently
    // configured. Empty is truthful; present-day news is never backfilled.
    evidence: [],
  }).snapshot;
  const snap = snapshotPremierLeagueFromFrozenInputs({
    resolved,
    contextSnapshot: context,
  });
  assertExactScheduledContextBinding({
    snapshot: snap,
    fixture,
    stage,
    plannedAsOf,
    modelVersion: PRODUCTION_MODEL_VERSION,
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
