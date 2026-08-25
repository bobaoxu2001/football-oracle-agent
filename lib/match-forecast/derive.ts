import { scorelineGridFromGoals } from "@/lib/prediction-engine/elo";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import type {
  ExactScoreProbability,
  MatchForecast,
  TeamTotalMarkets,
} from "./types";

export const SCORE_MATRIX_MAX_GOALS = 8;
export const PROBABILITY_TOLERANCE = 1e-9;

function emptyMatrix(): number[][] {
  return Array.from({ length: SCORE_MATRIX_MAX_GOALS + 1 }, () =>
    Array(SCORE_MATRIX_MAX_GOALS + 1).fill(0)
  );
}

function parseScoreKey(key: string): { home: number; away: number } | null {
  const match = key.trim().match(/^(\d+)\s*[-–—:]\s*(\d+)$/);
  if (!match) return null;
  const home = Number(match[1]);
  const away = Number(match[2]);
  if (
    !Number.isInteger(home) ||
    !Number.isInteger(away) ||
    home < 0 ||
    away < 0 ||
    home > SCORE_MATRIX_MAX_GOALS ||
    away > SCORE_MATRIX_MAX_GOALS
  ) {
    return null;
  }
  return { home, away };
}

function storedFullMatrix(snapshot: PredictionSnapshot): number[][] | null {
  const entries = Object.entries(snapshot.scorelineDistribution ?? {});
  if (entries.length !== (SCORE_MATRIX_MAX_GOALS + 1) ** 2) return null;
  const matrix = emptyMatrix();
  const seen = new Set<string>();
  for (const [key, probability] of entries) {
    const score = parseScoreKey(key);
    if (!score || !Number.isFinite(probability) || probability < 0) return null;
    const id = `${score.home}:${score.away}`;
    if (seen.has(id)) return null;
    seen.add(id);
    matrix[score.home][score.away] = probability;
  }
  const sum = matrix.flat().reduce((total, probability) => total + probability, 0);
  return Math.abs(sum - 1) <= PROBABILITY_TOLERANCE ? matrix : null;
}

export function scoreMatrixFromSnapshot(snapshot: PredictionSnapshot): {
  matrix: number[][];
  artifact: MatchForecast["provenance"]["scoreDistributionArtifact"];
} {
  const frozen = storedFullMatrix(snapshot);
  if (frozen) return { matrix: frozen, artifact: "frozen-full-matrix" };

  const rho = Number(snapshot.modelParameters?.dcRho);
  if (!Number.isFinite(rho)) {
    throw new Error(`Forecast ${snapshot.provenance.uniqueKey} has no frozen Dixon-Coles rho.`);
  }
  if (!Number.isFinite(snapshot.homeGoalExpectation) || !Number.isFinite(snapshot.awayGoalExpectation)) {
    throw new Error(`Forecast ${snapshot.provenance.uniqueKey} has no frozen goal expectations.`);
  }
  const matrix = emptyMatrix();
  for (const cell of scorelineGridFromGoals(
    snapshot.homeGoalExpectation,
    snapshot.awayGoalExpectation,
    rho
  )) {
    matrix[cell.a][cell.b] = cell.p;
  }
  return { matrix, artifact: "reconstructed-from-frozen-lambdas-and-rho" };
}

function sumWhere(
  matrix: number[][],
  predicate: (homeGoals: number, awayGoals: number) => boolean
): number {
  let total = 0;
  for (let home = 0; home < matrix.length; home += 1) {
    for (let away = 0; away < matrix[home].length; away += 1) {
      if (predicate(home, away)) total += matrix[home][away];
    }
  }
  return total;
}

function totalsAt(matrix: number[][], threshold: number): { over: number; under: number } {
  const over = sumWhere(matrix, (home, away) => home + away > threshold);
  return { over, under: 1 - over };
}

function teamTotalsAt(
  matrix: number[][],
  side: "home" | "away",
  threshold: number
): { over: number; under: number } {
  const over = sumWhere(matrix, (home, away) => (side === "home" ? home : away) > threshold);
  return { over, under: 1 - over };
}

function deriveTeamTotals(matrix: number[][], side: "home" | "away"): TeamTotalMarkets {
  const t05 = teamTotalsAt(matrix, side, 0.5);
  const t15 = teamTotalsAt(matrix, side, 1.5);
  const t25 = teamTotalsAt(matrix, side, 2.5);
  return {
    over05: t05.over,
    under05: t05.under,
    over15: t15.over,
    under15: t15.under,
    over25: t25.over,
    under25: t25.under,
  };
}

