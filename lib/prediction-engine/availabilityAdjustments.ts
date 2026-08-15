/**
 * Squad-availability Elo adjustments — the "confirmed injuries / withdrawals"
 * layer that feeds the `squadStabilityAdjustment` slot in EloBreakdown.
 *
 * WHY THIS EXISTS, separate from ratings.ts and ratingUpdates.ts:
 *   • ratings.ts          — base May-2026 calibration (frozen).
 *   • ratingUpdates.ts    — deltas the model LEARNS from completed RESULTS.
 *   • this module         — a manual, sourced, CAPPED adjustment for squad news
 *                           that the results haven't priced in yet (a key player
 *                           ruled out, a captain withdrawing, etc.).
 *
 * Design rules (kept deliberately conservative so news can never dominate the
 * calibrated model):
 *   • Each entry is a single, real, SOURCED availability change.
 *   • Two ways to size the Elo hit (see entryDelta):
 *       (a) an explicit signed `delta` (legacy / when no clean value read), or
 *       (b) VALUE-DRIVEN — from the absent player's market value RELATIVE to
 *           his replacement, a role weight, and how completely he is out.
 *     (b) is the upgrade asked for on 16 June: the hit should reflect the value
 *     of the player actually missing from the XI AND squad depth (a thin bench
 *     hurts far more than a deep one), not a flat per-name guess. Losing a €60m
 *     centre-back who is replaced by a €10m squad player is a real structural
 *     hole; losing a €200m forward who is replaced by another €70m starter and
 *     is himself fit for cameo minutes is much less.
 *   • A team's entries are summed, then CLAMPED to ±SQUAD_STABILITY_CAP.
 *   • Long-standing absences already reflected in the May calibration get a
 *     small delta on purpose — we do not double-penalise the base rating.
 *
 * The effective rating the engine simulates with is:
 *     getEffectiveRating = getUpdatedRating (base + results) + availability
 *                          + confederation form
 *   …and, at FIXTURE level only, a tactical-matchup nudge (tacticalMatchups.ts).
 *
 * Editing: add/remove entries below and redeploy. Keep `source` populated — the
 * UI labels this as a manually-curated, sourced signal, never a live feed.
 * Market values are transfermarkt-style €m estimates, documented per entry.
 *
 * Last updated: 2026-07-17 — FINAL-WEEK recovery pass: Nico Williams and
 * Yeremy Pino are BOTH back for the final (Williams fit but short of full
 * match sharpness after the adductor layoff; Pino back in full training, the
 * feared collarbone break never materialised) — per the recovery convention
 * their fractionOut is REDUCED (1 → 0.25), not deleted, mirroring the Yamal
 * treatment. Sourced from the 16 Jul Forbes/Yahoo Spain final preview.
 * ── Prior 2026-07-02 — Spain/Austria R32 squad news: Nico Williams OUT
 * (right-adductor vs Uruguay, ~2 weeks) and Yeremy Pino OUT (shoulder sprain)
 * — the compounding detail is that Pino is Williams' natural replacement, so
 * the flank drop-off is priced as squad-option, not like-for-like; Lamine
 * Yamal's cameo discount REDUCED (0.3 → 0.15 fractionOut) now he is starting
 * and scoring again, though still minute-managed after the April hamstring;
 * Austria wing-back Phillipp Mwene ruled out (Rangnick presser). All sourced
 * from the 1–2 July match reports / pressers cited per entry.
 */

import { getUpdatedRating } from "./ratingUpdates";
import { getConfederationDelta } from "@/lib/competitions/world-cup/confederationForm";

/**
 * Max absolute Elo a team's accumulated availability signal may move it.
 * Raised from 40 → 55 on 16 June to give the (now value-weighted) injury signal
 * more room — a genuinely gutted line-up should be able to move the needle more
 * than the old flat cap allowed, while still never dominating the base model.
 */
export const SQUAD_STABILITY_CAP = 55;

/** Elo points charged per €m of NET value lost from the XI (value-driven hits). */
export const VALUE_TO_ELO = 0.3;

/**
 * Role weight on the value-driven hit. A hole in the spine (keeper / centre-
 * back) is more structurally costly than the same € value missing further
 * forward, where attacking output is more readily redistributed.
 */
export const ROLE_WEIGHTS: Record<PlayerRole, number> = {
  goalkeeper: 1.15,
  defense: 1.05,
  midfield: 1.0,
  attack: 1.0,
};

export type PlayerRole = "goalkeeper" | "defense" | "midfield" | "attack";

export interface AvailabilityAdjustment {
  /** Canonical team slug (see world-cup-2026-groups.ts). */
  team: string;
  /** Real player affected. */
  player: string;
  /**
   * Explicit signed Elo delta (negative = weaker). When present it WINS over
   * the value-driven formula — used for legacy entries / cases without a clean
   * value read. Leave it off to compute the hit from the value fields below.
   */
  delta?: number;
  /** Absent player's market value (€m) — drives the value-based hit. */
  marketValueOut?: number;
  /** Value (€m) of the man who actually replaces him (squad depth). */
  replacementValue?: number;
  /** Pitch role, weights the structural cost (default "midfield"). */
  role?: PlayerRole;
  /** How completely he is out: 1 = ruled out, 0.5 = doubtful / cameo only. */
  fractionOut?: number;
  /** Short human-readable reason (rendered in the model factor). */
  reason: string;
  /** Where the news came from. */
  source: string;
  /** YYYY-MM-DD the change was confirmed. */
  date: string;
}

