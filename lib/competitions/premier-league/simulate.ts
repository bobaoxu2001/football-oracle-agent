/**
 * Premier League season Monte Carlo.
 *
 * Samples remaining fixtures from the Dixon-Coles scoreline grid (same
 * distribution as closed-form 1X2). Does NOT route through groups,
 * knockouts, best-thirds, or any World Cup bracket.
 */

import { matchProb, sampleMatch, mulberry32 } from "@/lib/prediction-engine/elo";
import { loadProductionParams } from "./model-tracks";
import { getClub } from "./clubs";
import { applyResult, rankTable, emptyRow, type TableRow, type PlayedResult } from "./standings";

export interface RemainingFixture {
  homeSlug: string;
  awaySlug: string;
}

export interface ClubSeasonOdds {
  slug: string;
  name: string;
  elo: number;
  champion: number;
  expectedPosition: number;
  /** 1-indexed position histogram, length = nClubs. */
  positionDistribution: number[];
  /** Reserved for later UX (top 4 / top 5 / relegation). */
  top4: number;
  top5: number;
  relegation: number;
}

export interface LeagueSimulationResult {
  sims: number;
  clubs: ClubSeasonOdds[];
  seed: number;
  simulationAsOf: string;
  completedFixturesIncluded: number;
  remainingFixtureCount: number;
  modelVersion: string;
  seasonDataVersion: string;
}

export interface LeagueSimOptions {
  sims?: number;
  seed?: number;
  ratings: Record<string, number>;
  played: PlayedResult[];
  remaining: RemainingFixture[];
  clubSlugs: string[];
  simulationAsOf?: string;
  seasonDataVersion?: string;
}

const DEFAULT_SIMS = 8000;
const DEFAULT_SEED = 20260816;

export function simulateLeagueSeason(options: LeagueSimOptions): LeagueSimulationResult {
  const params = loadProductionParams();
  const sims = options.sims ?? DEFAULT_SIMS;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);
  const n = options.clubSlugs.length;
  const posHits: Record<string, number[]> = {};
  const champHits: Record<string, number> = {};
  const top4Hits: Record<string, number> = {};
  const top5Hits: Record<string, number> = {};
  const relHits: Record<string, number> = {};

  for (const slug of options.clubSlugs) {
    posHits[slug] = Array.from({ length: n }, () => 0);
    champHits[slug] = 0;
    top4Hits[slug] = 0;
    top5Hits[slug] = 0;
    relHits[slug] = 0;
  }

  const goalOpts = { rho: params.dcRho, awayHomeShare: params.awayHomeShare };

  for (let s = 0; s < sims; s++) {
    const table: Record<string, TableRow> = {};
    for (const slug of options.clubSlugs) table[slug] = emptyRow(slug);
    for (const r of options.played) applyResult(table, r);

    for (const f of options.remaining) {
      const eloH = options.ratings[f.homeSlug] ?? 1500;
      const eloA = options.ratings[f.awaySlug] ?? 1500;
      const { goalsA, goalsB } = sampleMatch(
        eloH,
        eloA,
        params.homeAdvantage,
        true,
        rng,
        goalOpts
      );
      applyResult(table, {
        homeSlug: f.homeSlug,
        awaySlug: f.awaySlug,
        homeGoals: goalsA,
        awayGoals: goalsB,
      });
    }

    const ranked = rankTable(Object.values(table));
    for (const row of ranked) {
      posHits[row.slug][row.position - 1] += 1;
      if (row.position === 1) champHits[row.slug] += 1;
      if (row.position <= 4) top4Hits[row.slug] += 1;
      if (row.position <= 5) top5Hits[row.slug] += 1;
      if (row.position > n - 3) relHits[row.slug] += 1;
    }
  }

  const clubs: ClubSeasonOdds[] = options.clubSlugs.map((slug) => {
    const dist = posHits[slug].map((c) => c / sims);
    const expectedPosition = dist.reduce((s, p, i) => s + p * (i + 1), 0);
    let name = slug;
    try {
      name = getClub(slug).name;
    } catch {
      /* keep slug */
    }
    return {
      slug,
      name,
      elo: options.ratings[slug] ?? 1500,
      champion: champHits[slug] / sims,
      expectedPosition,
      positionDistribution: dist,
      top4: top4Hits[slug] / sims,
      top5: top5Hits[slug] / sims,
      relegation: relHits[slug] / sims,
    };
  });

  clubs.sort((a, b) => b.champion - a.champion || a.expectedPosition - b.expectedPosition);

  return {
    sims,
    clubs,
    seed,
    simulationAsOf: options.simulationAsOf ?? new Date().toISOString(),
    completedFixturesIncluded: options.played.length,
    remainingFixtureCount: options.remaining.length,
    modelVersion: params.modelVersion,
    seasonDataVersion: options.seasonDataVersion ?? "unspecified",
  };
}

/** Closed-form 1X2 for a Premier League fixture (true home/away). */
export function premierLeagueMatchProb(homeElo: number, awayElo: number) {
  const params = loadProductionParams();
  return matchProb(homeElo, awayElo, params.homeAdvantage, {
    rho: params.dcRho,
    awayHomeShare: params.awayHomeShare,
  });
}
