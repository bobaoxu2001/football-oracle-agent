/**
 * Verified out-of-sample track record — the single source of truth for the
 * walk-forward backtest of the LIVE prediction stack against every completed
 * 2026 World Cup result.
 *
 * Each completed match (in date order) is predicted using ONLY the results
 * dated strictly before it — the model never peeks at a match's own outcome.
 * Seven cumulative variants are scored so the marginal value of each engine
 * layer stays visible (see scripts/backtest.ts for the CLI report):
 *
 *   unif       — uniform 1/3 baseline (sanity floor)
 *   base       — pure calibrated Elo (+ host bonus)
 *   old        — + completed-result learning (K=60) + confederation form
 *   full       — + value-weighted injuries + tactical matchup + bounce-back
 *   drawFlat   — + flat opener-weighted group-stage draw boost
 *   full+draw  — + kill-index dampener + low-block fortress term
 *   +cal       — + global confidence calibration — this is the LIVE stack
 *
 * Consumed by: /accuracy (page + API), scripts/backtest.ts (CLI), and
 * scripts/test-track-record.ts (invariant checks). Deterministic, no I/O.
 */

import { ALL_MATCH_RESULTS } from "../seed/recorded-match-results";
import { getRating, HOME_ADVANTAGE } from "./ratings";
import { computeRatingUpdates } from "./ratingUpdates";
import { getAvailabilityDelta } from "./availabilityAdjustments";
import { getTacticalMatchup, getStyle } from "./tacticalMatchups";
import { drawMultiplierFor, inflateDraw, isGroupFixture } from "@/lib/competitions/world-cup/drawPropensity";
import { bounceBackDelta } from "@/lib/competitions/world-cup/bounceBack";
import { gapCalibration } from "./confidenceCalibration";
import { matchProb, expectedScore } from "./elo";
import { HOST_SLUGS, getTeam } from "../seed/world-cup-2026-groups";

export type Outcome = "A" | "D" | "B";

export const TRACK_VARIANTS = ["unif", "base", "old", "full", "drawFlat", "full+draw", "+cal"] as const;
export type VariantKey = (typeof TRACK_VARIANTS)[number];

export interface OutcomeProbs {
  winA: number;
  draw: number;
  winB: number;
}

export interface TrackRecordMatch {
  date: string;
  group: string; // "A".."L" for group stage, "R32"… for knockouts
  stage: "group" | "knockout";
  teamA: string;
  teamB: string;
  nameA: string;
  nameB: string;
  flagA: string;
  flagB: string;
  scoreA: number;
  scoreB: number;
  /** Knockout shootout winner when the recorded score is a draw. */
  advances?: string;
  verified: boolean;
  /** Live (+cal) stack probabilities — what the deployed engine would have said. */
  live: OutcomeProbs;
  /** Pure calibrated-Elo baseline, for the "what did the layers add" story. */
  base: OutcomeProbs;
  topPick: Outcome;
  actual: Outcome;
  hit: boolean;
  favSlug: string;
  favProb: number;
}

export interface VariantMetrics {
  brier: number;
  rps: number;
  logloss: number;
  hits: number;
  topPickAcc: number;
  avgDrawPred: number;
}

export interface CalibrationBin {
  label: string;
  n: number;
  meanPred: number;
  observed: number;
  gap: number;
}

export interface TrackRecord {
  /** Date of the latest graded result (YYYY-MM-DD). */
  asOf: string;
  nMatches: number;
  nGroup: number;
  nKnockout: number;
  actualDraws: number;
  matches: TrackRecordMatch[]; // chronological
  variants: Record<VariantKey, VariantMetrics>;
  /** Live (+cal) model vs the uniform 1/3 baseline. */
  skill: {
    brierSkill: number;
    rpsSkill: number;
    loglossModel: number;
    loglossUniform: number;
  };
  calibration: { bins: CalibrationBin[]; ece: number };
}

const hb = (a: string, b: string) =>
  HOST_SLUGS.has(a) && !HOST_SLUGS.has(b) ? HOME_ADVANTAGE :
  HOST_SLUGS.has(b) && !HOST_SLUGS.has(a) ? -HOME_ADVANTAGE : 0;
const conf = (s: string) => getTeam(s).confederation;

