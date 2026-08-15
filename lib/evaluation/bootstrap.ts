/**
 * Paired bootstrap of metric deltas. Fixed seed. Not used for model selection.
 */

import { mulberry32 } from "@/lib/prediction-engine/elo";
import { brier3, rps3 } from "./metrics";
import type { BacktestResult } from "./types";

export interface DeltaCi {
  delta: number;
  lo: number;
  hi: number;
  nBootstrap: number;
  seed: number;
}

export interface PairedBootstrap {
  nMatches: number;
  nBootstrap: number;
  seed: number;
  brier: DeltaCi;
  rps: DeltaCi;
  logLoss: DeltaCi;
}

function perMatch(results: BacktestResult[]) {
  return results.map((r) => ({
    brier: brier3(r.prediction.winHome, r.prediction.draw, r.prediction.winAway, r.actual),
    rps: rps3(r.prediction.winHome, r.prediction.draw, r.prediction.winAway, r.actual),
    logLoss: -Math.log(Math.max(1e-12, r.probAssignedToActual)),
  }));
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

/**
 * Δ = candidate − baseline (negative = candidate better).
 * 95% percentile CI from `nBootstrap` paired resamples.
 */
export function pairedBootstrapDeltas(
  baseline: BacktestResult[],
  candidate: BacktestResult[],
  options: { nBootstrap?: number; seed?: number } = {}
): PairedBootstrap {
  if (baseline.length !== candidate.length) {
    throw new Error("paired bootstrap requires aligned result arrays");
  }
  const nBootstrap = options.nBootstrap ?? 20000;
  const seed = options.seed ?? 20260816;
  const n = baseline.length;
  const a = perMatch(baseline);
  const b = perMatch(candidate);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const point = {
    brier: mean(b.map((x) => x.brier)) - mean(a.map((x) => x.brier)),
    rps: mean(b.map((x) => x.rps)) - mean(a.map((x) => x.rps)),
    logLoss: mean(b.map((x) => x.logLoss)) - mean(a.map((x) => x.logLoss)),
  };

  const rng = mulberry32(seed);
  const bootB: number[] = [];
  const bootR: number[] = [];
  const bootL: number[] = [];
  for (let t = 0; t < nBootstrap; t++) {
    let dB = 0;
    let dR = 0;
    let dL = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      dB += b[j].brier - a[j].brier;
      dR += b[j].rps - a[j].rps;
      dL += b[j].logLoss - a[j].logLoss;
    }
    bootB.push(dB / n);
    bootR.push(dR / n);
    bootL.push(dL / n);
  }
  bootB.sort((x, y) => x - y);
  bootR.sort((x, y) => x - y);
  bootL.sort((x, y) => x - y);

  const ci = (delta: number, samples: number[]): DeltaCi => ({
    delta,
    lo: quantile(samples, 0.025),
    hi: quantile(samples, 0.975),
    nBootstrap,
    seed,
  });

  return {
    nMatches: n,
    nBootstrap,
    seed,
    brier: ci(point.brier, bootB),
    rps: ci(point.rps, bootR),
    logLoss: ci(point.logLoss, bootL),
  };
}
