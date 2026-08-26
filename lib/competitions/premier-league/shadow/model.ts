/**
 * Premier League shadow (challenger) model — `pl-live-v0.3.0-shadow`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RELATIONSHIP TO THE BASELINE
 *
 * The shadow is the production model PLUS one layer, never a reimplementation:
 *
 *   baseline λ  ← walk-forward Elo → Dixon-Coles          (identical code path)
 *   shadow  λ' = λ · attackMultiplier · opponentDefenceMultiplier
 *   both     → matchProbFromGoals(λ, μ, ρ)                (identical ρ, identical grid)
 *
 * With no current-season evidence every multiplier is exactly 1, so the shadow
 * is bit-for-bit the baseline. Every probability difference is therefore
 * attributable to the correction layer alone — which is what makes the paired
 * comparison meaningful.
 *
 * This module NEVER writes to the baseline's snapshots, ratings, or params. It
 * is additive: a separate model version producing separate immutable records.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * COMPETITION-AGNOSTIC BY CONSTRUCTION
 * The math lives in lib/prediction-engine/shadow/current-season-strength.ts and
 * takes only numbers. This file supplies the Premier League's rating provider
 * and params. Instantiating another league later means supplying its provider,
 * not copying this logic. No other league is wired up in this phase.
 */

import { matchProbFromGoals, scorelineGridFromGoals, expectedGoals } from "@/lib/prediction-engine/elo";
import {
  adjustedGoalExpectations,
  currentSeasonStrength,
  neutralStrength,
  type CurrentSeasonStrength,
  type StrengthObservation,
} from "@/lib/prediction-engine/shadow/current-season-strength";
import { loadProductionParams } from "../model-tracks";
import { liveRatingsAsOf } from "../ops/live-ratings";
import { ratingOf } from "../ratings";
import { getClub } from "../clubs";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import type { CanonicalMatch } from "@/lib/match-ledger/types";
import { admissibleMatches } from "@/lib/match-ledger/features";
import { SHADOW_MODEL_VERSION, SHADOW_TRACK } from "./track";

export interface BaselineGoalExpectation {
  homeLambda: number;
  awayLambda: number;
  eloHome: number;
  eloAway: number;
}

/**
 * The baseline model's goal expectations for a fixture at a cutoff.
 *
 * Uses exactly the primitives predictPremierLeagueMatch uses, so "what the
 * baseline expected" is not an approximation of the baseline — it is the
 * baseline.
 */
export function baselineGoalExpectation(
  homeSlug: string,
  awaySlug: string,
  asOf: string
): BaselineGoalExpectation {
  const params = loadProductionParams();
  const state = liveRatingsAsOf(asOf);
  const eloHome = ratingOf(state, homeSlug);
  const eloAway = ratingOf(state, awaySlug);
  return {
    eloHome,
    eloAway,
    homeLambda: expectedGoals(eloHome, eloAway, params.homeAdvantage),
    awayLambda: expectedGoals(eloAway, eloHome, -params.homeAdvantage * params.awayHomeShare),
  };
}

/**
 * Turn a team's admissible completed matches into strength observations.
 *
 * For each match the baseline's expectation is recomputed AS OF THAT KICKOFF —
 * walk-forward, using only ratings that existed before the match. The residual
 * is therefore opponent- and venue-adjusted for free, because λ_expected already
 * encoded the opponent's rating and the home advantage for that fixture.
 */
export function strengthObservationsFor(
  teamSlug: string,
  matches: CanonicalMatch[]
): StrengthObservation[] {
  const out: StrengthObservation[] = [];
  for (const m of matches) {
    const isHome = m.home.slug === teamSlug;
    const isAway = m.away.slug === teamSlug;
    if (!isHome && !isAway) continue;
    if (m.fullTimeHomeGoals === null || m.fullTimeAwayGoals === null || !m.kickoffUtc) continue;
    const expectation = baselineGoalExpectation(m.home.slug, m.away.slug, m.kickoffUtc);
    out.push({
      goalsFor: isHome ? m.fullTimeHomeGoals : m.fullTimeAwayGoals,
      goalsAgainst: isHome ? m.fullTimeAwayGoals : m.fullTimeHomeGoals,
      expectedFor: isHome ? expectation.homeLambda : expectation.awayLambda,
      expectedAgainst: isHome ? expectation.awayLambda : expectation.homeLambda,
    });
  }
  return out;
}

export interface ShadowPredictionInput {
  homeSlug: string;
  awaySlug: string;
  /** Prediction cutoff. Identical to the baseline's asOf for the same stage. */
  asOf: string;
  season?: string;
  /** The fixture being predicted, excluded from its own features. */
  fixtureId?: string;
  /**
   * Canonical ledger matches. Injected rather than loaded so this stays
   * synchronous (the scheduler is synchronous) and directly testable.
   */
  ledgerMatches: CanonicalMatch[];
}