function normalizedEntropy(result: { homeWin: number; draw: number; awayWin: number }): number {
  const values = [result.homeWin, result.draw, result.awayWin];
  const entropy = -values.reduce(
    (total, probability) => total + (probability > 0 ? probability * Math.log(probability) : 0),
    0
  );
  return entropy / Math.log(values.length);
}

export function deriveForecastMath(matrix: number[][]): Pick<
  MatchForecast,
  | "result"
  | "totals"
  | "btts"
  | "doubleChance"
  | "drawNoBet"
  | "teamTotals"
  | "exactScores"
  | "topScores"
  | "uncertainty"
> {
  const matrixSum = matrix.flat().reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(matrixSum - 1) > PROBABILITY_TOLERANCE) {
    throw new Error(`Score matrix is not normalized: ${matrixSum}.`);
  }
  const result = {
    homeWin: sumWhere(matrix, (home, away) => home > away),
    draw: sumWhere(matrix, (home, away) => home === away),
    awayWin: sumWhere(matrix, (home, away) => home < away),
  };
  const t05 = totalsAt(matrix, 0.5);
  const t15 = totalsAt(matrix, 1.5);
  const t25 = totalsAt(matrix, 2.5);
  const t35 = totalsAt(matrix, 3.5);
  const t45 = totalsAt(matrix, 4.5);
  const bttsYes = sumWhere(matrix, (home, away) => home >= 1 && away >= 1);
  const nonDraw = result.homeWin + result.awayWin;
  if (nonDraw <= 0) throw new Error("Draw-no-bet cannot normalize a zero non-draw mass.");

  const exactScores: ExactScoreProbability[] = [];
  for (let home = 0; home < matrix.length; home += 1) {
    for (let away = 0; away < matrix[home].length; away += 1) {
      exactScores.push({ homeGoals: home, awayGoals: away, probability: matrix[home][away] });
    }
  }
  const rankedResult = [result.homeWin, result.draw, result.awayWin].sort((a, b) => b - a);
  const topTwoSeparation = rankedResult[0] - rankedResult[1];
  const separationLabel =
    topTwoSeparation < 0.08 ? "low" : topTwoSeparation < 0.2 ? "moderate" : "high";

  return {
    result,
    totals: {
      over05: t05.over,
      under05: t05.under,
      over15: t15.over,
      under15: t15.under,
      over25: t25.over,
      under25: t25.under,
      over35: t35.over,
      under35: t35.under,
      over45: t45.over,
      under45: t45.under,
    },
    btts: { yes: bttsYes, no: 1 - bttsYes },
    doubleChance: {
      homeOrDraw: result.homeWin + result.draw,
      homeOrAway: result.homeWin + result.awayWin,
      drawOrAway: result.draw + result.awayWin,
    },
    drawNoBet: {
      home: result.homeWin / nonDraw,
      away: result.awayWin / nonDraw,
    },
    teamTotals: {
      home: deriveTeamTotals(matrix, "home"),
      away: deriveTeamTotals(matrix, "away"),
    },
    exactScores,
    topScores: exactScores.slice().sort((a, b) => b.probability - a.probability).slice(0, 10),
    uncertainty: {
      normalizedEntropy: normalizedEntropy(result),
      topTwoSeparation,
      separationLabel,
    },
  };
}

export function assertForecastInvariants(forecast: MatchForecast): void {
  const nearOne = (value: number, label: string) => {
    if (Math.abs(value - 1) > PROBABILITY_TOLERANCE) {
      throw new Error(`${label} does not sum to 1: ${value}.`);
    }
  };
  nearOne(
    forecast.result.homeWin + forecast.result.draw + forecast.result.awayWin,
    "1X2"
  );
  nearOne(forecast.totals.over25 + forecast.totals.under25, "O/U 2.5");
  nearOne(forecast.btts.yes + forecast.btts.no, "BTTS");
  nearOne(forecast.drawNoBet.home + forecast.drawNoBet.away, "DNB");
  nearOne(forecast.scoreMatrix.flat().reduce((sum, probability) => sum + probability, 0), "score matrix");
  for (const score of forecast.exactScores) {
    if (
      Math.abs(
        score.probability - forecast.scoreMatrix[score.homeGoals][score.awayGoals]
      ) > PROBABILITY_TOLERANCE
    ) {
      throw new Error(`Exact score ${score.homeGoals}-${score.awayGoals} differs from score matrix.`);
    }
  }
}
