/**
 * Discipline / fair-play model (lightweight, team-risk level).
 *
 * Rule basis — FIFA World Cup fair-play conduct points (used as a group-stage
 * tie-breaker after points, goal difference, goals scored and head-to-head):
 *   yellow card                       −1
 *   indirect red (second yellow)      −3
 *   direct red                        −4
 *   yellow + direct red               −5
 * Red cards carry an automatic suspension (at least the next match).
 *
 * TODO(rules-2026): FIFA's 2026 yellow-card ACCUMULATION threshold and the
 * stage at which single yellows are wiped have historically been "2 yellows in
 * separate matches → 1-match ban" with a reset after the quarter-finals, but
 * the 2026 regulations must be confirmed before relying on these values.
 * They are CONFIGURABLE constants here — not invented facts — and the UI labels
 * discipline output as a modeled risk signal.
 *
 * This module does NOT simulate per-player cards. It exposes the official
 * scoring constants (for fair-play tie-break explanations) and a deterministic
 * team-level "Discipline / Suspension Risk" signal derived from stored
 * team_news items (suspension category). News may be demo data — callers must
 * surface the demo label.
 */

import type { TeamNewsItem } from "@/lib/news/types";

// ── Fair-play conduct points (FIFA standard deduction scale) ────────────────
export const YELLOW_CARD_FAIR_PLAY_POINTS = -1;
export const INDIRECT_RED_CARD_FAIR_PLAY_POINTS = -3;
export const DIRECT_RED_CARD_FAIR_PLAY_POINTS = -4;
export const YELLOW_PLUS_DIRECT_RED_FAIR_PLAY_POINTS = -5;

// ── Suspension rules (CONFIGURABLE — confirm against official 2026 regs) ────
/** Yellows in separate matches that trigger a one-match ban. */
export const YELLOW_CARD_SUSPENSION_THRESHOLD = 2;
/** Stage after which single pending yellows are wiped (TODO: confirm for 2026). */
export const YELLOW_CARD_RESET_STAGE = "quarter-final";
/** Minimum matches suspended after a direct red card. */
export const RED_CARD_AUTO_SUSPENSION_MATCHES = 1;

export type DisciplineRiskLevel = "Low" | "Elevated" | "High";

export interface DisciplineRisk {
  level: DisciplineRiskLevel;
  /** Human-readable factor line for the UI / structured factors. */
  detail: string;
  /** True when the underlying signals are demo/sample data. */
  demo: boolean;
}

/**
 * Deterministic team-level discipline risk from stored team_news signals.
 * No live card data exists in this app, so this is a coarse, clearly-labeled
 * signal: suspension items raise risk; otherwise risk is Low.
 */
export function computeDisciplineRisk(items: TeamNewsItem[]): DisciplineRisk {
  const suspensions = items.filter((i) => i.category === "suspension");
  const demo = items.length > 0 && items.every((i) => i.demo);

  if (suspensions.some((s) => s.impactLevel === "high")) {
    return {
      level: "High",
      detail: `A high-impact suspension signal is active (red cards mean an automatic ban of at least ${RED_CARD_AUTO_SUSPENSION_MATCHES} match; ${YELLOW_CARD_SUSPENSION_THRESHOLD} yellows across matches also trigger a one-match ban). Fair-play points (yellow ${YELLOW_CARD_FAIR_PLAY_POINTS}, direct red ${DIRECT_RED_CARD_FAIR_PLAY_POINTS}) can decide tied groups.`,
      demo,
    };
  }
  if (suspensions.length > 0) {
    return {
      level: "Elevated",
      detail: `A suspension-related signal is on file; accumulated yellows (${YELLOW_CARD_SUSPENSION_THRESHOLD} across matches) or a red card would cost a player at least ${RED_CARD_AUTO_SUSPENSION_MATCHES} match and worsen the fair-play tie-breaker score.`,
      demo,
    };
  }
  return {
    level: "Low",
    detail: `No suspension signals on file. Card discipline still matters: fair-play conduct points (yellow ${YELLOW_CARD_FAIR_PLAY_POINTS} … yellow+direct red ${YELLOW_PLUS_DIRECT_RED_FAIR_PLAY_POINTS}) are a late group-stage tie-breaker.`,
    demo,
  };
}
