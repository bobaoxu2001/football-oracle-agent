/**
 * Temporally valid feature layer.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE LEAKAGE RULE
 *
 *   feature_available_at <= prediction_as_of
 *
 * A completed match may inform a prediction only if BOTH hold:
 *
 *   1. resultObservedAt <= asOf   — we actually knew the result by then.
 *   2. kickoffUtc       <  asOf   — the match had actually been played.
 *
 * Condition 1 alone is the formal rule; condition 2 is kept as an independent
 * guard so a provider clock error, a backfill, or a mis-stamped observation
 * cannot make a future match look like admissible history.
 *
 * Additionally the match BEING predicted is always excluded by id, so a result
 * can never feed the features of its own prediction. That is belt and braces:
 * for a genuine pre-kickoff prediction condition 1 already excludes it, but the
 * explicit exclusion means the invariant holds even for a re-computation run
 * after full time — which is exactly when a leak would otherwise be invisible.
 *
 * NOTHING here mutates a stored prediction. Frozen snapshots are immutable by
 * construction (lib/snapshots/store.ts); this module only reads match data.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import type { CanonicalMatch, MatchOutcome } from "./types";
import { isCompletedMatch } from "./types";

export const ROLLING_WINDOWS = [1, 3, 5] as const;
export type RollingWindow = (typeof ROLLING_WINDOWS)[number];

export type Venue = "home" | "away" | "all";

export interface FeatureCutoff {
  /** The prediction's asOf. Nothing known after this instant may be used. */
  asOf: string;
  competition: BigFiveCompetitionId;
  season: string;
  /** The fixture being predicted. Always excluded from its own features. */
  excludeMatchId?: string;
}

/**
 * Filter a match set down to what was legitimately knowable at `asOf`.
 * This is the ONLY entry point features are allowed to read matches through.
 */
export function admissibleMatches(
  matches: CanonicalMatch[],
  cutoff: FeatureCutoff
): CanonicalMatch[] {
  const asOfMs = Date.parse(cutoff.asOf);
  if (!Number.isFinite(asOfMs)) throw new Error(`Invalid feature cutoff asOf: ${cutoff.asOf}`);
  return matches
    .filter((m) => {
      if (m.competition !== cutoff.competition) return false; // competition isolation
      if (m.season !== cutoff.season) return false; // season isolation
      if (cutoff.excludeMatchId && m.canonicalMatchId === cutoff.excludeMatchId) return false;
      if (!isCompletedMatch(m)) return false;
      // (1) we must have known it
      if (!m.resultObservedAt || Date.parse(m.resultObservedAt) > asOfMs) return false;
      // (2) it must actually have been played
      if (!m.kickoffUtc || Date.parse(m.kickoffUtc) >= asOfMs) return false;
      return true;
    })
    .sort((a, b) => (a.kickoffUtc ?? "").localeCompare(b.kickoffUtc ?? ""));
}

/** One team's view of one completed match. */
export interface TeamMatchLine {
  canonicalMatchId: string;
  kickoffUtc: string | null;
  matchday: number | null;
  venue: "home" | "away";
  opponentSlug: string;
  goalsFor: number;
  goalsAgainst: number;
  outcome: "W" | "D" | "L";
  points: number;
  cleanSheet: boolean;
  /** Null when the source does not supply the statistic. Never coerced to 0. */
  expectedGoalsFor: number | null;
  expectedGoalsAgainst: number | null;
  shotsFor: number | null;
  shotsOnTargetFor: number | null;
  shotsAgainst: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

function outcomeFor(venue: "home" | "away", outcome: MatchOutcome): "W" | "D" | "L" {
  if (outcome === "DRAW") return "D";
  const homeWon = outcome === "HOME";
  return (venue === "home") === homeWon ? "W" : "L";
}

/** Project admissible matches into one team's chronological match lines. */
export function teamMatchLines(
  matches: CanonicalMatch[],
  teamSlug: string
): TeamMatchLine[] {
  const out: TeamMatchLine[] = [];
  for (const m of matches) {
    const isHome = m.home.slug === teamSlug;
    const isAway = m.away.slug === teamSlug;
    if (!isHome && !isAway) continue;
    const gf = (isHome ? m.fullTimeHomeGoals : m.fullTimeAwayGoals) as number;
    const ga = (isHome ? m.fullTimeAwayGoals : m.fullTimeHomeGoals) as number;
    const venue: "home" | "away" = isHome ? "home" : "away";
    const res = outcomeFor(venue, m.outcome as MatchOutcome);
    const forStats = isHome ? m.homeStatistics : m.awayStatistics;
    const againstStats = isHome ? m.awayStatistics : m.homeStatistics;
    out.push({
      canonicalMatchId: m.canonicalMatchId,
      kickoffUtc: m.kickoffUtc,
      matchday: m.matchday,
      venue,
      opponentSlug: isHome ? m.away.slug : m.home.slug,
      goalsFor: gf,
      goalsAgainst: ga,
      outcome: res,
      points: res === "W" ? 3 : res === "D" ? 1 : 0,
      cleanSheet: ga === 0,
      expectedGoalsFor: forStats?.expectedGoals ?? null,
      expectedGoalsAgainst: againstStats?.expectedGoals ?? null,
      shotsFor: forStats?.totalShots ?? null,
      shotsOnTargetFor: forStats?.shotsOnTarget ?? null,
      shotsAgainst: againstStats?.totalShots ?? null,
      yellowCards: forStats?.yellowCards ?? null,
      redCards: forStats?.redCards ?? null,
    });
  }
  return out;
}

/**
 * Sum that stays null when NO input carried a value.
 * A null statistic must not silently become 0 in an aggregate.
 */
function sumOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return null;
  return present.reduce((s, v) => s + v, 0);
}