/**
 * Elo hit for a single entry. Explicit `delta` wins; otherwise it is derived
 * from market value lost relative to the replacement, role weight and how
 * completely the player is out. A loss can never make a team stronger (the net
 * value gap is floored at 0), so this only ever weakens a side.
 */
export function entryDelta(a: AvailabilityAdjustment): number {
  if (typeof a.delta === "number") return a.delta;
  if (typeof a.marketValueOut === "number") {
    const replacement = a.replacementValue ?? 0;
    const role = ROLE_WEIGHTS[a.role ?? "midfield"];
    const frac = a.fractionOut ?? 1;
    const netValue = Math.max(0, a.marketValueOut - replacement);
    return Math.round(-VALUE_TO_ELO * role * frac * netValue);
  }
  return 0;
}

/**
 * Confirmed availability changes, newest first within a team.
 * Magnitudes are a transparent estimate, not a precise medical/tactical model.
 */
export const AVAILABILITY_ADJUSTMENTS: AvailabilityAdjustment[] = [
  // ── Japan ──────────────────────────────────────────────────────────────
  {
    team: "japan",
    player: "Kaoru Mitoma",
    delta: -15,
    reason: "Best attacker — left out of the 26-man squad with a hamstring injury",
    source: "Al Jazeera",
    date: "2026-05-15",
  },
  {
    team: "japan",
    player: "Wataru Endo",
    delta: -12,
    reason:
      "Captain & midfield anchor withdrew (foot injury) and retired from the national team; replaced by Shuto Machino",
    source: "ESPN",
    date: "2026-06-12",
  },
  {
    team: "japan",
    player: "Takumi Minamino",
    delta: -3,
    reason:
      "Torn ACL (Dec 2025) — long-term absence, already largely reflected in the May calibration",
    source: "ESPN",
    date: "2025-12-28",
  },

  // ── Germany ────────────────────────────────────────────────────────────
  {
    team: "germany",
    player: "Kai Havertz",
    delta: -6,
    reason:
      "Expected to miss the opening fixtures per Völler — short-term, group-stage only",
    source: "FotMob",
    date: "2026-06-12",
  },
  {
    team: "germany",
    player: "Lennart Karl",
    delta: -2,
    reason:
      "Torn muscle in training, out of the tournament; replaced by Assan Ouédraogo (fringe squad impact)",
    source: "ESPN",
    date: "2026-06-06",
  },

  // ── Spain ────────────────────────────────────────────────────────────────
  {
    team: "spain",
    player: "Lamine Yamal",
    marketValueOut: 200,
    replacementValue: 70,
    role: "attack",
    fractionOut: 0.15, // UPDATED 2 Jul: back starting and scoring (goal vs Saudi Arabia) but still minute-managed after the April hamstring — 141 minutes across the three group games, subbed at half-time
    reason:
      "Best 1v1 unlocker back in the XI but still minute-managed after the April hamstring (141 group-stage minutes, one goal) — reduced from the group-stage cameo discount, not yet zeroed",
    source: "Reuters / VAVEL (R32 preview)",
    date: "2026-07-02",
  },
  {
    team: "spain",
    player: "Nico Williams",
    marketValueOut: 70,
    replacementValue: 40,
    role: "attack",
    fractionOut: 0.25, // UPDATED 17 Jul: back in the fray ahead of the final — fit and available but described as some way short of full match sharpness after the ~2-week adductor layoff, so a residual discount stays (recovery convention: reduce, don't delete)
    reason:
      "Starting left winger back available for the final after the right-adductor injury (vs Uruguay, 30 Jun) but short of full match sharpness — residual discount, no longer a full absence",
    source: "Forbes / Yahoo Sports (Spain final preview, 16 Jul)",
    date: "2026-07-16",
  },
  {
    team: "spain",
    player: "Yeremy Pino",
    marketValueOut: 30,
    replacementValue: 20,
    role: "attack",
    fractionOut: 0.25, // UPDATED 17 Jul: back in full training before the final — the feared collarbone break never materialised and the shoulder injury proved less serious; rotation option restored, small residual discount for zero recent minutes
    reason:
      "Rotation winger back in full training ahead of the final (shoulder injury less serious than first feared) — flank depth behind Williams restored, small residual discount for match rust",
    source: "Forbes / Yahoo Sports (Spain final preview, 16 Jul)",
    date: "2026-07-16",
  },

  // ── Austria ─────────────────────────────────────────────────────────────
  {
    team: "austria",
    player: "Phillipp Mwene",
    marketValueOut: 8,
    replacementValue: 3,
    role: "defense",
    fractionOut: 1, // ruled out injured for the Spain R32 tie — Rangnick confirmed at his presser
    reason:
      "Wing-back ruled out injured for the Spain tie (Rangnick presser: enough options to cover, but a starter is a starter)",
    source: "bdnews24 (Rangnick press conference)",
    date: "2026-07-01",
  },

  // ── Uruguay ──────────────────────────────────────────────────────────────
  {
    team: "uruguay",
    player: "Ronald Araújo",
    marketValueOut: 65,
    replacementValue: 10,
    role: "defense",
    fractionOut: 1, // calf tear — left out of the squad entirely
    reason:
      "First-choice centre-back ruled out (calf tear, left the squad) — replaced by a far cheaper option, a real hole in the spine",
    source: "Barca Blaugranes / Sky Sports",
    date: "2026-06-15",
  },
  {
    team: "uruguay",
    player: "José María Giménez",
    marketValueOut: 35,
    replacementValue: 10,
    role: "defense",
    fractionOut: 0.5, // ankle knock — available but benched for the opener
    reason:
      "Second senior centre-back carrying an ankle knock — benched for the opener, compounding the Araújo absence",
    source: "Bolavip / cryptobriefing",
    date: "2026-06-15",
  },

  // ── Ghana (TOURNAMENT-LONG absences — apply to every Ghana match) ────────
  // NB: match-SPECIFIC items (e.g. Partey denied entry to Canada for the Panama
  // game only) live in preMatchIntelligence.ts, not here, so they expire.
  {
    team: "ghana",
    player: "Mohammed Kudus",
    marketValueOut: 60,
    replacementValue: 12,
    role: "attack",
    fractionOut: 1, // quad injury + rehab setback — out of the whole tournament
    reason:
      "Best attacker ruled out of the tournament (quadriceps injury) — a big hole the thin bench can't replace; affects all Ghana games",
    source: "ESPN / Graphic Online",
    date: "2026-06-01",
  },
  {
    team: "ghana",
    player: "Mohammed Salisu",
    marketValueOut: 22,
    replacementValue: 8,
    role: "defense",
    fractionOut: 1, // also out of the tournament through injury
    reason: "First-choice centre-back out of the tournament through injury — weakens the back line for all group games",
    source: "Graphic Online",
    date: "2026-06-01",
  },

  // ── South Africa (MULTI-MATCH suspension — V5.1.2 squad condition) ───────
  {
    team: "south-africa",
    player: "Themba Zwane",
    delta: -8, // FIFA 3-match ban (red card vs Mexico) — main creator out for the rest of the group
    reason:
      "Main creator hit with a 3-match ban (red vs Mexico) — spans the rest of the group; the spine is depleted (compounds the single-match Sithole ban handled in the intel layer)",
    source: "AfricaSoccer (FIFA confirmed)",
    date: "2026-06-16",
  },

  // ── England (TOURNAMENT-LONG) ───────────────────────────────────────────
  {
    team: "england",
    player: "Tino Livramento",
    marketValueOut: 38,
    replacementValue: 25,
    role: "defense",
    fractionOut: 1, // ruled out of the whole tournament (calf); Chalobah called up
    reason:
      "Versatile full-back out for the tournament (calf) — thins England's full-back depth; small net hit given the strong replacement pool (Chalobah in)",
    source: "Goal / Reuters",
    date: "2026-06-16",
  },
];

