/**
 * Current-season attack/defence correction — the shadow model's only new math.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A MULTIPLIER ON λ, AND NOT A FORM SCORE
 *
 * The production model already turns team strength into Dixon-Coles goal
 * expectations λ_home, λ_away, and its Elo state already updates after every
 * verified result (with a goal-difference multiplier and an early-season K
 * shrink). Bolting an unrelated "form score" onto that would double-count the
 * same evidence through a second, unprincipled channel.
 *
 * Instead this layer asks one question the existing state cannot answer:
 *
 *   Given what the model ITSELF expected each team to score and concede in the
 *   matches they have actually played this season, are they over- or
 *   under-performing that expectation?
 *
 * Because the expectation λ_expected for each past match already embedded that
 * match's opponent strength and home/away venue, the residual is automatically
 * opponent- and venue-adjusted. No separate opponent heuristic is invented.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ESTIMATOR IS THE CONJUGATE POSTERIOR, NOT A TUNED RULE
 *
 * Model the team's true rate multiplier θ (1.0 = "the model is right") as
 *
 *     θ ~ Gamma(κ, κ)          mean 1, κ = strength of the prior
 *     G | θ ~ Poisson(θ · E)   G = goals observed, E = goals the model expected
 *
 * The Gamma is conjugate to the Poisson, so the posterior mean is exactly
 *
 *     θ̂ = (κ + G) / (κ + E)
 *
 * Setting κ = k · (E / n) — that is, "the prior is worth k matches of the same
 * expectation" — this collapses algebraically to
 *
 *     θ̂ = 1 + w(n) · (r − 1),   w(n) = n / (n + k),   r = G / E
 *
 * which is precisely the blend law already documented for the ledger feature
 * layer, and k = 8 is the same 8-match policy as rating-core.earlySeasonKScale.
 * The shrinkage is therefore DERIVED, not asserted: three parts of the codebase
 * agree on when a season is established because they are the same statement.
 *
 * Properties, all directly tested:
 *   • n = 0  → θ̂ = 1 exactly (pure prior; the shadow equals the baseline)
 *   • monotonic in n for a fixed r
 *   • bounded: θ̂ is clamped to [1/ADJUSTMENT_CAP, ADJUSTMENT_CAP]
 *   • deterministic: no randomness, no fitting, no hidden state
 *
 * ══════════════════════════════════════════════════════════════════════════
 * KNOWN CHARACTERISTIC: ZERO COUNTS ARE SCALE-FREE
 *
 * Setting κ = k·(E/n) makes the estimator scale-free in E, which is precisely
 * what collapses it to w(n) = n/(n+k) and keeps it aligned with the existing
 * 8-match policy. The consequence is that when G = 0 the posterior reduces to
 *
 *     θ̂ = κ / (κ + E) = k / (k + n)
 *
 * — independent of E. So a clean sheet produces the SAME defensive multiplier
 * whether it came against a strong or a weak opponent; only the number of
 * matches moves it. Opponent strength does still modulate non-zero counts
 * (attack residuals, and defensive residuals once a goal is conceded).
 *
 * This is a deliberate trade-off, recorded rather than hidden: a fixed κ would
 * let exposure modulate zeroes, but the weight would then depend on total
 * expected goals instead of matches played, breaking the shared 8-match policy
 * and making the shrinkage far less interpretable.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Prior strength in matches. Identical to the ledger feature layer's
 * PRIOR_MATCH_EQUIVALENT and to rating-core's 8-match early-season policy.
 */
export const PRIOR_MATCH_EQUIVALENT = 8;

/**
 * Hard bound on a single-season multiplier.
 *
 * Even at full weight, one season of goals cannot move a team's expected
 * scoring rate by more than ±60%. This is a guard rail against a degenerate
 * sample (e.g. a team whose only match was a 7-0), not a tuned parameter — the
 * shrinkage above is what does the statistical work.
 */
export const ADJUSTMENT_CAP = 1.6;

export interface StrengthObservation {
  /** Goals the team actually scored in this match. */
  goalsFor: number;
  /** Goals the team actually conceded. */
  goalsAgainst: number;
  /** What the BASELINE model expected them to score, as of that kickoff. */
  expectedFor: number;
  /** What the baseline expected them to concede. */
  expectedAgainst: number;
}

export interface CurrentSeasonStrength {
  matchesPlayed: number;
  /** Weight given to current-season evidence: n / (n + k). */
  currentSeasonWeight: number;
  /** Goals scored vs expected. */
  goalsFor: number;
  expectedGoalsFor: number;
  /** Raw unshrunk ratio G/E, or null when E is 0. Reported for transparency. */
  rawAttackRatio: number | null;
  /** Posterior mean multiplier on the team's goal-scoring rate. */
  attackMultiplier: number;
  goalsAgainst: number;
  expectedGoalsAgainst: number;
  rawDefenceRatio: number | null;
  /**
   * Posterior mean multiplier on the rate the team CONCEDES.
   * < 1 means they concede less than the model expected (a better defence).
   */
  defenceMultiplier: number;
  /** True when a bound bit, so the UI/report can say so rather than hide it. */
  attackCapped: boolean;
  defenceCapped: boolean;
}

