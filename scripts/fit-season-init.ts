/**
 * Fit offseason shrink + promotion gap on historical PL season transitions.
 *
 * Training transitions: 2018-19→…→2024-25 (seasons scored: 2019-20 … 2024-25).
 * 2025-26 is reported as a check only and is NOT used to pick coefficients.
 *
 * Objective: walk-forward log-loss on the scored seasons (full season).
 */
import fs from "node:fs";
import path from "node:path";
import { completedPremierLeagueFixtures } from "@/lib/competitions/premier-league/data";
import { championshipRatingsAsOf } from "@/lib/competitions/premier-league/championship";
import type { HistoricalMatch } from "@/lib/evaluation/types";
import { matchProb } from "@/lib/prediction-engine/elo";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import {
  PREMIER_LEAGUE_MEAN_ELO,
  earlySeasonKScale,
  expectedScore,
  gMult,
} from "@/lib/prediction-engine/rating-core";
import { initializeSeasonRatings } from "@/lib/prediction-engine/season-init";

const SHRINKS = [0.55, 0.65, 0.75, 0.85, 1.0];
const GAPS = [0, 40, 80, 120];
const TRAIN_TO = "2025-05-31";
const HOLDOUT_FROM = "2025-08-01";
const HOLDOUT_TO = "2026-06-01";

function tape(): HistoricalMatch[] {
  return completedPremierLeagueFixtures().map((f) => ({
    id: f.id,
    date: f.date,
    season: f.season,
    homeSlug: f.homeSlug,
    awaySlug: f.awaySlug,
    homeGoals: f.homeGoals as number,
    awayGoals: f.awayGoals as number,
    competition: "premier league",
  }));
}

function scoreWindow(
  matches: HistoricalMatch[],
  shrink: number,
  gap: number,
  feeder: boolean,
  from: string,
  to: string
) {
  // Inject coefficients by wrapping initializeSeasonRatings is not possible
  // from the backtest without a hook. We temporarily patch via env-less
  // approach: run the same walk-forward locally here.
  const ratings: Record<string, number> = {};
  const played: Record<string, number> = {};
  let season: string | undefined;
  let slugs: string[] = [];
  const rating = (s: string) => ratings[s] ?? (ratings[s] = 1500);
  const byDate = new Map<string, HistoricalMatch[]>();
  for (const m of matches) {
    const list = byDate.get(m.date) ?? [];
    list.push(m);
    byDate.set(m.date, list);
  }
  const params = loadPremierLeagueParams();

  let ll = 0;
  let n = 0;
  for (const date of [...byDate.keys()].sort()) {
    const group = byDate.get(date)!;
    for (const m of group) {
      if (m.season && m.season !== season) {
        const nextSlugs = [
          ...new Set(matches.filter((x) => x.season === m.season).flatMap((x) => [x.homeSlug, x.awaySlug])),
        ];
        const init = initializeSeasonRatings({
          previousPlRatings: ratings,
          previousPlClubSlugs: slugs,
          newSeasonClubSlugs: nextSlugs,
          feederRatings: feeder ? championshipRatingsAsOf(date) : {},
          coefficients: {
            seasonShrink: shrink,
            promotionGap: gap,
            leagueMean: PREMIER_LEAGUE_MEAN_ELO,
            fitted: true,
            note: "temporary search",
          },
        });
        Object.keys(ratings).forEach((k) => delete ratings[k]);
        Object.assign(ratings, init.ratings);
        Object.keys(played).forEach((k) => delete played[k]);
        season = m.season;
        slugs = nextSlugs;
      }
    }
    for (const m of group) {
      if (date >= from && date <= to) {
        const p = matchProb(rating(m.homeSlug), rating(m.awaySlug), params.homeAdvantage, {
          rho: params.dcRho,
          awayHomeShare: 0,
        });
        const actual = m.homeGoals > m.awayGoals ? p.winA : m.homeGoals < m.awayGoals ? p.winB : p.draw;
        ll += -Math.log(Math.max(1e-12, actual));
        n += 1;
      }
    }
    for (const m of group) {
      const ra = rating(m.homeSlug);
      const rb = rating(m.awaySlug);
      const exp = expectedScore(ra, rb, params.homeAdvantage);
      const sc = m.homeGoals > m.awayGoals ? 1 : m.homeGoals < m.awayGoals ? 0 : 0.5;
      const k =
        20 *
        gMult(m.homeGoals - m.awayGoals) *
        ((earlySeasonKScale(played[m.homeSlug] ?? 0) + earlySeasonKScale(played[m.awaySlug] ?? 0)) / 2);
      const delta = k * (sc - exp);
      ratings[m.homeSlug] = ra + delta;
      ratings[m.awaySlug] = rb - delta;
      played[m.homeSlug] = (played[m.homeSlug] ?? 0) + 1;
      played[m.awaySlug] = (played[m.awaySlug] ?? 0) + 1;
    }
  }
  return { n, logLoss: n ? ll / n : Infinity };
}

function main() {
  const matches = tape().sort((a, b) => a.date.localeCompare(b.date));
  const trainMatches = matches.filter((m) => m.date <= TRAIN_TO);
  const rows: Array<{ shrink: number; gap: number; feeder: boolean; n: number; logLoss: number }> = [];
  for (const shrink of SHRINKS) {
    for (const gap of GAPS) {
      for (const feeder of [true, false]) {
        const r = scoreWindow(trainMatches, shrink, gap, feeder, "2019-08-01", TRAIN_TO);
        rows.push({ shrink, gap, feeder, ...r });
        console.log(
          `train shrink=${shrink} gap=${gap} feeder=${feeder} n=${r.n} ll=${r.logLoss.toFixed(5)}`
        );
      }
    }
  }
  rows.sort((a, b) => a.logLoss - b.logLoss);
  const best = rows[0];
  const held = scoreWindow(matches, best.shrink, best.gap, best.feeder, HOLDOUT_FROM, HOLDOUT_TO);
  const baseline = scoreWindow(trainMatches, 0.75, 80, false, "2019-08-01", TRAIN_TO);

  const out = {
    version: "pl-season-init-v0.2.0",
    seasonShrink: best.shrink,
    promotionGap: best.gap,
    leagueMean: PREMIER_LEAGUE_MEAN_ELO,
    fitted: true,
    fitMethod: "walk-forward log-loss grid over historical PL season transitions",
    fitDate: new Date().toISOString().slice(0, 10),
    trainingWindow: { from: "2018-08-01", to: TRAIN_TO },
    heldOutCheck: {
      from: HOLDOUT_FROM,
      to: HOLDOUT_TO,
      n: held.n,
      logLoss: held.logLoss,
      note: "2025-26 was not used to pick coefficients.",
    },
    championshipFeederUsedInSearchWinner: best.feeder,
    placeholderComparison: {
      seasonShrink: 0.75,
      promotionGap: 80,
      feeder: false,
      trainLogLoss: baseline.logLoss,
    },
    leaderboard: rows.slice(0, 8),
    note:
      "Fitted on 2019-20–2024-25 walk-forward log-loss. Production uses these coefficients with the Championship feeder ON (declared production track). Benchmark remains placeholder 0.75/80 feeder OFF.",
  };

  const dest = path.resolve(process.cwd(), "data/processed/premier-league/season-init-params.json");
  fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
  console.log("wrote", dest);
  console.log("winner", best, "heldout", held, "placeholder", baseline);
}

main();
