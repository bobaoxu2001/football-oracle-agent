/**
 * Premier League walk-forward evaluation.
 *
 * Held-out 2025-26 is NEVER used to pick HA / ρ.
 * Dixon-Coles is a principled low-score correction. Empirical lift vs Elo+HA
 * is reported with paired-bootstrap CIs and is not claimed as proven.
 */
import fs from "node:fs";
import { completedPremierLeagueFixtures } from "@/lib/competitions/premier-league/data";
import { runRollingBacktest, calculateBacktestMetrics } from "@/lib/evaluation/backtest";
import { pairedBootstrapDeltas } from "@/lib/evaluation/bootstrap";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import type { BacktestMetrics, HistoricalMatch } from "@/lib/evaluation/types";

const HELD_FROM = "2025-08-01";
const HELD_TO = "2026-06-01";
const BOOT_SEED = 20260816;
const BOOT_N = 20000;

function toMatches() {
  return completedPremierLeagueFixtures()
    .filter((f) => f.homeGoals !== null && f.awayGoals !== null)
    .map(
      (f): HistoricalMatch => ({
        id: f.id,
        date: f.date,
        season: f.season,
        homeSlug: f.homeSlug,
        awaySlug: f.awaySlug,
        homeGoals: f.homeGoals as number,
        awayGoals: f.awayGoals as number,
        competition: "premier league",
      })
    );
}

function fmt(m: BacktestMetrics) {
  return {
    n: m.matches,
    brier: m.brierScore.toFixed(4),
    rps: m.rps.toFixed(4),
    logloss: m.logLoss.toFixed(4),
    pooledReliabilityMae: (m.pooledReliabilityMae * 100).toFixed(1) + "%",
    confidenceEce: (m.confidenceEce * 100).toFixed(1) + "%",
    topPick: `${(m.accuracy1x2 * 100).toFixed(1)}%`,
    drawPred: `${(m.avgDrawPred * 100).toFixed(1)}%`,
    drawAct: `${(m.actualDrawRate * 100).toFixed(1)}%`,
  };
}

function main() {
  const params = loadPremierLeagueParams();
  const matches = toMatches();
  const held = matches.filter((m) => m.date >= HELD_FROM && m.date <= HELD_TO);
  console.log(`All completed PL matches: ${matches.length}`);
  console.log(`Held-out 2025-26 window: ${held.length}`);
  console.log(`Model ${params.modelVersion}  HA=${params.homeAdvantage}  ρ=${params.dcRho}  fitted=${params.fittedAt}`);
  console.log(params.notes);
  console.log("HA and ρ are training-window estimates, not timeless Premier League constants.");

  const common = {
    evaluateFrom: HELD_FROM,
    evaluateTo: HELD_TO,
    awayHomeShare: 0 as const,
    burnIn: 0,
  };

  const eloHaRows = runRollingBacktest(matches, {
    ...common,
    homeAdvantage: params.homeAdvantage,
    rho: 0,
    label: "elo-ha",
  });
  const candidateRows = runRollingBacktest(matches, {
    ...common,
    homeAdvantage: params.homeAdvantage,
    rho: params.dcRho,
    modelVersion: params.modelVersion,
    label: "candidate",
  });
  const eloHa = calculateBacktestMetrics(eloHaRows);
  const candidate = calculateBacktestMetrics(candidateRows);

  const uniform = calculateBacktestMetrics(
    held.map((m) => {
      const actual = m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw";
      return {
        match: m,
        prediction: {
          winHome: 1 / 3,
          draw: 1 / 3,
          winAway: 1 / 3,
          expectedGoalsHome: 1.35,
          expectedGoalsAway: 1.35,
          mostLikelyScore: { home: 1, away: 1 },
        },
        asOf: m.date,
        dataCutoff: m.date,
        modelVersion: "uniform",
        actual,
        predicted: "draw" as const,
        correct1x2: actual === "draw",
        exactScore: m.homeGoals === 1 && m.awayGoals === 1,
        top3Score: false,
        probAssignedToActual: 1 / 3,
      };
    })
  );

  console.log("\nHeld-out Premier League walk-forward");
  console.log(
    "variant".padEnd(32),
    "n",
    "Brier",
    "RPS",
    "LogLoss",
    "PooledRelMAE",
    "ConfECE",
    "TopPick",
    "DrawPred",
    "DrawAct"
  );
  for (const [name, m] of [
    ["uniform", uniform],
    ["elo + home advantage (ρ=0)", eloHa],
    [`candidate DC ρ=${params.dcRho}`, candidate],
  ] as const) {
    const f = fmt(m);
    console.log(
      name.padEnd(32),
      String(f.n).padStart(4),
      f.brier,
      f.rps,
      f.logloss,
      f.pooledReliabilityMae.padStart(8),
      f.confidenceEce.padStart(7),
      f.topPick.padStart(7),
      f.drawPred.padStart(7),
      f.drawAct.padStart(7)
    );
  }

  const boot = pairedBootstrapDeltas(eloHaRows, candidateRows, {
    nBootstrap: BOOT_N,
    seed: BOOT_SEED,
  });
  console.log("\nPaired bootstrap Δ (candidate − Elo+HA). Negative = candidate better.");
  console.log(`n=${boot.nMatches}  bootstrap=${boot.nBootstrap}  seed=${boot.seed}`);
  for (const [name, d] of [
    ["Brier", boot.brier],
    ["RPS", boot.rps],
    ["LogLoss", boot.logLoss],
  ] as const) {
    console.log(
      `  Δ ${name}: ${d.delta.toFixed(5)}   95% CI [${d.lo.toFixed(5)}, ${d.hi.toFixed(5)}]`
    );
  }
  console.log(
    "Interpretation: DC produced a small point-estimate improvement on the held-out season, but the improvement is not statistically distinguishable from noise under the current sample. Keep DC as a principled low-score correction; do not claim a proven performance gain."
  );

  console.log("\nPooled reliability MAE bins (candidate; NOT standard ECE):");
  for (const b of candidate.calibrationTable) {
    console.log(
      `  ${b.bucket.padEnd(8)} n=${String(b.count).padStart(4)}  pred=${(b.predictedMean * 100).toFixed(0)}%  obs=${(b.empiricalRate * 100).toFixed(0)}%`
    );
  }
  console.log("\nStandard confidence ECE bins (candidate; max-prob, top-pick hit):");
  for (const b of candidate.confidenceEceTable) {
    console.log(
      `  ${b.bucket.padEnd(8)} n=${String(b.count).padStart(4)}  pred=${(b.predictedMean * 100).toFixed(0)}%  obs=${(b.empiricalRate * 100).toFixed(0)}%`
    );
  }

  const out = {
    modelVersion: params.modelVersion,
    homeAdvantage: params.homeAdvantage,
    dcRho: params.dcRho,
    fittedAt: params.fittedAt,
    trainingWindow: params.trainingWindow,
    heldOut: { from: HELD_FROM, to: HELD_TO, n: candidate.matches },
    metrics: {
      uniform: fmt(uniform),
      eloHa: fmt(eloHa),
      candidate: fmt(candidate),
    },
    pooledReliabilityMae: candidate.pooledReliabilityMae,
    confidenceEce: candidate.confidenceEce,
    bootstrap: boot,
    interpretation:
      "DC produced a small point-estimate improvement on the held-out season, but the improvement is not statistically distinguishable from noise under the current sample.",
  };
  const dest = "data/processed/premier-league/backtest-heldout.json";
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${dest}`);
}

main();