function meanOrNull(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return null;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

export interface RollingForm {
  teamSlug: string;
  window: RollingWindow | "season";
  venue: Venue;
  /** Matches actually available — may be fewer than the window early in a season. */
  matchesCounted: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  pointsPerMatch: number | null;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  cleanSheets: number;
  /** Null when the source supplies no xG (football-data.org TIER_ONE does not). */
  xgFor: number | null;
  xgAgainst: number | null;
  xgDifference: number | null;
  shotsFor: number | null;
  shotsOnTargetFor: number | null;
  shotsAgainst: number | null;
  yellowCards: number | null;
  redCards: number | null;
  /** W/D/L string, most recent LAST. */
  form: string;
}

export function rollingForm(
  lines: TeamMatchLine[],
  teamSlug: string,
  window: RollingWindow | "season",
  venue: Venue = "all"
): RollingForm {
  const scoped = venue === "all" ? lines : lines.filter((l) => l.venue === venue);
  const taken = window === "season" ? scoped : scoped.slice(-window);
  const wins = taken.filter((l) => l.outcome === "W").length;
  const draws = taken.filter((l) => l.outcome === "D").length;
  const losses = taken.filter((l) => l.outcome === "L").length;
  const points = taken.reduce((s, l) => s + l.points, 0);
  const goalsFor = taken.reduce((s, l) => s + l.goalsFor, 0);
  const goalsAgainst = taken.reduce((s, l) => s + l.goalsAgainst, 0);
  const xgFor = sumOrNull(taken.map((l) => l.expectedGoalsFor));
  const xgAgainst = sumOrNull(taken.map((l) => l.expectedGoalsAgainst));
  return {
    teamSlug,
    window,
    venue,
    matchesCounted: taken.length,
    wins,
    draws,
    losses,
    points,
    pointsPerMatch: taken.length ? points / taken.length : null,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    cleanSheets: taken.filter((l) => l.cleanSheet).length,
    xgFor,
    xgAgainst,
    xgDifference: xgFor !== null && xgAgainst !== null ? xgFor - xgAgainst : null,
    shotsFor: sumOrNull(taken.map((l) => l.shotsFor)),
    shotsOnTargetFor: sumOrNull(taken.map((l) => l.shotsOnTargetFor)),
    shotsAgainst: sumOrNull(taken.map((l) => l.shotsAgainst)),
    yellowCards: sumOrNull(taken.map((l) => l.yellowCards)),
    redCards: sumOrNull(taken.map((l) => l.redCards)),
    form: taken.map((l) => l.outcome).join(""),
  };
}

// ── Early-season shrinkage ────────────────────────────────────────────────

/**
 * PRIOR_MATCH_EQUIVALENT — how many matches of current-season evidence the
 * pre-season prior is worth.
 *
 * The blend is the standard conjugate form, deliberately not a magic curve:
 *
 *     w(n) = n / (n + k),   k = PRIOR_MATCH_EQUIVALENT
 *     blended = w(n) · currentSeasonEvidence + (1 − w(n)) · prior
 *
 * k = 8 is inherited from the model's existing early-season policy
 * (rating-core.earlySeasonKScale restores full learning rate after 8 club
 * matches), so the feature layer and the rating layer agree on when a season
 * is "established" rather than inventing a second, conflicting constant.
 *
 * Consequences, all directly testable:
 *   n = 0  → w = 0.000   pure prior
 *   n = 1  → w = 0.111   one 3-0 win moves the blend by ~11%
 *   n = 5  → w = 0.385
 *   n = 8  → w = 0.500   current season and prior weigh equally
 *   n = 19 → w = 0.704
 *   n = 38 → w = 0.826
 *
 * This is what prevents "Arsenal won 3-0 in MW1" from becoming "Arsenal win
 * everything at 85%".
 */
export const PRIOR_MATCH_EQUIVALENT = 8;

export function currentSeasonWeight(
  matchesPlayed: number,
  priorMatchEquivalent = PRIOR_MATCH_EQUIVALENT
): number {
  const n = Math.max(0, matchesPlayed);
  const k = Math.max(1e-9, priorMatchEquivalent);
  return n / (n + k);
}

/**
 * Blend a current-season observation with a prior. Returns the prior exactly
 * when no matches have been played, so a cold start is never a divide-by-zero
 * or an accidental zero.
 */
export function blendWithPrior(
  currentSeasonValue: number | null,
  priorValue: number,
  matchesPlayed: number,
  priorMatchEquivalent = PRIOR_MATCH_EQUIVALENT
): number {
  if (currentSeasonValue === null || matchesPlayed <= 0) return priorValue;
  const w = currentSeasonWeight(matchesPlayed, priorMatchEquivalent);
  return w * currentSeasonValue + (1 - w) * priorValue;
}

// ── Opponent-strength context ─────────────────────────────────────────────

/**
 * Opponent strength, preserved rather than collapsed.
 *
 * A 3-0 against a promoted side is not the same evidence as a 3-0 against a
 * champion. Rather than invent an adjustment coefficient, this records the
 * strength CONTEXT of each result from data already in the ledger, so a later
 * modelling phase can weight it deliberately.
 *
 * `opponentPointsPerMatch` is computed from admissible matches only — the
 * opponent's record as it stood at the cutoff, never their final-season record,
 * which would itself be a leak.
 */
export interface OpponentAdjustedForm {
  teamSlug: string;
  matchesCounted: number;
  /** Mean PPM of the opponents faced, at the cutoff. Null when unknowable. */
  meanOpponentPointsPerMatch: number | null;
  /** Points won per match minus the mean PPM of opponents faced. */
  strengthOfSchedule: number | null;
  perMatch: {
    canonicalMatchId: string;
    opponentSlug: string;
    opponentPointsPerMatch: number | null;
    opponentMatchesPlayed: number;
    points: number;
  }[];
}

export function opponentAdjustedForm(
  admissible: CanonicalMatch[],
  teamSlug: string
): OpponentAdjustedForm {
  const lines = teamMatchLines(admissible, teamSlug);
  const perMatch = lines.map((line) => {
    // The opponent's record from matches admissible at the same cutoff,
    // excluding this fixture so the opponent's rating is not defined by it.
    const oppLines = teamMatchLines(
      admissible.filter((m) => m.canonicalMatchId !== line.canonicalMatchId),
      line.opponentSlug
    );
    const played = oppLines.length;
    const ppm = played ? oppLines.reduce((s, l) => s + l.points, 0) / played : null;
    return {
      canonicalMatchId: line.canonicalMatchId,
      opponentSlug: line.opponentSlug,
      opponentPointsPerMatch: ppm,
      opponentMatchesPlayed: played,
      points: line.points,
    };
  });
  const meanOpp = meanOrNull(perMatch.map((p) => p.opponentPointsPerMatch));
  const ownPpm = lines.length
    ? lines.reduce((s, l) => s + l.points, 0) / lines.length
    : null;
  return {
    teamSlug,
    matchesCounted: lines.length,
    meanOpponentPointsPerMatch: meanOpp,
    strengthOfSchedule: ownPpm !== null && meanOpp !== null ? ownPpm - meanOpp : null,
    perMatch,
  };
}

// ── Assembled feature bundle ──────────────────────────────────────────────

export interface TeamFeatureBundle {
  teamSlug: string;
  competition: BigFiveCompetitionId;
  season: string;
  /** The cutoff these features were computed at. Part of the record. */
  asOf: string;
  /** Newest admissible result used. Proves nothing later leaked in. */
  latestEvidenceKickoff: string | null;
  latestEvidenceObservedAt: string | null;
  matchesPlayed: number;
  /** Weight current-season evidence should carry at this sample size. */
  currentSeasonWeight: number;
  last1: RollingForm;
  last3: RollingForm;
  last5: RollingForm;
  season_: RollingForm;
  home: RollingForm;
  away: RollingForm;
  opponentContext: OpponentAdjustedForm;
}

/**
 * Build every rolling feature for one team at one cutoff.
 * `matches` may be the whole ledger — admissibility is enforced here.
 */
export function buildTeamFeatures(
  matches: CanonicalMatch[],
  teamSlug: string,
  cutoff: FeatureCutoff
): TeamFeatureBundle {
  const admissible = admissibleMatches(matches, cutoff);
  const lines = teamMatchLines(admissible, teamSlug);
  const last = lines[lines.length - 1] ?? null;
  return {
    teamSlug,
    competition: cutoff.competition,
    season: cutoff.season,
    asOf: cutoff.asOf,
    latestEvidenceKickoff: last?.kickoffUtc ?? null,
    latestEvidenceObservedAt:
      admissible.length ? admissible[admissible.length - 1].resultObservedAt : null,
    matchesPlayed: lines.length,
    currentSeasonWeight: currentSeasonWeight(lines.length),
    last1: rollingForm(lines, teamSlug, 1),
    last3: rollingForm(lines, teamSlug, 3),
    last5: rollingForm(lines, teamSlug, 5),
    season_: rollingForm(lines, teamSlug, "season"),
    home: rollingForm(lines, teamSlug, "season", "home"),
    away: rollingForm(lines, teamSlug, "season", "away"),
    opponentContext: opponentAdjustedForm(admissible, teamSlug),
  };
}
