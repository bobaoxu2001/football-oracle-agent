/**
 * Evaluation metric definitions.
 *
 * Every number we report is defined here. Do not call a custom reliability
 * diagnostic "ECE" without saying which ECE.
 *
 * Brier (3-way):  mean_i Σ_k (p_ik − y_ik)²
 *   k ∈ {home, draw, away}. Unscaled. Uniform = 2/3.
 *
 * RPS:  mean_i ½ [ (P_H−y_H)² + (P_H+P_D−y_H−y_D)² ]
 *   Ordered Home > Draw > Away.
 *
 * LogLoss:  mean_i −ln(max(p_actual, 1e-12))
 *
 * Pooled Reliability MAE (formerly mislabeled "ECE"):
 *   Every (match, class) probability is a point. 5 equal-width bins on [0,1].
 *   Bin contribution = |mean predicted − observed hit rate|.
 *   Overall = frequency-weighted mean of bin contributions (weight = bin n / 3N).
 *
 * Standard confidence ECE:
 *   One point per match, binned by max(p_home, p_draw, p_away).
 *   5 equal-width bins. ECE = Σ_b (n_b / N) |mean_pred_b − hit_rate_b|
 *   Hit = top-pick was correct.
 */

import type { BacktestMetrics, BacktestResult, CalibrationBin, Outcome } from "./types";

export function rps3(home: number, draw: number, away: number, actual: Outcome): number {
  const yH = actual === "home" ? 1 : 0;
  const yD = actual === "draw" ? 1 : 0;
  const c1 = home - yH;
  const c2 = home + draw - (yH + yD);
  return (c1 * c1 + c2 * c2) / 2;
}

export function brier3(home: number, draw: number, away: number, actual: Outcome): number {
  const yH = actual === "home" ? 1 : 0;
  const yD = actual === "draw" ? 1 : 0;
  const yA = actual === "away" ? 1 : 0;
  return (home - yH) ** 2 + (draw - yD) ** 2 + (away - yA) ** 2;
}

const EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
const LABELS = ["00–20%", "20–40%", "40–60%", "60–80%", "80–100%"];

function binIndex(p: number): number {
  for (let i = 0; i < 5; i++) if (p >= EDGES[i] && p < EDGES[i + 1]) return i;
  return 4;
}

/** Pooled classwise reliability MAE — 5 equal-width bins, 3 classes per match. */
export function pooledReliabilityMae(results: BacktestResult[]): {
  value: number;
  table: CalibrationBin[];
} {
  const bins = Array.from({ length: 5 }, () => ({ sumP: 0, hit: 0, count: 0 }));
  for (const r of results) {
    const { winHome, draw, winAway } = r.prediction;
    const pts: [number, number][] = [
      [winHome, r.actual === "home" ? 1 : 0],
      [draw, r.actual === "draw" ? 1 : 0],
      [winAway, r.actual === "away" ? 1 : 0],
    ];
    for (const [p, hit] of pts) {
      const i = binIndex(p);
      bins[i].sumP += p;
      bins[i].hit += hit;
      bins[i].count += 1;
    }
  }
  const calN = bins.reduce((s, b) => s + b.count, 0);
  const table: CalibrationBin[] = bins
    .map((b, i) => ({
      bucket: LABELS[i],
      predictedMean: b.count ? b.sumP / b.count : 0,
      empiricalRate: b.count ? b.hit / b.count : 0,
      count: b.count,
    }))
    .filter((b) => b.count > 0);
  const value = table.reduce(
    (s, b) => s + (b.count / calN) * Math.abs(b.predictedMean - b.empiricalRate),
    0
  );
  return { value: calN ? value : 0, table };
}

/**
 * Standard confidence ECE — one point per match, binned by the favourite's
 * predicted probability; hit = top pick correct. 5 equal-width bins, N-weighted.
 */
export function confidenceEce(results: BacktestResult[]): {
  value: number;
  table: CalibrationBin[];
} {
  const bins = Array.from({ length: 5 }, () => ({ sumP: 0, hit: 0, count: 0 }));
  for (const r of results) {
    const p = Math.max(r.prediction.winHome, r.prediction.draw, r.prediction.winAway);
    const i = binIndex(p);
    bins[i].sumP += p;
    bins[i].hit += r.correct1x2 ? 1 : 0;
    bins[i].count += 1;
  }
  const n = results.length;
  const table: CalibrationBin[] = bins
    .map((b, i) => ({
      bucket: LABELS[i],
      predictedMean: b.count ? b.sumP / b.count : 0,
      empiricalRate: b.count ? b.hit / b.count : 0,
      count: b.count,
    }))
    .filter((b) => b.count > 0);
  const value = table.reduce(
    (s, b) => s + (b.count / n) * Math.abs(b.predictedMean - b.empiricalRate),
    0
  );
  return { value: n ? value : 0, table };
}

export function calculateBacktestMetrics(results: BacktestResult[]): BacktestMetrics {
  const n = results.length;
  const empty: BacktestMetrics = {
    matches: 0,
    accuracy1x2: 0,
    logLoss: 0,
    brierScore: 0,
    rps: 0,
    pooledReliabilityMae: 0,
    confidenceEce: 0,
    calibrationError: 0,
    calibrationTable: [],
    confidenceEceTable: [],
    exactScoreAccuracy: 0,
    top3ScoreAccuracy: 0,
    avgDrawPred: 0,
    actualDrawRate: 0,
  };
  if (n === 0) return empty;

  let correct = 0;
  let logLoss = 0;
  let brier = 0;
  let rps = 0;
  let exact = 0;
  let top3 = 0;
  let drawPred = 0;
  let actualDraws = 0;

  for (const r of results) {
    const { winHome, draw, winAway } = r.prediction;
    if (r.correct1x2) correct++;
    if (r.exactScore) exact++;
    if (r.top3Score) top3++;
    logLoss += -Math.log(Math.max(1e-12, r.probAssignedToActual));
    brier += brier3(winHome, draw, winAway, r.actual);
    rps += rps3(winHome, draw, winAway, r.actual);
    drawPred += draw;
    if (r.actual === "draw") actualDraws++;
  }

  const pooled = pooledReliabilityMae(results);
  const ece = confidenceEce(results);

  return {
    matches: n,
    accuracy1x2: correct / n,
    logLoss: logLoss / n,
    brierScore: brier / n,
    rps: rps / n,
    pooledReliabilityMae: pooled.value,
    confidenceEce: ece.value,
    calibrationError: pooled.value,
    calibrationTable: pooled.table,
    confidenceEceTable: ece.table,
    exactScoreAccuracy: exact / n,
    top3ScoreAccuracy: top3 / n,
    avgDrawPred: drawPred / n,
    actualDrawRate: actualDraws / n,
  };
}
