/**
 * Model identity surfaced on predictions and the auditor.
 *
 * MODEL_VERSION remains the frozen Phase 1 benchmark string so World Cup
 * auditor / legacy callers do not silently retag. Live Premier League
 * forecasts use PRODUCTION_MODEL_VERSION from model-tracks.ts.
 *
 * Bump a version when prediction *logic* or fitted structural parameters
 * change. A team-rating update after a verified result is model *state*,
 * not a new version.
 */

export const MODEL_VERSION = "pl-baseline-v0.1.0";
export const MODEL_NAME = "Football Oracle — Premier League live + World Cup plugin";

export const WORLD_CUP_MODEL_VERSION = "wc-live-v1.0.0";