/** w(n) = n / (n + k). Monotonic, 0 at n = 0, asymptotic to 1. */
export function currentSeasonWeight(
  matchesPlayed: number,
  priorMatchEquivalent = PRIOR_MATCH_EQUIVALENT
): number {
  const n = Math.max(0, matchesPlayed);
  const k = Math.max(1e-9, priorMatchEquivalent);
  return n / (n + k);
}

function clampMultiplier(value: number, cap = ADJUSTMENT_CAP): { value: number; capped: boolean } {
  const lo = 1 / cap;
  if (value > cap) return { value: cap, capped: true };
  if (value < lo) return { value: lo, capped: true };
  return { value, capped: false };
}

/**
 * Gamma-Poisson posterior mean multiplier.
 *
 * Returns exactly 1 when there is no evidence (n = 0) or no expectation to
 * compare against (E = 0), so a cold start is a clean no-op rather than a
 * divide-by-zero or an accidental extreme.
 */
export function posteriorRateMultiplier(
  goals: number,
  expected: number,
  matchesPlayed: number,
  priorMatchEquivalent = PRIOR_MATCH_EQUIVALENT
): { multiplier: number; rawRatio: number | null; capped: boolean } {
  if (matchesPlayed <= 0 || !(expected > 0)) {
    return { multiplier: 1, rawRatio: null, capped: false };
  }
  // κ = k · (E / n): the prior carries k matches of the model's own expectation.
  const kappa = priorMatchEquivalent * (expected / matchesPlayed);
  const posterior = (kappa + goals) / (kappa + expected);
  const clamped = clampMultiplier(posterior);
  return { multiplier: clamped.value, rawRatio: goals / expected, capped: clamped.capped };
}

/**
 * Fold a team's admissible current-season matches into attack/defence
 * multipliers. Pure — the caller is responsible for having already applied the
 * temporal admissibility rule to `observations`.
 */
export function currentSeasonStrength(
  observations: StrengthObservation[],
  priorMatchEquivalent = PRIOR_MATCH_EQUIVALENT
): CurrentSeasonStrength {
  const n = observations.length;
  const goalsFor = observations.reduce((s, o) => s + o.goalsFor, 0);
  const goalsAgainst = observations.reduce((s, o) => s + o.goalsAgainst, 0);
  const expectedFor = observations.reduce((s, o) => s + o.expectedFor, 0);
  const expectedAgainst = observations.reduce((s, o) => s + o.expectedAgainst, 0);

  const attack = posteriorRateMultiplier(goalsFor, expectedFor, n, priorMatchEquivalent);
  const defence = posteriorRateMultiplier(goalsAgainst, expectedAgainst, n, priorMatchEquivalent);

  return {
    matchesPlayed: n,
    currentSeasonWeight: currentSeasonWeight(n, priorMatchEquivalent),
    goalsFor,
    expectedGoalsFor: expectedFor,
    rawAttackRatio: attack.rawRatio,
    attackMultiplier: attack.multiplier,
    goalsAgainst,
    expectedGoalsAgainst: expectedAgainst,
    rawDefenceRatio: defence.rawRatio,
    defenceMultiplier: defence.multiplier,
    attackCapped: attack.capped,
    defenceCapped: defence.capped,
  };
}

/** A team with no admissible matches: the shadow must equal the baseline. */
export function neutralStrength(): CurrentSeasonStrength {
  return {
    matchesPlayed: 0,
    currentSeasonWeight: 0,
    goalsFor: 0,
    expectedGoalsFor: 0,
    rawAttackRatio: null,
    attackMultiplier: 1,
    goalsAgainst: 0,
    expectedGoalsAgainst: 0,
    rawDefenceRatio: null,
    defenceMultiplier: 1,
    attackCapped: false,
    defenceCapped: false,
  };
}

/**
 * Apply both sides' corrections to the baseline goal expectations.
 *
 * A team's scoring rate is corrected by its own attack multiplier and by the
 * opponent's defence multiplier — the standard multiplicative Poisson form the
 * Dixon-Coles architecture already assumes. λ is re-clamped to the same band
 * the base goal model uses, so the shadow can never produce a λ the baseline
 * architecture would consider out of range.
 */
export function adjustedGoalExpectations(input: {
  baselineHomeLambda: number;
  baselineAwayLambda: number;
  home: CurrentSeasonStrength;
  away: CurrentSeasonStrength;
  lambdaMin?: number;
  lambdaMax?: number;
}): { homeLambda: number; awayLambda: number } {
  const min = input.lambdaMin ?? 0.3;
  const max = input.lambdaMax ?? 3.5;
  const clamp = (x: number) => Math.max(min, Math.min(max, x));
  return {
    homeLambda: clamp(
      input.baselineHomeLambda * input.home.attackMultiplier * input.away.defenceMultiplier
    ),
    awayLambda: clamp(
      input.baselineAwayLambda * input.away.attackMultiplier * input.home.defenceMultiplier
    ),
  };
}