export interface ShadowPrediction {
  modelVersion: string;
  asOf: string;
  homeSlug: string;
  awaySlug: string;
  home: number;
  draw: number;
  away: number;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
  scorelineDistribution: Record<string, number>;
  /** The unmodified baseline probabilities at the same cutoff, for the delta. */
  baseline: {
    home: number;
    draw: number;
    away: number;
    homeExpectedGoals: number;
    awayExpectedGoals: number;
    eloHome: number;
    eloAway: number;
  };
  /** Feature provenance — what evidence this prediction was allowed to see. */
  features: {
    featureCutoff: string;
    /** Ledger matches admissible at the cutoff, across the whole competition. */
    admissibleMatchCount: number;
    homeStrength: CurrentSeasonStrength;
    awayStrength: CurrentSeasonStrength;
    /** Ids of the matches that fed each side. Auditable, not summarised away. */
    homeMatchIds: string[];
    awayMatchIds: string[];
    latestEvidenceKickoff: string | null;
    /** Latest provider observation time among evidence actually consumed. */
    latestEvidenceObservedAt: string | null;
  };
}

/**
 * Produce the shadow prediction for a fixture at a cutoff.
 *
 * LEAKAGE: features come exclusively from admissibleMatches(), which requires
 * resultObservedAt <= asOf AND kickoffUtc < asOf, and excludes `fixtureId`.
 * A fixture can therefore never see its own result, even if this is recomputed
 * long after full time.
 */
export function predictPremierLeagueShadow(input: ShadowPredictionInput): ShadowPrediction {
  const season = input.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const params = loadProductionParams();

  const admissible = admissibleMatches(input.ledgerMatches, {
    asOf: input.asOf,
    competition: "premier-league",
    season,
    excludeMatchId: input.fixtureId,
  });

  const homeMatches = admissible.filter(
    (m) => m.home.slug === input.homeSlug || m.away.slug === input.homeSlug
  );
  const awayMatches = admissible.filter(
    (m) => m.home.slug === input.awaySlug || m.away.slug === input.awaySlug
  );

  const homeStrength = homeMatches.length
    ? currentSeasonStrength(strengthObservationsFor(input.homeSlug, homeMatches))
    : neutralStrength();
  const awayStrength = awayMatches.length
    ? currentSeasonStrength(strengthObservationsFor(input.awaySlug, awayMatches))
    : neutralStrength();

  const base = baselineGoalExpectation(input.homeSlug, input.awaySlug, input.asOf);
  const baselineProb = matchProbFromGoals(base.homeLambda, base.awayLambda, params.dcRho);

  const adjusted = adjustedGoalExpectations({
    baselineHomeLambda: base.homeLambda,
    baselineAwayLambda: base.awayLambda,
    home: homeStrength,
    away: awayStrength,
  });
  const shadowProb = matchProbFromGoals(adjusted.homeLambda, adjusted.awayLambda, params.dcRho);
  const grid = scorelineGridFromGoals(adjusted.homeLambda, adjusted.awayLambda, params.dcRho)
    .slice()
    .sort((a, b) => b.p - a.p);

  return {
    modelVersion: SHADOW_MODEL_VERSION,
    asOf: input.asOf,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    home: shadowProb.winA,
    draw: shadowProb.draw,
    away: shadowProb.winB,
    homeExpectedGoals: adjusted.homeLambda,
    awayExpectedGoals: adjusted.awayLambda,
    scorelineDistribution: Object.fromEntries(
      grid.slice(0, 6).map((g) => [`${g.a}–${g.b}`, g.p])
    ),
    baseline: {
      home: baselineProb.winA,
      draw: baselineProb.draw,
      away: baselineProb.winB,
      homeExpectedGoals: base.homeLambda,
      awayExpectedGoals: base.awayLambda,
      eloHome: base.eloHome,
      eloAway: base.eloAway,
    },
    features: {
      featureCutoff: input.asOf,
      admissibleMatchCount: admissible.length,
      homeStrength,
      awayStrength,
      homeMatchIds: homeMatches.map((m) => m.canonicalMatchId),
      awayMatchIds: awayMatches.map((m) => m.canonicalMatchId),
      latestEvidenceKickoff:
        admissible.length ? admissible[admissible.length - 1].kickoffUtc : null,
      latestEvidenceObservedAt:
        admissible
          .map((match) => match.resultObservedAt)
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1) ?? null,
    },
  };
}

export { SHADOW_MODEL_VERSION, SHADOW_TRACK };

/** Display names, for the comparison view. */
export function shadowFixtureLabel(homeSlug: string, awaySlug: string): string {
  return `${getClub(homeSlug).name} vs ${getClub(awaySlug).name}`;
}
