/**
 * Fit Premier League home-advantage and Dixon-Coles ρ on the TRAINING
 * window only (2018-19 … 2024-25). The 2025-26 season is never touched.
 *
 * Shrinkage: the selected (HA, ρ) is a convex combination of the labeled
 * prior (65, −0.10) and the training-grid optimum. Small-sample wobble
 * cannot yank ρ to the grid edge.
 */
import fs from "node:fs";
import path from "node:path";
import { completedPremierLeagueFixtures } from "@/lib/competitions/premier-league/data";
import { runRollingBacktest, calculateBacktestMetrics } from "@/lib/evaluation/backtest";
import { PREMIER_LEAGUE_MODEL_PARAMS, type ModelParams } from "@/lib/prediction-engine/model-params";

const TRAIN_TO = "2025-05-31";
const PRIOR_HA = PREMIER_LEAGUE_MODEL_PARAMS.homeAdvantage;
const PRIOR_RHO = PREMIER_LEAGUE_MODEL_PARAMS.dcRho;
const SHRINK = 0.35; // weight on the prior

function main() {
  const matches = completedPremierLeagueFixtures()
    .filter((f) => f.date <= TRAIN_TO && f.homeGoals !== null && f.awayGoals !== null)
    .map((f) => ({
      id: f.id,
      date: f.date,
      season: f.season,
      homeSlug: f.homeSlug,
      awaySlug: f.awaySlug,
      homeGoals: f.homeGoals as number,
      awayGoals: f.awayGoals as number,
      competition: "premier league",
    }));

  const haGrid = [50, 55, 60, 65, 70, 75];
  const rhoGrid = [-0.16, -0.13, -0.1, -0.07, -0.04, 0];

  let best = { ha: PRIOR_HA, rho: PRIOR_RHO, logLoss: Infinity };
  console.log(`Training matches (through ${TRAIN_TO}): ${matches.length}`);

  for (const ha of haGrid) {
    for (const rho of rhoGrid) {
      const results = runRollingBacktest(matches, {
        homeAdvantage: ha,
        rho,
        awayHomeShare: 0,
        burnIn: 380, // first season warms ratings only
        label: `ha${ha}-rho${rho}`,
      });
      const m = calculateBacktestMetrics(results);
      console.log(`  HA=${ha} ρ=${rho.toFixed(2)}  n=${m.matches}  LL=${m.logLoss.toFixed(4)}  Brier=${m.brierScore.toFixed(4)}  RPS=${m.rps.toFixed(4)}`);
      if (m.logLoss < best.logLoss) best = { ha, rho, logLoss: m.logLoss };
    }
  }

  const ha = Math.round((1 - SHRINK) * best.ha + SHRINK * PRIOR_HA);
  const rho = Number(((1 - SHRINK) * best.rho + SHRINK * PRIOR_RHO).toFixed(3));

  const fitted: ModelParams = {
    ...PREMIER_LEAGUE_MODEL_PARAMS,
    homeAdvantage: ha,
    dcRho: rho,
    fittedAt: new Date().toISOString().slice(0, 10),
    notes: `Grid optimum HA=${best.ha} ρ=${best.rho} (LL ${best.logLoss.toFixed(4)}) shrunk ${SHRINK} toward prior HA=${PRIOR_HA} ρ=${PRIOR_RHO}. Training 2018-19–2024-25 only. Held-out 2025-26 unused.`,
  };

  const dest = path.resolve("data/processed/premier-league/model-params.json");
  fs.writeFileSync(dest, JSON.stringify(fitted, null, 2));
  console.log(`\nWrote ${dest}`);
  console.log(`Fitted HA=${ha}  ρ=${rho}  (shrunk from ${best.ha}, ${best.rho})`);
}

main();
