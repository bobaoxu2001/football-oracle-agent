/**
 * Transparent 1X2 odds math for Phase 2B0.
 * Raw implied probabilities are NOT forced to sum to 1.
 * Only proportional-v1 de-vig is implemented.
 */

import type { Decimal1x2, Fair1x2 } from "./types";
import { DEVIG_PROPORTIONAL_V1 } from "./types";

export function isValidDecimalOdd(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 1;
}

export function rawImpliedFromDecimal(odds: number): number {
  if (!isValidDecimalOdd(odds)) throw new Error(`invalid decimal odd: ${String(odds)}`);
  return 1 / odds;
}

export function overroundOf(q: Decimal1x2): number {
  return q.home + q.draw + q.away;
}

export function proportionalDevig(q: Decimal1x2): Fair1x2 {
  const s = overroundOf(q);
  if (!(s > 0) || !Number.isFinite(s)) throw new Error("cannot de-vig: overround is not positive");
  return { home: q.home / s, draw: q.draw / s, away: q.away / s };
}

export function bookmakerMargin(q: Decimal1x2): number {
  return overroundOf(q) - 1;
}

export interface Validated1x2 {
  odds: Decimal1x2;
  rawImplied: Decimal1x2;
  overround: number;
  bookmakerMargin: number;
  devigMethod: typeof DEVIG_PROPORTIONAL_V1;
  fair: Fair1x2;
}

export function evaluateDecimal1x2(home: number, draw: number, away: number): Validated1x2 {
  if (!isValidDecimalOdd(home) || !isValidDecimalOdd(draw) || !isValidDecimalOdd(away)) {
    throw new Error("1X2 requires finite decimal odds > 1 for Home, Draw and Away");
  }
  const odds = { home, draw, away };
  const rawImplied = {
    home: rawImpliedFromDecimal(home),
    draw: rawImpliedFromDecimal(draw),
    away: rawImpliedFromDecimal(away),
  };
  const fair = proportionalDevig(rawImplied);
  return {
    odds,
    rawImplied,
    overround: overroundOf(rawImplied),
    bookmakerMargin: bookmakerMargin(rawImplied),
    devigMethod: DEVIG_PROPORTIONAL_V1,
    fair,
  };
}

export function fairSumsToOne(fair: Fair1x2, eps = 1e-12): boolean {
  return Math.abs(fair.home + fair.draw + fair.away - 1) <= eps;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("median of empty list");
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function iqr(values: number[]): number {
  if (values.length < 2) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return s[lo];
    return s[lo] * (hi - idx) + s[hi] * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

export function dispersionOf(values: number[]): { min: number; max: number; stdev: number; iqr: number } {
  if (!values.length) return { min: 0, max: 0, stdev: 0, iqr: 0 };
  return { min: Math.min(...values), max: Math.max(...values), stdev: stdev(values), iqr: iqr(values) };
}
