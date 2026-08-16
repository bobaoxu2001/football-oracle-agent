/**
 * Kickoff certainty — independent of whether a timestamp exists.
 *
 * Official 2026-27 release: weekend/BH default 15:00 UK; midweek default 20:00
 * unless otherwise stated. An explicit non-default slot is CONFIRMED.
 * A conventional default slot is DEFAULT, not a confirmed operational kickoff.
 */

import type { CanonicalPredictionStage } from "@/lib/snapshots/types";
import type { Fixture, KickoffCertainty } from "@/lib/identity/types";

export const KICKOFF_CERTAINTIES = ["CONFIRMED", "PROVISIONAL", "DEFAULT", "TBD"] as const;

export const TIMED_PREDICTION_STAGES: CanonicalPredictionStage[] = [
  "T24H",
  "T2H",
  "T60M",
  "FINAL_PREKICK",
];

/**
 * Classify a time as published in the official PL fixture release.
 *
 * CONFIRMED: 12:30 / 14:00 / 16:30 / 17:30, or a 20:00 that is not the
 * Wednesday midweek default (Friday/Monday/Saturday TV or listed slots).
 * DEFAULT: Saturday/Sunday 15:00 and Wednesday 20:00 conventional slots.
 * TBD: missing time.
 */
export function classifyOfficialKickoffCertainty(date: string, time?: string | null): KickoffCertainty {
  const hhmm = (time ?? "").trim();
  if (!hhmm) return "TBD";
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  if (hhmm === "15:00" && (dow === 0 || dow === 6)) return "DEFAULT";
  if (hhmm === "20:00" && dow === 3) return "DEFAULT"; // Wednesday midweek default
  if (hhmm === "15:00") return "DEFAULT";
  return "CONFIRMED";
}

export function applyKickoffCertainty(fixture: Fixture): Fixture {
  const time = fixture.kickoffLocal?.slice(11, 16) ?? null;
  const certainty =
    fixture.kickoffCertainty ??
    classifyOfficialKickoffCertainty(fixture.date, time);
  return {
    ...fixture,
    scheduledDate: fixture.scheduledDate ?? fixture.date,
    kickoffCertainty: certainty,
  };
}

export function canScheduleTimedPrediction(
  fixture: Pick<Fixture, "kickoffCertainty" | "kickoffUtc" | "kickoff">,
  stage: CanonicalPredictionStage
): boolean {
  if (!TIMED_PREDICTION_STAGES.includes(stage)) return true;
  if (fixture.kickoffCertainty !== "CONFIRMED") return false;
  return Boolean(fixture.kickoffUtc || fixture.kickoff);
}

export function kickoffCertaintyCounts(fixtures: Fixture[]): Record<KickoffCertainty, number> {
  const out: Record<KickoffCertainty, number> = {
    CONFIRMED: 0,
    PROVISIONAL: 0,
    DEFAULT: 0,
    TBD: 0,
  };
  for (const f of fixtures) {
    const c = f.kickoffCertainty ?? "TBD";
    out[c] += 1;
  }
  return out;
}