/** Confederation-form deltas computed from a subset of results (walk-forward). */
function confedDeltas(results: typeof ALL_MATCH_RESULTS): Record<string, number> {
  const sum: Record<string, number> = {}, cnt: Record<string, number> = {};
  for (const r of results) {
    const eA = expectedScore(getRating(r.teamA), getRating(r.teamB), hb(r.teamA, r.teamB));
    const aA = r.scoreA > r.scoreB ? 1 : r.scoreA < r.scoreB ? 0 : 0.5;
    sum[conf(r.teamA)] = (sum[conf(r.teamA)] || 0) + (aA - eA); cnt[conf(r.teamA)] = (cnt[conf(r.teamA)] || 0) + 1;
    sum[conf(r.teamB)] = (sum[conf(r.teamB)] || 0) + ((1 - aA) - (1 - eA)); cnt[conf(r.teamB)] = (cnt[conf(r.teamB)] || 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const c in cnt) { const n = cnt[c]; out[c] = Math.max(-20, Math.min(20, Math.round(50 * (sum[c] / n) * (n / (n + 4))))); }
  return out;
}

/**
 * Ranked Probability Score for an ordered 3-outcome market [winA, draw, winB].
 * RPS = (1/(r-1)) · Σ_{i<r} ( Σ_{j≤i}(p_j − e_j) )², r = 3 categories. Lower is
 * better; it rewards getting the ORDER right, not just the exact bucket.
 */
const rps3 = (p: OutcomeProbs, yA: number, yD: number) => {
  const c1 = p.winA - yA;
  const c2 = p.winA + p.draw - (yA + yD);
  return (c1 * c1 + c2 * c2) / 2;
};

const CAL_BINS = [
  { lo: 0.0, hi: 0.2, label: "00–20%" },
  { lo: 0.2, hi: 0.4, label: "20–40%" },
  { lo: 0.4, hi: 0.6, label: "40–60%" },
  { lo: 0.6, hi: 0.8, label: "60–80%" },
  { lo: 0.8, hi: 1.01, label: "80–100%" },
];

export function computeTrackRecord(): TrackRecord {
  const all = [...ALL_MATCH_RESULTS].sort((x, y) => (x.date || "").localeCompare(y.date || ""));

  interface Agg { brier: number; rps: number; logloss: number; hits: number; drawPred: number; }
  const agg: Record<VariantKey, Agg> = Object.fromEntries(
    TRACK_VARIANTS.map((k) => [k, { brier: 0, rps: 0, logloss: 0, hits: 0, drawPred: 0 }])
  ) as Record<VariantKey, Agg>;
  const calib: { p: number; hit: number }[] = [];
  const matches: TrackRecordMatch[] = [];

  for (const m of all) {
    const priors = all.filter((r) => (r.date || "") < (m.date || ""));
    const dl = computeRatingUpdates(priors).deltas;
    const cd = confedDeltas(priors);
    const tac = getTacticalMatchup(m.teamA, m.teamB);
    const bonus = hb(m.teamA, m.teamB);
    const playedSet = new Set(priors.flatMap((r) => [r.teamA, r.teamB]));
    const playedCount = (playedSet.has(m.teamA) ? 1 : 0) + (playedSet.has(m.teamB) ? 1 : 0);
    const isGroup = isGroupFixture(m.teamA, m.teamB);

    const baseA = getRating(m.teamA), baseB = getRating(m.teamB);
    const oldA = baseA + (dl[m.teamA] || 0) + (cd[conf(m.teamA)] || 0);
    const oldB = baseB + (dl[m.teamB] || 0) + (cd[conf(m.teamB)] || 0);
    const effA = oldA + getAvailabilityDelta(m.teamA);
    const effB = oldB + getAvailabilityDelta(m.teamB);
    const bounceA = bounceBackDelta(baseA, dl[m.teamA] || 0, effA - effB, isGroup);
    const bounceB = bounceBackDelta(baseB, dl[m.teamB] || 0, effB - effA, isGroup);
    const fullA = effA + tac.a + bounceA;
    const fullB = effB + tac.b + bounceB;

    const pBase = matchProb(baseA, baseB, bonus);
    const pOld = matchProb(oldA, oldB, bonus);
    const pFull = matchProb(fullA, fullB, bonus);
    const favStyle = pFull.winA >= pFull.winB ? getStyle(m.teamA) : getStyle(m.teamB);
    const dogStyle = pFull.winA >= pFull.winB ? getStyle(m.teamB) : getStyle(m.teamA);
    const favKill = favStyle.breakdown;
    const busResist = Math.max(0, dogStyle.lowBlock - favStyle.breakdown);
    const drawMultFlat = drawMultiplierFor(isGroup, playedCount);
    const drawMultDamped = drawMultiplierFor(isGroup, playedCount, favKill, busResist);
    const pDrawFlat = inflateDraw(pFull.winA, pFull.draw, pFull.winB, drawMultFlat);
    const pDraw = inflateDraw(pFull.winA, pFull.draw, pFull.winB, drawMultDamped);
    const cal = gapCalibration(fullA, fullB);
    const pCalRaw = matchProb(fullA + cal.a, fullB + cal.b, bonus);
    const pCal = inflateDraw(pCalRaw.winA, pCalRaw.draw, pCalRaw.winB, drawMultDamped);

    const probs: Record<VariantKey, OutcomeProbs> = {
      unif: { winA: 1 / 3, draw: 1 / 3, winB: 1 / 3 },
      base: pBase, old: pOld, full: pFull,
      drawFlat: { winA: pDrawFlat.winA, draw: pDrawFlat.draw, winB: pDrawFlat.winB },
      "full+draw": { winA: pDraw.winA, draw: pDraw.draw, winB: pDraw.winB },
      "+cal": { winA: pCal.winA, draw: pCal.draw, winB: pCal.winB },
    };

    const yA = m.scoreA > m.scoreB ? 1 : 0, yD = m.scoreA === m.scoreB ? 1 : 0, yB = m.scoreB > m.scoreA ? 1 : 0;
    const actual: Outcome = yA ? "A" : yD ? "D" : "B";
    for (const k of TRACK_VARIANTS) {
      const p = probs[k];
      agg[k].brier += (p.winA - yA) ** 2 + (p.draw - yD) ** 2 + (p.winB - yB) ** 2;
      agg[k].rps += rps3(p, yA, yD);
      const pa = yA ? p.winA : yD ? p.draw : p.winB;
      agg[k].logloss += -Math.log(Math.max(1e-9, pa));
      const top: Outcome = p.winA >= p.draw && p.winA >= p.winB ? "A" : p.draw >= p.winB ? "D" : "B";
      if (top === actual) agg[k].hits++;
      agg[k].drawPred += p.draw;
    }

    const live = probs["+cal"];
    calib.push({ p: live.winA, hit: yA }, { p: live.draw, hit: yD }, { p: live.winB, hit: yB });

    const topPick: Outcome = live.winA >= live.draw && live.winA >= live.winB ? "A" : live.draw >= live.winB ? "D" : "B";
    const favSlug = live.winA >= live.winB ? m.teamA : m.teamB;
    const tA = getTeam(m.teamA), tB = getTeam(m.teamB);
    matches.push({
      date: m.date || "",
      group: m.group,
      stage: isGroup ? "group" : "knockout",
      teamA: m.teamA,
      teamB: m.teamB,
      nameA: tA.name,
      nameB: tB.name,
      flagA: tA.flag,
      flagB: tB.flag,
      scoreA: m.scoreA,
      scoreB: m.scoreB,
      advances: m.advances,
      verified: !!m.verified,
      live,
      base: probs.base,
      topPick,
      actual,
      hit: topPick === actual,
      favSlug,
      favProb: Math.max(live.winA, live.winB),
    });
  }

  const N = all.length;
  const variants = Object.fromEntries(
    TRACK_VARIANTS.map((k) => {
      const a = agg[k];
      return [k, {
        brier: a.brier / N,
        rps: a.rps / N,
        logloss: a.logloss / N,
        hits: a.hits,
        topPickAcc: a.hits / N,
        avgDrawPred: a.drawPred / N,
      }];
    })
  ) as Record<VariantKey, VariantMetrics>;

  const bins: CalibrationBin[] = [];
  let ece = 0;
  for (const b of CAL_BINS) {
    const pts = calib.filter((c) => c.p >= b.lo && c.p < b.hi);
    if (!pts.length) continue;
    const meanPred = pts.reduce((s, c) => s + c.p, 0) / pts.length;
    const observed = pts.reduce((s, c) => s + c.hit, 0) / pts.length;
    ece += (pts.length / calib.length) * Math.abs(meanPred - observed);
    bins.push({ label: b.label, n: pts.length, meanPred, observed, gap: observed - meanPred });
  }

  const live = agg["+cal"], ref = agg.unif;
  return {
    asOf: matches.length ? matches[matches.length - 1].date : "",
    nMatches: N,
    nGroup: matches.filter((m) => m.stage === "group").length,
    nKnockout: matches.filter((m) => m.stage === "knockout").length,
    actualDraws: all.filter((m) => m.scoreA === m.scoreB).length,
    matches,
    variants,
    skill: {
      brierSkill: 1 - live.brier / ref.brier,
      rpsSkill: 1 - live.rps / ref.rps,
      loglossModel: live.logloss / N,
      loglossUniform: ref.logloss / N,
    },
    calibration: { bins, ece },
  };
}
