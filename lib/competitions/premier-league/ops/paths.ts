/**
 * Isolated ops paths. Tests override via env so production evidence is never written.
 */

import path from "node:path";

const ROOT = path.resolve(process.cwd(), "data/processed/premier-league");
const OPS = path.join(ROOT, "ops");

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export function opsDir(): string {
  return env("PL_OPS_DIR", OPS);
}

export function predictionJobPath(): string {
  return env("PL_JOB_STORE_PATH", path.join(opsDir(), "prediction-jobs.jsonl"));
}

export function sourceObservationPath(): string {
  return env("PL_SOURCE_OBS_PATH", path.join(opsDir(), "source-observations.jsonl"));
}

export function scheduleRevisionPath(): string {
  return env("PL_SCHEDULE_REV_PATH", path.join(opsDir(), "fixture-schedule-revisions.jsonl"));
}

export function resultObservationPath(): string {
  return env("PL_RESULT_OBS_PATH", path.join(opsDir(), "result-observations.jsonl"));
}

export function resultVerificationPath(): string {
  return env("PL_RESULT_VERIF_PATH", path.join(opsDir(), "result-verifications.jsonl"));
}

export function ratingEventPath(): string {
  return env("PL_RATING_EVENT_PATH", path.join(opsDir(), "rating-events.jsonl"));
}

export function settlementCorrectionPath(): string {
  return env("PL_SETTLEMENT_CORR_PATH", path.join(opsDir(), "settlement-corrections.jsonl"));
}

export function operationalLiveOosPath(): string {
  return env("PL_OPERATIONAL_LIVE_OOS_PATH", path.join(opsDir(), "live-oos-operational.jsonl"));
}

export function tickStatePath(): string {
  return env("PL_TICK_STATE_PATH", path.join(opsDir(), "tick-state.json"));
}

export function ratingStateSnapshotPath(): string {
  return env("PL_RATING_STATE_PATH", path.join(opsDir(), "rating-state.json"));
}

export function seasonManifestPath(): string {
  return env("PL_SEASON_MANIFEST_PATH", path.join(ROOT, "season-2026-27.json"));
}

export function liveFixturesPath(): string {
  return env("PL_FIXTURES_PATH", path.join(ROOT, "fixtures-2026-27.json"));
}

export function clubSeasonsPath(): string {
  return env("PL_CLUB_SEASONS_PATH", path.join(ROOT, "club-seasons-2026-27.json"));
}

export function fixtureRevisionsPath(): string {
  return env("PL_FIXTURE_REVISIONS_PATH", path.join(ROOT, "fixture-revisions.jsonl"));
}
