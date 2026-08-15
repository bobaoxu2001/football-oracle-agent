/**
 * Generic Elo update helpers.
 *
 * `baseK` / `gMult` migrated from world-cup-ai-lab's historical harness and
 * retuned for club competitions. The live World Cup path keeps K=60 with no
 * goal-difference multiplier (ratingUpdates.ts) — that is intentional.
 */

export function baseK(competition = ""): number {
  const n = competition.toLowerCase();
  if (/premier league|^pl$|e0/.test(n)) return 20;
  if (/championship|^e1$/.test(n)) return 18;
  if (/world cup(?!.*qual)/.test(n)) return 55;
  if (/world cup.*qual|qualif/.test(n)) return 40;
  if (/champions league|europa/.test(n)) return 24;
  if (/fa cup|efl cup|league cup/.test(n)) return 16;
  if (/friendl/.test(n)) return 12;
  return 18;
}

/** Goal-difference multiplier: bigger wins move ratings more. */
export function gMult(gd: number): number {
  const d = Math.abs(gd);
  return d <= 1 ? 1 : d === 2 ? 1.5 : (11 + d) / 8;
}

export function expectedScore(a: number, b: number, homeBonus: number): number {
  return 1 / (1 + Math.pow(10, (b - (a + homeBonus)) / 400));
}

/**
 * Early-season learning shrink.
 * Matches 0–7 (MW1–MW5-ish, counting both home and away) use a reduced K so
 * a single opening-weekend shock cannot rewrite a preseason prior.
 *
 *   scale(n) = 0.55 + 0.45 * min(1, n / 8)
 *
 * After 8 club matches the full K is restored.
 */
export function earlySeasonKScale(matchesPlayedThisSeason: number): number {
  const n = Math.max(0, matchesPlayedThisSeason);
  return 0.55 + 0.45 * Math.min(1, n / 8);
}

export const DEFAULT_CLUB_ELO = 1500;
export const PREMIER_LEAGUE_MEAN_ELO = 1600;

/**
 * Season-boundary shrink toward the league mean, plus a promotion offset.
 *
 * PLACEHOLDER coefficients — not fitted. Do not present as calibrated
 * Premier League constants. See season-init.ts.
 *
 *   elo' = mean + SEASON_SHRINK * (elo − mean)
 *
 * Promoted clubs: Championship Elo − PROMOTION_GAP, then shrink, when a
 * feeder rating exists; otherwise mean − PROMOTION_GAP.
 */
export const SEASON_SHRINK = 0.75;
export const PROMOTION_GAP = 80;
export const RELEGATION_FLOOR_OFFSET = 40;

export function shrinkTowardMean(elo: number, mean = PREMIER_LEAGUE_MEAN_ELO): number {
  return mean + SEASON_SHRINK * (elo - mean);
}

export function promotedPrior(championshipElo?: number, mean = PREMIER_LEAGUE_MEAN_ELO): number {
  if (typeof championshipElo === "number" && Number.isFinite(championshipElo)) {
    return shrinkTowardMean(championshipElo - PROMOTION_GAP, mean);
  }
  return mean - PROMOTION_GAP;
}
