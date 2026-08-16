/**
 * Live prediction stages and evaluation-class rules.
 *
 * Stage is time-to-kickoff only. Lineup confirmation is a later phase.
 */

import type { CanonicalPredictionStage, EvaluationClass } from "@/lib/snapshots/types";
import { hoursUntilKickoff, isBeforeKickoff } from "./timezone";

export function stageFromTiming(asOf: string, kickoffUtc: string | null | undefined): CanonicalPredictionStage {
  if (!kickoffUtc) return "PRESEASON";
  if (!isBeforeKickoff(asOf, kickoffUtc)) return "RETROSPECTIVE";
  const hours = hoursUntilKickoff(asOf, kickoffUtc);
  if (hours <= 0.02) return "FINAL_PREKICK"; // ~1 minute
  if (hours <= 1) return "T60M";
  if (hours <= 2) return "T2H";
  if (hours <= 24) return "T24H";
  if (hours <= 24 * 14) return "EARLY";
  return "PRESEASON";
}

/**
 * A snapshot may be labeled LIVE_OOS only if it was actually frozen before kickoff.
 * Anything created at or after kickoff is RETROSPECTIVE (or BACKTEST if historical).
 */
export function evaluationClassFor(input: {
  asOf: string;
  kickoffUtc?: string | null;
  intended?: EvaluationClass;
}): EvaluationClass {
  if (input.intended === "BACKTEST") return "BACKTEST";
  if (input.intended === "RETROSPECTIVE") return "RETROSPECTIVE";
  if (!input.kickoffUtc) {
    return input.intended === "LIVE_OOS" ? "LIVE_OOS" : "RETROSPECTIVE";
  }
  if (!isBeforeKickoff(input.asOf, input.kickoffUtc)) return "RETROSPECTIVE";
  return input.intended ?? "LIVE_OOS";
}

export function assertLiveOosLegal(asOf: string, kickoffUtc: string | null | undefined): void {
  if (!kickoffUtc) return;
  if (!isBeforeKickoff(asOf, kickoffUtc)) {
    throw new Error(
      `Cannot label LIVE_OOS: asOf ${asOf} is not strictly before kickoff ${kickoffUtc}`
    );
  }
}
