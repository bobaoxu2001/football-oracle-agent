/**
 * Reproducible timed-stage windows.
 *
 * All comparisons use UTC instants. Never derive eligibility from a
 * formatted Europe/London string.
 *
 * FINAL_PREKICK is the latest valid Football Oracle snapshot frozen
 * before kickoff with currently available model inputs. It is NOT a
 * lineup-confirmed model. Lineup ingestion is out of scope for 2A.2.
 */

import type { StageWindow, TimedStage } from "./types";
import { TIMED_STAGES } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const STAGE_WINDOWS: Record<TimedStage, StageWindow> = {
  T7D: {
    stage: "T7D",
    targetOffsetMs: -7 * DAY,
    eligibleFromOffsetMs: -7 * DAY,
    eligibleUntilOffsetMs: -7 * DAY + 2 * HOUR,
    meaning:
      "Scheduled seven-day rolling-early freeze using only inputs available at the canonical cutoff.",
  },
  T24H: {
    stage: "T24H",
    targetOffsetMs: -24 * HOUR,
    eligibleFromOffsetMs: -24 * HOUR,
    eligibleUntilOffsetMs: -22 * HOUR,
    meaning: "Scheduled 24-hour pre-kickoff freeze of the current model.",
  },
  T2H: {
    stage: "T2H",
    targetOffsetMs: -2 * HOUR,
    eligibleFromOffsetMs: -2 * HOUR,
    eligibleUntilOffsetMs: -90 * MIN,
    meaning: "Scheduled 2-hour pre-kickoff freeze of the current model.",
  },
  T60M: {
    stage: "T60M",
    targetOffsetMs: -60 * MIN,
    eligibleFromOffsetMs: -60 * MIN,
    eligibleUntilOffsetMs: -45 * MIN,
    meaning: "Scheduled 60-minute pre-kickoff freeze of the current model.",
  },
  FINAL_PREKICK: {
    stage: "FINAL_PREKICK",
    targetOffsetMs: -10 * MIN,
    eligibleFromOffsetMs: -10 * MIN,
    eligibleUntilOffsetMs: -5 * MIN,
    meaning:
      "Latest valid Football Oracle model snapshot frozen before kickoff using currently available inputs. Not a lineup-confirmed model.",
  },
};

export const SCHEDULER_CADENCE_MS = 5 * MIN;
export const FINAL_PREKICK_SAFETY_BUFFER_MS = 5 * MIN;

export function isTimedStage(stage: string): stage is TimedStage {
  return (TIMED_STAGES as readonly string[]).includes(stage);
}

export function kickoffMs(kickoffUtc: string): number {
  const ms = Date.parse(kickoffUtc);
  if (!Number.isFinite(ms)) throw new Error(`Invalid kickoffUtc: ${kickoffUtc}`);
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function windowFor(stage: TimedStage, kickoffUtc: string): {
  scheduledFor: string;
  eligibleFrom: string;
  eligibleUntil: string;
  plannedAsOf: string;
} {
  const k = kickoffMs(kickoffUtc);
  const w = STAGE_WINDOWS[stage];
  return {
    scheduledFor: toIso(k + w.targetOffsetMs),
    eligibleFrom: toIso(k + w.eligibleFromOffsetMs),
    eligibleUntil: toIso(k + w.eligibleUntilOffsetMs),
    plannedAsOf: toIso(k + w.targetOffsetMs),
  };
}

export function stageAtInstant(nowMs: number, kickoffUtc: string): TimedStage | null {
  for (const stage of TIMED_STAGES) {
    const w = STAGE_WINDOWS[stage];
    const k = kickoffMs(kickoffUtc);
    if (nowMs >= k + w.eligibleFromOffsetMs && nowMs <= k + w.eligibleUntilOffsetMs) {
      return stage;
    }
  }
  return null;
}

export function isWithinWindow(stage: TimedStage, kickoffUtc: string, nowMs: number): boolean {
  const w = STAGE_WINDOWS[stage];
  const k = kickoffMs(kickoffUtc);
  return nowMs >= k + w.eligibleFromOffsetMs && nowMs <= k + w.eligibleUntilOffsetMs;
}

export function windowState(
  stage: TimedStage,
  kickoffUtc: string,
  nowMs: number
): "future" | "eligible" | "missed" {
  const w = STAGE_WINDOWS[stage];
  const k = kickoffMs(kickoffUtc);
  if (nowMs < k + w.eligibleFromOffsetMs) return "future";
  if (nowMs > k + w.eligibleUntilOffsetMs) return "missed";
  return "eligible";
}

export function plannedAsOfIsBeforeKickoff(plannedAsOf: string, kickoffUtc: string): boolean {
  return Date.parse(plannedAsOf) < Date.parse(kickoffUtc);
}

export function windowsDoNotOverlap(): boolean {
  const ranges = TIMED_STAGES.map((s) => ({
    a: STAGE_WINDOWS[s].eligibleFromOffsetMs,
    b: STAGE_WINDOWS[s].eligibleUntilOffsetMs,
  }));
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const overlap = ranges[i].a <= ranges[j].b && ranges[j].a <= ranges[i].b;
      if (overlap) return false;
    }
  }
  return true;
}
