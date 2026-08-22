/**
 * Elo + Dixon-Coles bivariate Poisson — the shared match model.
 *
 * Closed-form 1X2 and Monte Carlo sampling now use the SAME Dixon-Coles
 * scoreline grid. World Cup callers keep the historic defaults
 * (ρ = −0.13, away λ receives −homeBonus/2) so existing WC 1X2 numbers
 * are unchanged. League callers pass GoalModelOptions.
 *
 * λ is a goal-expectation mapping from Elo, NOT shot-based xG.
 */

export const K_FACTOR_WC = 60;

/** World Cup / international default. Do not reuse for Premier League. */
export const DC_RHO = -0.13;

export interface GoalModelOptions {
  rho?: number;
  /**
   * Fraction of the home Elo bonus applied (with opposite sign) to the away λ.
   * World Cup historic default is 0.5. Premier League uses 0 (true home/away:
   * bonus only on the home side).
   */
  awayHomeShare?: number;
}

function dcTau(
  a: number,
  b: number,
  lambda: number,
  mu: number,
  rho: number
): number {
  if (a === 0 && b === 0) return 1 - lambda * mu * rho;
  if (a === 0 && b === 1) return 1 + lambda * rho;
  if (a === 1 && b === 0) return 1 + mu * rho;
  if (a === 1 && b === 1) return 1 - rho;
  return 1;
}

/** Elo win expectancy (logistic on rating difference). */
export function expectedScore(
  ratingA: number,
  ratingB: number,
  homeBonusA = 0
): number {
  return 1 / (1 + Math.pow(10, (ratingB - (ratingA + homeBonusA)) / 400));
}

/**
 * Rating difference → expected goals (Poisson λ). This is a goal-expectation
 * mapping from Elo, not a shot-based xG model.
 */
export function expectedGoals(
  rating: number,
  opponent: number,
  homeBonus = 0,
  baseGoals = 1.35,
  goalScale = 350
): number {
  const diff = rating + homeBonus - opponent;
  const lambda = baseGoals + diff / goalScale;
  return Math.max(0.3, Math.min(3.5, lambda));
}

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

export interface MatchProb {
  winA: number;
  draw: number;
  winB: number;
  expectedGoalsA: number;
  expectedGoalsB: number;
}

export interface ScorelineCell {
  a: number;
  b: number;
  p: number;
}

function lambdasFromRatings(
  ratingA: number,
  ratingB: number,
  homeBonusA: number,
  opts: GoalModelOptions = {}
): { lambda: number; mu: number } {
  const awayShare = opts.awayHomeShare ?? 0.5;
  const lambda = expectedGoals(ratingA, ratingB, homeBonusA);
  const mu = expectedGoals(ratingB, ratingA, -homeBonusA * awayShare);
  return { lambda, mu };
}

/** 1X2 from already-computed expected goals (Dixon-Coles τ, 0–8 grid). */
export function matchProbFromGoals(
  lambda: number,
  mu: number,
  rho = DC_RHO
): MatchProb {
  let winA = 0;
  let draw = 0;
  let winB = 0;
  for (let a = 0; a <= 8; a++) {
    const pA = poissonPmf(a, lambda);
    for (let b = 0; b <= 8; b++) {
      const tau = dcTau(a, b, lambda, mu, rho);
      const p = pA * poissonPmf(b, mu) * tau;
      if (a > b) winA += p;
      else if (a < b) winB += p;
      else draw += p;
    }
  }
  const total = winA + draw + winB;
  return {
    winA: winA / total,
    draw: draw / total,
    winB: winB / total,
    expectedGoalsA: lambda,
    expectedGoalsB: mu,
  };
}

/** Scoreline grid from already-computed expected goals (Dixon-Coles, normalised). */
export function scorelineGridFromGoals(
  lambda: number,
  mu: number,
  rho = DC_RHO
): ScorelineCell[] {
  const grid: ScorelineCell[] = [];
  let total = 0;
  for (let a = 0; a <= 8; a++) {
    for (let b = 0; b <= 8; b++) {
      const p = poissonPmf(a, lambda) * poissonPmf(b, mu) * dcTau(a, b, lambda, mu, rho);
      grid.push({ a, b, p });
      total += p;
    }
  }
  return grid.map((g) => ({ ...g, p: g.p / total }));
}

/** 1X2 probabilities via Dixon-Coles bivariate Poisson over 0–8 goals each side. */
export function matchProb(
  ratingA: number,
  ratingB: number,
  homeBonusA = 0,
  rhoOrOpts: number | GoalModelOptions = DC_RHO
): MatchProb {
  const opts = typeof rhoOrOpts === "number" ? { rho: rhoOrOpts } : rhoOrOpts;
  const rho = opts.rho ?? DC_RHO;
  const { lambda, mu } = lambdasFromRatings(ratingA, ratingB, homeBonusA, opts);
  return matchProbFromGoals(lambda, mu, rho);
}

/** Full 9×9 scoreline probability grid (Dixon-Coles corrected, normalised). */
export function scorelineGrid(
  ratingA: number,
  ratingB: number,
  homeBonusA = 0,
  rhoOrOpts: number | GoalModelOptions = DC_RHO
): ScorelineCell[] {
  const opts = typeof rhoOrOpts === "number" ? { rho: rhoOrOpts } : rhoOrOpts;
  const rho = opts.rho ?? DC_RHO;
  const { lambda, mu } = lambdasFromRatings(ratingA, ratingB, homeBonusA, opts);
  return scorelineGridFromGoals(lambda, mu, rho);
}

/** Draw a scoreline from a normalised Dixon-Coles grid. */
export function sampleFromGrid(
  grid: ScorelineCell[],
  rng: () => number = Math.random
): { goalsA: number; goalsB: number } {
  let u = rng();
  for (const cell of grid) {
    u -= cell.p;
    if (u <= 0) return { goalsA: cell.a, goalsB: cell.b };
  }
  const last = grid[grid.length - 1];
  return { goalsA: last.a, goalsB: last.b };
}

/**
 * Sample a scoreline (for Monte Carlo) from the SAME Dixon-Coles grid used
 * by the closed-form 1X2. allowDraw=false → extra-time/pens nudge toward
 * the higher-Elo side (World Cup knockout only).
 */
export function sampleMatch(
  ratingA: number,
  ratingB: number,
  homeBonusA = 0,
  allowDraw = true,
  rng: () => number = Math.random,
  opts: GoalModelOptions = {}
): { goalsA: number; goalsB: number } {
  const grid = scorelineGrid(ratingA, ratingB, homeBonusA, opts);
  let { goalsA, goalsB } = sampleFromGrid(grid, rng);
  if (!allowDraw && goalsA === goalsB) {
    if (rng() < expectedScore(ratingA, ratingB, homeBonusA)) goalsA += 1;
    else goalsB += 1;
  }
  return { goalsA, goalsB };
}

/**
 * Mulberry32 — tiny, fast, seedable PRNG. Used so Monte Carlo simulations
 * are reproducible across server requests.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
