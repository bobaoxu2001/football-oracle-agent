/**
 * Confederation tournament-form signal — the "is a whole region over/under-
 * performing its ratings THIS tournament?" layer.
 *
 * Motivation: the per-team result layer (ratingUpdates.ts) already moves each
 * team that has played. But a systematic confederation effect is extra
 * information. This module measures that effect from completed results and turns
 * it into a small, capped, heavily-shrunk Elo nudge.
 *
 * How it is computed:
 *   1. For each completed result, compute each side's performance residual
 *        residual = actual − expected
 *   2. Average the residual per confederation across all its matches.
 *   3. delta = clamp(SENSITIVITY × avgResidual × shrink(n), ±CAP)
 *        shrink(n) = n / (n + SHRINK_PRIOR)
 *
 * This remains a speculative, deliberately modest prior. The combined results
 * layer keeps it synchronized with the latest settled knockout games.
 */

import { expectedScore } from "@/lib/prediction-engine/elo";
import { getRating, HOME_ADVANTAGE } from "@/lib/prediction-engine/ratings";
import { HOST_SLUGS, getTeam } from "@/lib/seed/world-cup-2026-groups";
import { ALL_MATCH_RESULTS } from "@/lib/seed/recorded-match-results";

/** Elo points per unit of average residual (before shrink/cap). */
export const FORM_SENSITIVITY = 50;
/** Pseudo-count that shrinks small-sample confederations toward zero. */
export const FORM_SHRINK_PRIOR = 4;
/** Max absolute Elo the confederation-form signal may move a team. */
export const FORM_CAP = 20;

export interface ConfederationFormRow {
  confederation: string;
  /** Average (actual − expected) across the confederation's completed matches. */
  avgResidual: number;
  matches: number;
  /** Shrinkage weight applied, n / (n + prior). */
  shrink: number;
  /** Final capped Elo delta applied to every team in the confederation. */
  delta: number;
}

function homeBonus(teamA: string, teamB: string): number {
  if (HOST_SLUGS.has(teamA) && !HOST_SLUGS.has(teamB)) return HOME_ADVANTAGE;
  if (HOST_SLUGS.has(teamB) && !HOST_SLUGS.has(teamA)) return -HOME_ADVANTAGE;
  return 0;
}

function confOf(slug: string): string | null {
  try {
    return getTeam(slug).confederation;
  } catch {
    return null;
  }
}

/** Compute per-confederation form rows from the completed results. */
export function computeConfederationForm(): Record<string, ConfederationFormRow> {
  const sum: Record<string, number> = {};
  const count: Record<string, number> = {};

  const add = (conf: string | null, residual: number) => {
    if (!conf) return;
    sum[conf] = (sum[conf] ?? 0) + residual;
    count[conf] = (count[conf] ?? 0) + 1;
  };

  for (const r of ALL_MATCH_RESULTS) {
    const expA = expectedScore(
      getRating(r.teamA),
      getRating(r.teamB),
      homeBonus(r.teamA, r.teamB)
    );
    const actualA = r.scoreA > r.scoreB ? 1 : r.scoreA < r.scoreB ? 0 : 0.5;
    add(confOf(r.teamA), actualA - expA);
    add(confOf(r.teamB), 1 - actualA - (1 - expA));
  }

  const rows: Record<string, ConfederationFormRow> = {};
  for (const conf of Object.keys(count)) {
    const n = count[conf];
    const avgResidual = sum[conf] / n;
    const shrink = n / (n + FORM_SHRINK_PRIOR);
    const raw = FORM_SENSITIVITY * avgResidual * shrink;
    const delta = Math.max(-FORM_CAP, Math.min(FORM_CAP, Math.round(raw)));
    rows[conf] = { confederation: conf, avgResidual, matches: n, shrink, delta };
  }
  return rows;
}

let _rows: Record<string, ConfederationFormRow> | null = null;
function rows(): Record<string, ConfederationFormRow> {
  if (!_rows) _rows = computeConfederationForm();
  return _rows;
}

/** Confederation-form Elo delta for a team (0 if its region has no results). */
export function getConfederationDelta(slug: string): number {
  const conf = confOf(slug);
  if (!conf) return 0;
  return rows()[conf]?.delta ?? 0;
}

/** All rows, sorted strongest-positive first (for transparent UI labelling). */
export function confederationFormMeta(): ConfederationFormRow[] {
  return Object.values(rows()).sort((a, b) => b.delta - a.delta);
}
