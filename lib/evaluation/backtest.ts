/**
 * Time-aware walk-forward backtest.
 *
 * Structural temporal rule:
 *   A prediction on date D uses only fixtures with date < D.
 *   All fixtures on date D are predicted from the same pre-D ratings.
 *   Ratings then update from the whole date-D group.
 *
 * Same-date kickoffs without timestamps never feed each other.
 */

import { matchProb, scorelineGrid } from "@/lib/prediction-engine/elo";
import {
  DEFAULT_CLUB_ELO,
  baseK,
  earlySeasonKScale,
  expectedScore,
  gMult,
} from "@/lib/prediction-engine/rating-core";
import { initializeSeasonRatings } from "@/lib/prediction-engine/season-init";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import { championshipRatingsAsOf } from "@/lib/competitions/premier-league/championship";
import { calculateBacktestMetrics } from "./metrics";
import type {
  BacktestOptions,
  BacktestResult,
  BacktestRun,
  HistoricalMatch,
  Outcome,
} from "./types";

export { calculateBacktestMetrics } from "./metrics";
export { pairedBootstrapDeltas } from "./bootstrap";

function outcomeOf(hg: number, ag: number): Outcome {
  return hg > ag ? "home" : hg < ag ? "away" : "draw";
}

export function runRollingBacktest(
  matches: HistoricalMatch[],
  options: BacktestOptions = {}
): BacktestResult[] {
  const params = loadPremierLeagueParams();
  const homeAdv = options.homeAdvantage ?? params.homeAdvantage;
  const rho = options.rho ?? params.dcRho;
  const awayHomeShare = options.awayHomeShare ?? params.awayHomeShare;
  const burnIn = options.burnIn ?? 0;
  const mode = options.mode ?? "rolling";
  const modelVersion = options.modelVersion ?? params.modelVersion;
  const freezeTs = options.freezeAfter ? Date.parse(options.freezeAfter) : Infinity;
  const evalFrom = options.evaluateFrom ?? "0000-01-01";
  const evalTo = options.evaluateTo ?? "9999-12-31";

  const ratings: Record<string, number> = { ...(options.seedRatings ?? {}) };
  const playedSeason: Record<string, number> = {};
  let currentSeason: string | undefined;
  let currentSeasonSlugs: string[] = [];

  const rating = (slug: string) =>
    ratings[slug] ?? (ratings[slug] = options.seedRatings?.[slug] ?? DEFAULT_CLUB_ELO);

  const ordered = [...matches].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.id ?? "").localeCompare(b.id ?? "")
  );

  const byDate = new Map<string, HistoricalMatch[]>();
  for (const m of ordered) {
    const list = byDate.get(m.date) ?? [];
    list.push(m);
    byDate.set(m.date, list);
  }
  const dates = [...byDate.keys()].sort();

  const results: BacktestResult[] = [];
  let applied = 0;

  const openSeason = (season: string | undefined, asOf: string) => {
    if (!season || season === currentSeason) return;
    const nextSlugs = [
      ...new Set(ordered.filter((m) => m.season === season).flatMap((m) => [m.homeSlug, m.awaySlug])),
    ];
    const feeder =
      options.feederRatingsBySeason?.[season] ??
      (options.useChampionshipFeeder ? championshipRatingsAsOf(asOf) : {});
    const init = initializeSeasonRatings({
      previousPlRatings: ratings,
      previousPlClubSlugs: currentSeasonSlugs,
      newSeasonClubSlugs: nextSlugs,
      feederRatings: feeder,
    });
    Object.keys(ratings).forEach((k) => delete ratings[k]);
    Object.assign(ratings, init.ratings);
    Object.keys(playedSeason).forEach((k) => delete playedSeason[k]);
    currentSeason = season;
    currentSeasonSlugs = nextSlugs;
  };

  for (const date of dates) {
    const group = byDate.get(date)!;
    for (const m of group) if (m.season) openSeason(m.season, date);

    // Predict every fixture on this date from ratings built only on date < D.
    for (const m of group) {
      const ra = rating(m.homeSlug);
      const rb = rating(m.awaySlug);
      const hb = m.neutral ? 0 : homeAdv;
      const inWindow = date >= evalFrom && date <= evalTo;
      if (applied >= burnIn && inWindow) {
        const p = matchProb(ra, rb, hb, { rho, awayHomeShare });
        const grid = scorelineGrid(ra, rb, hb, { rho, awayHomeShare }).sort((x, y) => y.p - x.p);
        const actual = outcomeOf(m.homeGoals, m.awayGoals);
        const probs = { home: p.winA, draw: p.draw, away: p.winB };
        const predicted: Outcome =
          p.winA >= p.draw && p.winA >= p.winB ? "home" : p.winB >= p.draw ? "away" : "draw";
        results.push({
          match: m,
          prediction: {
            winHome: p.winA,
            draw: p.draw,
            winAway: p.winB,
            expectedGoalsHome: p.expectedGoalsA,
            expectedGoalsAway: p.expectedGoalsB,
            mostLikelyScore: { home: grid[0].a, away: grid[0].b },
          },
          asOf: date,
          dataCutoff: date,
          modelVersion,
          actual,
          predicted,
          correct1x2: predicted === actual,
          exactScore: grid[0].a === m.homeGoals && grid[0].b === m.awayGoals,
          top3Score: grid.slice(0, 3).some((g) => g.a === m.homeGoals && g.b === m.awayGoals),
          probAssignedToActual: probs[actual],
        });
      }
    }

    // Apply the whole date group only after every same-date prediction.
    for (const m of group) {
      const canUpdate = mode === "rolling" || Date.parse(m.date) < freezeTs;
      if (canUpdate) {
        const ra = rating(m.homeSlug);
        const rb = rating(m.awaySlug);
        const hb = m.neutral ? 0 : homeAdv;
        const exp = expectedScore(ra, rb, hb);
        const sc = m.homeGoals > m.awayGoals ? 1 : m.homeGoals < m.awayGoals ? 0 : 0.5;
        const nH = playedSeason[m.homeSlug] ?? 0;
        const nA = playedSeason[m.awaySlug] ?? 0;
        const k =
          (options.kFactor ?? params.kFactor ?? baseK(m.competition ?? "premier league")) *
          gMult(m.homeGoals - m.awayGoals) *
          ((earlySeasonKScale(nH) + earlySeasonKScale(nA)) / 2);
        const delta = k * (sc - exp);
        ratings[m.homeSlug] = ra + delta;
        ratings[m.awaySlug] = rb - delta;
        playedSeason[m.homeSlug] = nH + 1;
        playedSeason[m.awaySlug] = nA + 1;
      }
      applied++;
    }
  }

  return results;
}

export function runPremierLeagueBacktest(
  matches: HistoricalMatch[],
  options: BacktestOptions = {}
): BacktestRun {
  const results = runRollingBacktest(matches, options);
  return {
    label: options.label ?? "premier-league",
    options: { ...options, mode: options.mode ?? "rolling" },
    results,
    metrics: calculateBacktestMetrics(results),
  };
}
