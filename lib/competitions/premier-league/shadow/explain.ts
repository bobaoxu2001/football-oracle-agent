/**
 * Deterministic explanation of the shadow-vs-baseline probability delta.
 *
 * Every sentence is computed from the actual feature and λ deltas that produced
 * the number. There is no language model here and there must never be one: an
 * invented causal story about a probability move is worse than no story, because
 * it reads as evidence.
 *
 * Each reason carries the figures it was derived from, so a reader can check the
 * claim rather than trust it.
 */

import { getClub } from "../clubs";
import type { ShadowPrediction } from "./model";
import { ADJUSTMENT_CAP } from "@/lib/prediction-engine/shadow/current-season-strength";

export type ReasonCode =
  | "no-current-season-evidence"
  | "prior-strength"
  | "attack-overperformance"
  | "attack-underperformance"
  | "defence-overperformance"
  | "defence-underperformance"
  | "small-sample-shrinkage"
  | "opponent-strength-embedded"
  | "adjustment-capped"
  | "net-effect";

export interface ExplanationReason {
  code: ReasonCode;
  text: string;
  /** The numbers this reason was derived from. */
  values: Record<string, number | string | null>;
}

export interface ShadowExplanation {
  fixture: string;
  modelVersion: string;
  asOf: string;
  /** Percentage-point deltas, shadow minus baseline. */
  deltaHomePp: number;
  deltaDrawPp: number;
  deltaAwayPp: number;
  /** Largest absolute move, for the headline. */
  headline: string;
  identicalToBaseline: boolean;
  reasons: ExplanationReason[];
}

function pp(shadow: number, baseline: number): number {
  return (shadow - baseline) * 100;
}

function signed(x: number, digits = 1): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
}