/** All availability entries on file for a team (newest dates first). */
export function getAvailabilityAdjustments(slug: string): AvailabilityAdjustment[] {
  return AVAILABILITY_ADJUSTMENTS.filter((a) => a.team === slug).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  );
}

/** Net availability Elo delta for a team, summed then clamped to ±cap. */
export function getAvailabilityDelta(slug: string): number {
  const raw = AVAILABILITY_ADJUSTMENTS.filter((a) => a.team === slug).reduce(
    (sum, a) => sum + entryDelta(a),
    0
  );
  return Math.max(-SQUAD_STABILITY_CAP, Math.min(SQUAD_STABILITY_CAP, raw));
}

/**
 * The rating the engine actually simulates with — all capped layers folded in:
 *   base May-2026 calibration
 *   + completed-result deltas      (ratingUpdates.ts)
 *   + squad availability           (this file)
 *   + confederation tournament form (confederationForm.ts)
 */
export function getEffectiveRating(slug: string): number {
  return getUpdatedRating(slug) + getAvailabilityDelta(slug) + getConfederationDelta(slug);
}

/** Metadata for transparent UI labelling. */
export function availabilityMeta(): {
  teams: string[];
  entries: number;
  lastUpdated: string | null;
} {
  const teams = Array.from(new Set(AVAILABILITY_ADJUSTMENTS.map((a) => a.team)));
  const lastUpdated = AVAILABILITY_ADJUSTMENTS.reduce<string | null>(
    (latest, a) => (!latest || a.date > latest ? a.date : latest),
    null
  );
  return { teams, entries: AVAILABILITY_ADJUSTMENTS.length, lastUpdated };
}