/** Round-trip-safe percentage-point formatting for a reason string. */
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function explainShadowPrediction(p: ShadowPrediction): ShadowExplanation {
  const home = getClub(p.homeSlug);
  const away = getClub(p.awaySlug);
  const dHome = pp(p.home, p.baseline.home);
  const dDraw = pp(p.draw, p.baseline.draw);
  const dAway = pp(p.away, p.baseline.away);
  const reasons: ExplanationReason[] = [];

  const hs = p.features.homeStrength;
  const as = p.features.awayStrength;
  const identical =
    hs.matchesPlayed === 0 &&
    as.matchesPlayed === 0 &&
    Math.abs(dHome) < 1e-9 &&
    Math.abs(dDraw) < 1e-9 &&
    Math.abs(dAway) < 1e-9;

  // ── Prior strength always leads: it is the dominant term. ──
  const eloGap = p.baseline.eloHome - p.baseline.eloAway;
  reasons.push({
    code: "prior-strength",
    text:
      `${home.name} enter at Elo ${Math.round(p.baseline.eloHome)} against ` +
      `${away.name} at ${Math.round(p.baseline.eloAway)} (gap ${signed(eloGap, 0)}). ` +
      `Prior strength, not current-season form, sets the baseline ${pct(p.baseline.home)} / ` +
      `${pct(p.baseline.draw)} / ${pct(p.baseline.away)}.`,
    values: {
      eloHome: Math.round(p.baseline.eloHome),
      eloAway: Math.round(p.baseline.eloAway),
      eloGap: Math.round(eloGap),
      baselineHome: p.baseline.home,
      baselineDraw: p.baseline.draw,
      baselineAway: p.baseline.away,
    },
  });

  if (identical) {
    reasons.push({
      code: "no-current-season-evidence",
      text:
        "Neither side has an admissible 2026-27 result at this cutoff, so every " +
        "correction multiplier is exactly 1 and the shadow reproduces the baseline " +
        "identically. The models can only diverge once evidence exists.",
      values: { homeMatches: 0, awayMatches: 0 },
    });
    return {
      fixture: `${home.name} vs ${away.name}`,
      modelVersion: p.modelVersion,
      asOf: p.asOf,
      deltaHomePp: dHome,
      deltaDrawPp: dDraw,
      deltaAwayPp: dAway,
      headline: "No divergence: no current-season evidence at this cutoff.",
      identicalToBaseline: true,
      reasons,
    };
  }

  // ── Per-side attack and defence residuals ──
  for (const [side, club, s] of [
    ["home", home, hs],
    ["away", away, as],
  ] as const) {
    if (s.matchesPlayed === 0) continue;

    if (s.rawAttackRatio !== null && Math.abs(s.attackMultiplier - 1) > 1e-9) {
      const over = s.attackMultiplier > 1;
      const zeroCount = s.goalsFor === 0;
      reasons.push({
        code: over ? "attack-overperformance" : "attack-underperformance",
        text: zeroCount
          ? `${club.name} scored 0 in ${s.matchesPlayed} match` +
            `${s.matchesPlayed === 1 ? "" : "es"} where the baseline expected ` +
            `${s.expectedGoalsFor.toFixed(2)}. A zero count is scale-free in expected ` +
            `goals, so the scoring-rate multiplier is ${s.attackMultiplier.toFixed(3)} = k/(k+n) ` +
            `and does not depend on opponent strength; only matches played moves it.`
          : `${club.name} scored ${s.goalsFor} in ${s.matchesPlayed} match` +
            `${s.matchesPlayed === 1 ? "" : "es"} where the baseline expected ` +
            `${s.expectedGoalsFor.toFixed(2)}. After shrinkage their scoring rate is ` +
            `multiplied by ${s.attackMultiplier.toFixed(3)} ` +
            `(raw ratio ${s.rawAttackRatio.toFixed(2)} before shrinkage).`,
        values: {
          side,
          team: club.name,
          goalsFor: s.goalsFor,
          expectedGoalsFor: Number(s.expectedGoalsFor.toFixed(3)),
          rawRatio: Number(s.rawAttackRatio.toFixed(3)),
          multiplier: Number(s.attackMultiplier.toFixed(4)),
          zeroCount: zeroCount ? "true" : "false",
        },
      });
    }

    if (s.rawDefenceRatio !== null && Math.abs(s.defenceMultiplier - 1) > 1e-9) {
      const better = s.defenceMultiplier < 1;
      const zeroCount = s.goalsAgainst === 0;
      reasons.push({
        code: better ? "defence-overperformance" : "defence-underperformance",
        text: zeroCount
          ? `${club.name} conceded 0 in ${s.matchesPlayed} match` +
            `${s.matchesPlayed === 1 ? "" : "es"} where the baseline expected ` +
            `${s.expectedGoalsAgainst.toFixed(2)}. A zero count is scale-free in expected ` +
            `goals, so the concede multiplier is ${s.defenceMultiplier.toFixed(3)} = k/(k+n) ` +
            `and does not depend on opponent strength; only matches played moves it.`
          : `${club.name} conceded ${s.goalsAgainst} where the baseline expected ` +
            `${s.expectedGoalsAgainst.toFixed(2)}. Opponents' scoring rate against them is ` +
            `multiplied by ${s.defenceMultiplier.toFixed(3)} ` +
            `(raw ratio ${s.rawDefenceRatio.toFixed(2)} before shrinkage).`,
        values: {
          side,
          team: club.name,
          goalsAgainst: s.goalsAgainst,
          expectedGoalsAgainst: Number(s.expectedGoalsAgainst.toFixed(3)),
          rawRatio: Number(s.rawDefenceRatio.toFixed(3)),
          multiplier: Number(s.defenceMultiplier.toFixed(4)),
          zeroCount: zeroCount ? "true" : "false",
        },
      });
    }

    if (s.attackCapped || s.defenceCapped) {
      reasons.push({
        code: "adjustment-capped",
        text:
          `${club.name}'s correction hit the ±${((ADJUSTMENT_CAP - 1) * 100).toFixed(0)}% bound, ` +
          `so the stored multiplier understates the raw residual. This is a guard rail against a ` +
          `degenerate sample, not a fitted parameter.`,
        values: {
          team: club.name,
          cap: ADJUSTMENT_CAP,
          attackCapped: String(s.attackCapped),
          defenceCapped: String(s.defenceCapped),
        },
      });
    }
  }

  // ── Sample size is the reason the move is small ──
  const maxMatches = Math.max(hs.matchesPlayed, as.matchesPlayed);
  reasons.push({
    code: "small-sample-shrinkage",
    text:
      `Current-season sample is ${hs.matchesPlayed} match${hs.matchesPlayed === 1 ? "" : "es"} ` +
      `for ${home.name} and ${as.matchesPlayed} for ${away.name}. Early-season shrinkage weights ` +
      `current-season evidence at ${(hs.currentSeasonWeight * 100).toFixed(1)}% and ` +
      `${(as.currentSeasonWeight * 100).toFixed(1)}% respectively, so most of the residual is ` +
      `discarded in favour of the prior.`,
    values: {
      homeMatches: hs.matchesPlayed,
      awayMatches: as.matchesPlayed,
      homeWeight: Number(hs.currentSeasonWeight.toFixed(4)),
      awayWeight: Number(as.currentSeasonWeight.toFixed(4)),
      priorMatchEquivalent: 8,
    },
  });

  // ── Opponent strength is not a separate heuristic; say so ──
  reasons.push({
    code: "opponent-strength-embedded",
    text:
      "Each residual is measured against what the baseline itself expected in those specific " +
      "fixtures, so the opponent's rating and the home/away venue are already priced in: scoring " +
      "3 against a weak side is a smaller residual than 3 against a strong side, with no separate " +
      "opponent adjustment. One caveat — a clean sheet is a zero count, and the estimator is " +
      "scale-free there, so its defensive effect depends on matches played rather than on who the " +
      "opponent was.",
    values: {
      method: "residual-vs-model-expectation",
      maxMatchesUsed: maxMatches,
      zeroCountCaveat: "clean sheets are scale-free in expected goals",
    },
  });

  // ── Net effect on λ and on the probabilities ──
  reasons.push({
    code: "net-effect",
    text:
      `Net effect on goal expectations: home λ ${p.baseline.homeExpectedGoals.toFixed(3)} → ` +
      `${p.homeExpectedGoals.toFixed(3)}, away λ ${p.baseline.awayExpectedGoals.toFixed(3)} → ` +
      `${p.awayExpectedGoals.toFixed(3)}. Through the same Dixon-Coles grid this moves ` +
      `HOME ${signed(dHome)}pp, DRAW ${signed(dDraw)}pp, AWAY ${signed(dAway)}pp.`,
    values: {
      baselineHomeLambda: Number(p.baseline.homeExpectedGoals.toFixed(4)),
      shadowHomeLambda: Number(p.homeExpectedGoals.toFixed(4)),
      baselineAwayLambda: Number(p.baseline.awayExpectedGoals.toFixed(4)),
      shadowAwayLambda: Number(p.awayExpectedGoals.toFixed(4)),
      deltaHomePp: Number(dHome.toFixed(3)),
      deltaDrawPp: Number(dDraw.toFixed(3)),
      deltaAwayPp: Number(dAway.toFixed(3)),
    },
  });

  const biggest = [
    { label: "HOME", d: dHome },
    { label: "DRAW", d: dDraw },
    { label: "AWAY", d: dAway },
  ].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];

  return {
    fixture: `${home.name} vs ${away.name}`,
    modelVersion: p.modelVersion,
    asOf: p.asOf,
    deltaHomePp: dHome,
    deltaDrawPp: dDraw,
    deltaAwayPp: dAway,
    headline: `Shadow ${biggest.label} probability is ${signed(biggest.d)}pp vs baseline.`,
    identicalToBaseline: false,
    reasons,
  };
}
