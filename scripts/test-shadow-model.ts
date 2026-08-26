/**
 * Shadow (challenger) model gates — `pl-live-v0.3.0-shadow`.
 *
 * Covers prior behaviour at zero evidence, early-season shrinkage, weight
 * monotonicity, the 8-match transition, opponent-strength and home/away
 * treatment, the documented scale-free zero-count residual, probability
 * normalization, leakage (same-fixture and future), baseline AND shadow
 * immutability, paired settlement and paired metrics, model-version
 * isolation, feature provenance, same-cutoff pairing, no post-settlement
 * reconstruction, collection integrity, and the Arsenal 3-0 case.
 *
 * BASELINE IMMUTABILITY IS A HARD RELEASE GATE. The production model's
 * probabilities must be provably unaffected by anything in this phase.
 *
 * Isolated temp stores throughout: no network, no production data.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-shadow-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TMP, "ops/live-oos-operational.jsonl");
process.env.PL_RATING_EVENT_PATH = path.join(TMP, "ops/rating-events.jsonl");
process.env.PL_RATING_STATE_PATH = path.join(TMP, "ops/rating-state.json");
process.env.PL_OPS_BACKEND = "file";
process.env.MATCH_LEDGER_DIR = path.join(TMP, "ledger");
process.env.MATCH_LEDGER_BACKEND = "file";
process.env.MATCH_LEDGER_DISABLED = "1";
process.env.MARKET_RECORDER_DISABLED = "1";
delete process.env.VERCEL;
delete process.env.SHADOW_MODEL_ENABLED;

import {
  ADJUSTMENT_CAP,
  PRIOR_MATCH_EQUIVALENT,
  adjustedGoalExpectations,
  currentSeasonStrength,
  currentSeasonWeight,
  neutralStrength,
  posteriorRateMultiplier,
} from "@/lib/prediction-engine/shadow/current-season-strength";
import {
  baselineGoalExpectation,
  predictPremierLeagueShadow,
  strengthObservationsFor,
} from "@/lib/competitions/premier-league/shadow/model";
import {
  MIN_PAIRED_FOR_DECISION,
  MIN_PAIRED_FOR_DISPLAY,
  PROMOTION_CRITERIA,
  SHADOW_MODEL_VERSION,
  isShadowVersion,
  productionModelVersion,
  shadowMetricsVisible,
  shadowModelEnabled,
  shadowPromotionStatus,
} from "@/lib/competitions/premier-league/shadow/track";
import { freezeShadowForCompletedJobs, snapshotShadowPrediction } from "@/lib/competitions/premier-league/shadow/freeze";
import { explainShadowPrediction } from "@/lib/competitions/premier-league/shadow/explain";
import { shadowEvaluationReport } from "@/lib/competitions/premier-league/shadow/report";
import { auditShadowIntegrity } from "@/lib/competitions/premier-league/shadow/integrity";
import { compareFixture } from "@/lib/competitions/premier-league/shadow/compare";
import { upsertJob } from "@/lib/competitions/premier-league/ops/job-ledger";
import { archiveOperationalLiveOos } from "@/lib/competitions/premier-league/ops/operational-archive";
import type { PredictionJob } from "@/lib/competitions/premier-league/ops/types";
import {
  breakdownByOutcome,
  pairSettlements,
  pairedMetrics,
  probabilityBucket,
} from "@/lib/evaluation/paired";
import { predictPremierLeagueMatch, snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { createSnapshot, listSnapshots, getSnapshot } from "@/lib/snapshots/store";
import { settleFixture, loadSettlements } from "@/lib/competitions/premier-league/settlement";
import type { CanonicalMatch } from "@/lib/match-ledger/types";
import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import type { Fixture } from "@/lib/identity/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const sums1 = (h: number, d: number, a: number) => near(h + d + a, 1, 1e-9);

// ── Fixture helpers ───────────────────────────────────────────────────────
const COVENTRY_KICKOFF = "2026-08-21T19:00:00.000Z";
const RESULT_KNOWN = "2026-08-21T21:00:00.000Z";
/** Arsenal's real next fixture: away at Aston Villa, MD2. */
const NEXT_KICKOFF = "2026-08-31T19:00:00.000Z";
const NEXT_ASOF = "2026-08-30T19:00:00.000Z";

function ledgerMatch(input: {
  id: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  kickoff: string;
  observed: string;
  matchday?: number;
}): CanonicalMatch {
  return {
    schemaVersion: "match-ledger-v1",
    canonicalMatchId: input.id,
    competition: "premier-league",
    season: "2026-27",
    matchday: input.matchday ?? 1,
    stage: "REGULAR_SEASON",
    kickoffUtc: input.kickoff,
    home: { slug: input.home, providerTeamId: "1", name: input.home, shortName: null, tla: null },
    away: { slug: input.away, providerTeamId: "2", name: input.away, shortName: null, tla: null },
    status: "FINISHED",
    halfTimeHomeGoals: null,
    halfTimeAwayGoals: null,
    fullTimeHomeGoals: input.hg,
    fullTimeAwayGoals: input.ag,
    outcome: input.hg > input.ag ? "HOME" : input.hg < input.ag ? "AWAY" : "DRAW",
    resultObservedAt: input.observed,
    homeStatistics: null,
    awayStatistics: null,
    events: null,
    provenance: { result: null, statistics: null, events: null },
    observationIds: [],
    observationCount: 1,
    sources: ["test"],
    corrections: [],
    firstObservedAt: input.observed,
    lastObservedAt: input.observed,
  };
}

const ARSENAL_COVENTRY = ledgerMatch({
  id: "pl-2026-27-arsenal-coventry",
  home: "arsenal",
  away: "coventry",
  hg: 3,
  ag: 0,
  kickoff: COVENTRY_KICKOFF,
  observed: RESULT_KNOWN,
});

// ══════════════════════════════════════════════════════════════════════════
// Core shrinkage math
// ══════════════════════════════════════════════════════════════════════════
check("prior equivalent is 8, matching the rating layer", PRIOR_MATCH_EQUIVALENT === 8);
check("zero matches → zero weight", currentSeasonWeight(0) === 0);
check("one match → 1/9", near(currentSeasonWeight(1), 1 / 9, 1e-12));
check("three matches → 3/11", near(currentSeasonWeight(3), 3 / 11, 1e-12));
check("eight matches → exactly one half", near(currentSeasonWeight(8), 0.5, 1e-12));
check("weight is strictly monotonic in n", (() => {
  for (let n = 0; n < 80; n++) if (currentSeasonWeight(n + 1) <= currentSeasonWeight(n)) return false;
  return true;
})());
check("weight is bounded below 1", currentSeasonWeight(1e6) < 1);

// The estimator IS the documented blend law — proven, not asserted.
check("posterior mean equals 1 + w(n)(r-1)", (() => {
  let worst = 0;
  for (const n of [1, 2, 3, 5, 8, 13, 19, 38]) {
    for (const lam of [0.7, 1.4, 2.3]) {
      for (const g of [0, 1, 2, 4, 9]) {
        const E = n * lam;
        const predicted = 1 + currentSeasonWeight(n) * (g / E - 1);
        if (predicted > ADJUSTMENT_CAP || predicted < 1 / ADJUSTMENT_CAP) continue;
        worst = Math.max(worst, Math.abs(posteriorRateMultiplier(g, E, n).multiplier - predicted));
      }
    }
  }
  return worst < 1e-12;
})());
check("no evidence → multiplier exactly 1", posteriorRateMultiplier(0, 0, 0).multiplier === 1);
check("zero expectation → multiplier exactly 1", posteriorRateMultiplier(5, 0, 3).multiplier === 1);
check("scoring exactly as expected → multiplier 1", near(posteriorRateMultiplier(14, 14, 10).multiplier, 1, 1e-12));
check("multiplier is capped above", posteriorRateMultiplier(500, 1, 50).multiplier === ADJUSTMENT_CAP);
check("multiplier is capped below", near(posteriorRateMultiplier(0, 500, 50).multiplier, 1 / ADJUSTMENT_CAP, 1e-12));
check("capping is reported, not hidden", posteriorRateMultiplier(500, 1, 50).capped === true);
check("uncapped result reports capped=false", posteriorRateMultiplier(3, 1.4, 1).capped === false);
// 8-match transition: at n=8 the residual gets exactly half weight.
check("8-match transition halves the raw residual", (() => {
  const lam = 1.5;
  const n = 8;
  const g = n * lam * 2; // scoring at double the expected rate
  const m = posteriorRateMultiplier(g, n * lam, n).multiplier;
  return near(m, 1 + 0.5 * (2 - 1), 1e-12);
})());
// Documented characteristic: a zero count is scale-free in expected goals, so a
// clean sheet depends on matches played, not on who the opponent was. Recorded
// as a gate so the property cannot change silently.
check("zero count is scale-free: clean sheet multiplier = k/(k+n)", (() => {
  const vsWeak = posteriorRateMultiplier(0, 0.6, 1).multiplier;
  const vsStrong = posteriorRateMultiplier(0, 2.4, 1).multiplier;
  return near(vsWeak, vsStrong, 1e-12) && near(vsWeak, 8 / 9, 1e-12);
})());
check("zero count still shrinks with more matches", (() => {
  return posteriorRateMultiplier(0, 3, 3).multiplier < posteriorRateMultiplier(0, 1, 1).multiplier;
})());
check("NON-zero defensive residuals DO depend on the opponent", (() => {
  const vsWeak = posteriorRateMultiplier(1, 0.6, 1).multiplier;
  const vsStrong = posteriorRateMultiplier(1, 2.4, 1).multiplier;
  return Math.abs(vsWeak - vsStrong) > 1e-6;
})());
check("more evidence moves the multiplier further for the same ratio", (() => {
  const ratio = 1.5;
  const at3 = posteriorRateMultiplier(3 * 1.4 * ratio, 3 * 1.4, 3).multiplier;
  const at12 = posteriorRateMultiplier(12 * 1.4 * ratio, 12 * 1.4, 12).multiplier;
  return at12 > at3;
})());

// ── Strength folding ─────────────────────────────────────────────────────
const neutral = neutralStrength();
check("neutral strength has zero matches", neutral.matchesPlayed === 0);
check("neutral attack multiplier is 1", neutral.attackMultiplier === 1);
check("neutral defence multiplier is 1", neutral.defenceMultiplier === 1);
const overperform = currentSeasonStrength([
  { goalsFor: 3, goalsAgainst: 0, expectedFor: 1.4, expectedAgainst: 1.1 },
]);
check("overperforming attack raises the multiplier", overperform.attackMultiplier > 1);
check("clean sheet lowers the concede multiplier", overperform.defenceMultiplier < 1);
check("raw ratio reported alongside the shrunk value", near(overperform.rawAttackRatio!, 3 / 1.4, 1e-12));
check("one 3-0 moves attack by ~12.7%, not 114%", near(overperform.attackMultiplier, 1 + (1 / 9) * (3 / 1.4 - 1), 1e-12), overperform.attackMultiplier.toFixed(4));

// ── λ adjustment ─────────────────────────────────────────────────────────
const adj = adjustedGoalExpectations({
  baselineHomeLambda: 1.6,
  baselineAwayLambda: 1.1,
  home: overperform,
  away: neutral,
});
check("home λ rises with home attack overperformance", adj.homeLambda > 1.6);
check("away λ falls against a strong defence", adj.awayLambda < 1.1);
check("neutral both sides is a no-op", (() => {
  const a = adjustedGoalExpectations({
    baselineHomeLambda: 1.6,
    baselineAwayLambda: 1.1,
    home: neutral,
    away: neutral,
  });
  return a.homeLambda === 1.6 && a.awayLambda === 1.1;
})());
check("λ stays inside the base model's band", (() => {
  const extreme = currentSeasonStrength(
    Array.from({ length: 30 }, () => ({ goalsFor: 9, goalsAgainst: 0, expectedFor: 1, expectedAgainst: 1 }))
  );
  const a = adjustedGoalExpectations({
    baselineHomeLambda: 3.4,
    baselineAwayLambda: 0.35,
    home: extreme,
    away: extreme,
  });
  return a.homeLambda <= 3.5 && a.awayLambda >= 0.3;
})());

// ══════════════════════════════════════════════════════════════════════════
// Shadow prediction behaviour
// ══════════════════════════════════════════════════════════════════════════

// (1) Zero evidence → shadow reproduces the baseline EXACTLY.
const cold = predictPremierLeagueShadow({
  homeSlug: "arsenal",
  awaySlug: "coventry",
  asOf: "2026-08-20T12:00:00.000Z",
  fixtureId: "pl-2026-27-arsenal-coventry",
  ledgerMatches: [],
});
check("cold start: zero current-season matches", cold.features.homeStrength.matchesPlayed === 0);
check("cold start: shadow HOME == baseline HOME exactly", cold.home === cold.baseline.home);
check("cold start: shadow DRAW == baseline DRAW exactly", cold.draw === cold.baseline.draw);
check("cold start: shadow AWAY == baseline AWAY exactly", cold.away === cold.baseline.away);
check("cold start: λ unchanged", cold.homeExpectedGoals === cold.baseline.homeExpectedGoals);
check("cold start probabilities sum to 1", sums1(cold.home, cold.draw, cold.away));
check("cold start weight is zero", cold.features.homeStrength.currentSeasonWeight === 0);

// The shadow must agree with the actual production model, not merely with its
// own internal baseline copy.
const productionCold = predictPremierLeagueMatch("arsenal", "coventry", {
  asOf: "2026-08-20T12:00:00.000Z",
  fixtureId: "pl-2026-27-arsenal-coventry",
});
check(
  "cold start matches the REAL production model's HOME probability",
  near(cold.home, productionCold.teamAWinProbability, 1e-12),
  `${cold.home.toFixed(6)} vs ${productionCold.teamAWinProbability.toFixed(6)}`
);
check(
  "cold start matches the REAL production model's DRAW probability",
  near(cold.draw, productionCold.drawProbability, 1e-12)
);
check(
  "cold start matches the REAL production model's AWAY probability",
  near(cold.away, productionCold.teamBWinProbability, 1e-12)
);

// (2) After Arsenal 3-0 Coventry, Arsenal's NEXT fixture diverges.
const next = predictPremierLeagueShadow({
  homeSlug: "aston-villa",
  awaySlug: "arsenal",
  asOf: NEXT_ASOF,
  fixtureId: "pl-2026-27-aston-villa-arsenal",
  ledgerMatches: [ARSENAL_COVENTRY],
});
check("next fixture sees Arsenal's one match", next.features.awayStrength.matchesPlayed === 1);
check("next fixture sees Villa with no matches", next.features.homeStrength.matchesPlayed === 0);
check("next fixture probabilities sum to 1", sums1(next.home, next.draw, next.away));
check("baseline probabilities also sum to 1", sums1(next.baseline.home, next.baseline.draw, next.baseline.away));
check("Arsenal's 3-0 raises their away win probability", next.away > next.baseline.away, `${(next.away * 100).toFixed(2)}% vs ${(next.baseline.away * 100).toFixed(2)}%`);
check("the move is small, not extreme", Math.abs(next.away - next.baseline.away) < 0.06, `${((next.away - next.baseline.away) * 100).toFixed(2)}pp`);
check("current-season weight is 1/9 at one match", near(next.features.awayStrength.currentSeasonWeight, 1 / 9, 1e-12));
check("evidence match id recorded", next.features.awayMatchIds.includes("pl-2026-27-arsenal-coventry"));
check("feature cutoff recorded", next.features.featureCutoff === NEXT_ASOF);
check("latest evidence kickoff recorded", next.features.latestEvidenceKickoff === COVENTRY_KICKOFF);
check("latest evidence availability recorded", next.features.latestEvidenceObservedAt === RESULT_KNOWN);

// (3) Opponent strength matters: the same 3-0 against a stronger side moves more.
const vsStrong = ledgerMatch({
  id: "pl-2026-27-arsenal-liverpool",
  home: "arsenal",
  away: "liverpool",
  hg: 3,
  ag: 0,
  kickoff: COVENTRY_KICKOFF,
  observed: RESULT_KNOWN,
});
const afterWeak = predictPremierLeagueShadow({
  homeSlug: "aston-villa", awaySlug: "arsenal", asOf: NEXT_ASOF,
  fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [ARSENAL_COVENTRY],
});
const afterStrong = predictPremierLeagueShadow({
  homeSlug: "aston-villa", awaySlug: "arsenal", asOf: NEXT_ASOF,
  fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [vsStrong],
});
check(
  "3-0 vs a stronger opponent is stronger evidence than 3-0 vs a weaker one",
  afterStrong.features.awayStrength.attackMultiplier > afterWeak.features.awayStrength.attackMultiplier,
  `${afterStrong.features.awayStrength.attackMultiplier.toFixed(4)} vs ${afterWeak.features.awayStrength.attackMultiplier.toFixed(4)}`
);
check(
  "opponent strength enters via the model's own expectation, not a heuristic",
  afterStrong.features.awayStrength.expectedGoalsFor !== afterWeak.features.awayStrength.expectedGoalsFor
);
// Same 3-0, different opponents: attack (G>0) moves with E, defence (G=0) does not.
check(
  "clean-sheet defence residual is identical vs weak and strong opponents",
  near(
    afterStrong.features.awayStrength.defenceMultiplier,
    afterWeak.features.awayStrength.defenceMultiplier,
    1e-12
  ),
  `${afterStrong.features.awayStrength.defenceMultiplier.toFixed(6)} vs ${afterWeak.features.awayStrength.defenceMultiplier.toFixed(6)}`
);
check(
  "that shared clean-sheet multiplier equals k/(k+n), not a function of E",
  near(afterWeak.features.awayStrength.defenceMultiplier, PRIOR_MATCH_EQUIVALENT / (PRIOR_MATCH_EQUIVALENT + 1), 1e-12)
);
check(
  "the two clean sheets DID have different expected goals against",
  afterStrong.features.awayStrength.expectedGoalsAgainst !== afterWeak.features.awayStrength.expectedGoalsAgainst
);

// (4) Home/away treatment: the baseline expectation differs by venue, so the
//     same scoreline away is different evidence from the same scoreline home.
const awayWin = ledgerMatch({
  id: "pl-2026-27-coventry-arsenal", home: "coventry", away: "arsenal",
  hg: 0, ag: 3, kickoff: COVENTRY_KICKOFF, observed: RESULT_KNOWN,
});
const homeObs = strengthObservationsFor("arsenal", [ARSENAL_COVENTRY]);
const awayObs = strengthObservationsFor("arsenal", [awayWin]);
check("scoring 3 is recorded for both venues", homeObs[0].goalsFor === 3 && awayObs[0].goalsFor === 3);
check(
  "the expectation differs by venue (home advantage is priced in)",
  homeObs[0].expectedFor !== awayObs[0].expectedFor,
  `home λ ${homeObs[0].expectedFor.toFixed(3)} vs away λ ${awayObs[0].expectedFor.toFixed(3)}`
);
check("home expectation exceeds away expectation", homeObs[0].expectedFor > awayObs[0].expectedFor);
check(
  "so an away 3-0 is stronger evidence than a home 3-0",
  currentSeasonStrength(awayObs).attackMultiplier > currentSeasonStrength(homeObs).attackMultiplier
);

// ══════════════════════════════════════════════════════════════════════════
// LEAKAGE — HARD RELEASE GATE
// ══════════════════════════════════════════════════════════════════════════

// (a) A fixture can never see its own result, even recomputed long after FT.
const selfLeak = predictPremierLeagueShadow({
  homeSlug: "arsenal",
  awaySlug: "coventry",
  asOf: "2026-08-20T12:00:00.000Z",
  fixtureId: "pl-2026-27-arsenal-coventry",
  ledgerMatches: [ARSENAL_COVENTRY],
});
check("LEAKAGE: own result excluded at the original cutoff", selfLeak.features.homeStrength.matchesPlayed === 0);
check("LEAKAGE: own-result prediction equals the baseline exactly", selfLeak.home === selfLeak.baseline.home);
const selfLeakLater = predictPremierLeagueShadow({
  homeSlug: "arsenal",
  awaySlug: "coventry",
  asOf: "2026-12-01T00:00:00.000Z", // long after full time
  fixtureId: "pl-2026-27-arsenal-coventry",
  ledgerMatches: [ARSENAL_COVENTRY],
});
check(
  "LEAKAGE: own result still excluded when recomputed months later",
  selfLeakLater.features.homeStrength.matchesPlayed === 0
);
check(
  "LEAKAGE: recomputed-late prediction is still the baseline",
  selfLeakLater.home === selfLeakLater.baseline.home
);

// (b) A result not yet known cannot be used.
const beforeKnown = predictPremierLeagueShadow({
  homeSlug: "aston-villa", awaySlug: "arsenal",
  asOf: "2026-08-21T20:00:00.000Z", // after kickoff, before the result was observed
  fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [ARSENAL_COVENTRY],
});
check("LEAKAGE: result unusable before it was observed", beforeKnown.features.awayStrength.matchesPlayed === 0);

// (c) A future match can never be history.
const future = ledgerMatch({
  id: "pl-2026-27-arsenal-chelsea", home: "arsenal", away: "chelsea",
  hg: 4, ag: 0, kickoff: "2026-09-06T15:30:00.000Z", observed: "2026-09-06T17:30:00.000Z",
});
const withFuture = predictPremierLeagueShadow({
  homeSlug: "aston-villa", awaySlug: "arsenal", asOf: NEXT_ASOF,
  fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [ARSENAL_COVENTRY, future],
});
check("LEAKAGE: a future match is excluded", withFuture.features.awayStrength.matchesPlayed === 1);
check("LEAKAGE: excluding the future leaves the one-match result", withFuture.away === next.away);

// (d) Season and competition isolation.
const otherSeason = { ...ARSENAL_COVENTRY, canonicalMatchId: "pl-2025-26-x", season: "2025-26" };
check("LEAKAGE: another season's match is excluded", predictPremierLeagueShadow({
  homeSlug: "aston-villa", awaySlug: "arsenal", asOf: NEXT_ASOF,
  fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [otherSeason as CanonicalMatch],
}).features.awayStrength.matchesPlayed === 0);

// ══════════════════════════════════════════════════════════════════════════
/**
 * Pairing/immutability fixture id.
 *
 * Deliberately NOT a real 2026-27 fixture id: loadCommittedLiveOos is pinned to
 * the canonical 380-row tape, so every real fixture already carries a committed
 * baseline snapshot. Settling one here would mix production evidence into these
 * gates. A separate check below asserts that the real-tape behaviour still works.
 */
const PAIR_FIXTURE = "pl-2026-27-shadowpairing-fixture";

async function main() {
  // ── Baseline immutability (HARD GATE) ───────────────────────────────────
  const baselineSnap = snapshotPremierLeagueMatch("aston-villa", "arsenal", {
    asOf: NEXT_ASOF,
    kickoff: NEXT_KICKOFF,
    fixtureId: PAIR_FIXTURE,
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    origin: "scheduled",
    computedAt: NEXT_ASOF,
  });
  const baselineHomeProb = baselineSnap.homeProbability;
  const baselineKey = baselineSnap.provenance.uniqueKey;
  check("baseline snapshot uses the production version", baselineSnap.modelVersion === PRODUCTION_MODEL_VERSION);

  const { snapshot: shadowSnap } = snapshotShadowPrediction({
    fixtureId: PAIR_FIXTURE,
    homeSlug: "aston-villa",
    awaySlug: "arsenal",
    kickoffUtc: NEXT_KICKOFF,
    plannedAsOf: NEXT_ASOF,
    predictionStage: "T24H",
    computedAt: NEXT_ASOF,
    ledgerMatches: [ARSENAL_COVENTRY],
  });
  check("shadow snapshot uses the shadow version", shadowSnap.modelVersion === SHADOW_MODEL_VERSION);
  check("shadow and baseline are DIFFERENT records", shadowSnap.provenance.uniqueKey !== baselineKey);
  check("shadow shares the baseline's fixture", shadowSnap.fixtureId === baselineSnap.fixtureId);
  check("shadow shares the baseline's cutoff", shadowSnap.asOf === baselineSnap.asOf);
  check("shadow shares the baseline's stage", String(shadowSnap.predictionStage) === String(baselineSnap.predictionStage));
  check("shadow probabilities sum to 1", sums1(shadowSnap.homeProbability, shadowSnap.drawProbability, shadowSnap.awayProbability));

  const baselineAfter = getSnapshot(PAIR_FIXTURE, PRODUCTION_MODEL_VERSION, { asOf: NEXT_ASOF });
  check(
    "IMMUTABILITY: baseline probability unchanged after the shadow was frozen",
    baselineAfter!.homeProbability === baselineHomeProb
  );
  check("IMMUTABILITY: baseline key unchanged", baselineAfter!.provenance.uniqueKey === baselineKey);
  // Re-freezing the shadow must not create a second record or move anything.
  const refrozen = snapshotShadowPrediction({
    fixtureId: PAIR_FIXTURE,
    homeSlug: "aston-villa", awaySlug: "arsenal",
    kickoffUtc: NEXT_KICKOFF, plannedAsOf: NEXT_ASOF,
    predictionStage: "T24H", computedAt: NEXT_ASOF,
    ledgerMatches: [ARSENAL_COVENTRY, future], // MORE evidence offered
  });
  check(
    "IMMUTABILITY: re-freezing returns the ORIGINAL shadow record",
    refrozen.snapshot.homeProbability === shadowSnap.homeProbability
  );
  check(
    "IMMUTABILITY: a shadow snapshot cannot be overwritten with new evidence",
    refrozen.snapshot.provenance.uniqueKey === shadowSnap.provenance.uniqueKey
  );
  const versions = new Set(listSnapshots().map((s) => s.modelVersion));
  check("model-version isolation: both versions coexist", versions.has(PRODUCTION_MODEL_VERSION) && versions.has(SHADOW_MODEL_VERSION));
  check(
    "model-version isolation: one snapshot per version per key",
    listSnapshots().filter(
      (s) => s.fixtureId === PAIR_FIXTURE && s.modelVersion === SHADOW_MODEL_VERSION
    ).length === 1
  );

  // ── Feature provenance travels with the frozen prediction ───────────────
  const src = shadowSnap.sourceState as Record<string, unknown>;
  check("provenance: feature cutoff stored", src.featureCutoff === NEXT_ASOF);
  check("provenance: current-season match count stored", src.currentSeasonMatchesAway === 1);
  check("provenance: current-season weight stored", near(src.currentSeasonWeightAway as number, 1 / 9, 1e-12));
  check("provenance: attack multiplier stored", typeof src.attackMultiplierAway === "number");
  check("provenance: defence multiplier stored", typeof src.defenceMultiplierAway === "number");
  check("provenance: evidence match ids stored", Array.isArray(src.evidenceMatchIdsAway) && (src.evidenceMatchIdsAway as string[]).includes("pl-2026-27-arsenal-coventry"));
  check("provenance: the baseline it diverged from is stored", typeof src.baselineHome === "number");
  check("provenance: snapshot is marked experimental", shadowSnap.provenance.notes.includes("EXPERIMENTAL"));

  // ── Refusals ───────────────────────────────────────────────────────────
  check("shadow refuses a cutoff at/after kickoff", (() => {
    try {
      snapshotShadowPrediction({
        fixtureId: PAIR_FIXTURE, homeSlug: "aston-villa", awaySlug: "arsenal",
        kickoffUtc: NEXT_KICKOFF, plannedAsOf: NEXT_KICKOFF, predictionStage: "T24H",
        computedAt: NEXT_ASOF, ledgerMatches: [],
      });
      return false;
    } catch { return true; }
  })());
  check("shadow refuses computing after kickoff", (() => {
    try {
      snapshotShadowPrediction({
        fixtureId: PAIR_FIXTURE, homeSlug: "aston-villa", awaySlug: "arsenal",
        kickoffUtc: NEXT_KICKOFF, plannedAsOf: NEXT_ASOF, predictionStage: "T24H",
        computedAt: "2026-09-01T00:00:00.000Z", ledgerMatches: [],
      });
      return false;
    } catch { return true; }
  })());

  // ── Explanation layer ──────────────────────────────────────────────────
  const explanation = explainShadowPrediction(next);
  check("explanation names the fixture", explanation.fixture.includes("Arsenal"));
  check("explanation reports the pp delta", Math.abs(explanation.deltaAwayPp) > 0);
  check("explanation is not marked identical when it diverged", explanation.identicalToBaseline === false);
  check("explanation cites prior strength", explanation.reasons.some((r) => r.code === "prior-strength"));
  check("explanation cites the attack residual", explanation.reasons.some((r) => r.code === "attack-overperformance"));
  check("explanation cites shrinkage", explanation.reasons.some((r) => r.code === "small-sample-shrinkage"));
  check("explanation cites opponent strength", explanation.reasons.some((r) => r.code === "opponent-strength-embedded"));
  check("explanation records the zero-count caveat", (() => {
    const r = explanation.reasons.find((x) => x.code === "opponent-strength-embedded");
    return (
      r?.values.zeroCountCaveat === "clean sheets are scale-free in expected goals" &&
      /scale-free/.test(r.text) &&
      /clean sheet/.test(r.text)
    );
  })());
  check("clean-sheet defence copy does not attribute the residual to opponent strength", (() => {
    const r = explanation.reasons.find((x) => x.code === "defence-overperformance");
    return (
      r?.values.zeroCount === "true" &&
      /scale-free/.test(r.text) &&
      /does not depend on opponent strength/.test(r.text)
    );
  })());
  check("positive-count attack copy does not claim the zero-count caveat", (() => {
    const r = explanation.reasons.find((x) => x.code === "attack-overperformance");
    return r?.values.zeroCount === "false" && !/scale-free/.test(r.text);
  })());
  check("explanation cites the net λ effect", explanation.reasons.some((r) => r.code === "net-effect"));
  check("every reason carries its source numbers", explanation.reasons.every((r) => Object.keys(r.values).length > 0));
  check("explanation values match the prediction", (() => {
    const net = explanation.reasons.find((r) => r.code === "net-effect")!;
    return near(net.values.shadowHomeLambda as number, Number(next.homeExpectedGoals.toFixed(4)), 1e-9);
  })());
  const coldExplanation = explainShadowPrediction(cold);
  check("cold-start explanation says there is no divergence", coldExplanation.identicalToBaseline === true);
  check("cold-start explanation cites the absent evidence", coldExplanation.reasons.some((r) => r.code === "no-current-season-evidence"));

  // ── Paired settlement ──────────────────────────────────────────────────
  const finished: Fixture = {
    id: PAIR_FIXTURE,
    competition: "premier-league",
    season: "2026-27",
    date: "2026-08-31",
    kickoffUtc: NEXT_KICKOFF,
    homeSlug: "aston-villa",
    awaySlug: "arsenal",
    homeGoals: 1,
    awayGoals: 2,
    status: "FINISHED",
    venue: "home",
  };
  const settled = settleFixture(finished, "2026-08-31T21:00:00.000Z", { evaluationClass: "LIVE_OOS" });
  check("settling produces rows for BOTH models", settled.length === 2, String(settled.length));
  const settledVersions = new Set(settled.map((s) => s.modelVersion));
  check("settlement covers the baseline", settledVersions.has(PRODUCTION_MODEL_VERSION));
  check("settlement covers the shadow", settledVersions.has(SHADOW_MODEL_VERSION));
  check("each settlement scores its OWN frozen probabilities", (() => {
    const b = settled.find((s) => s.modelVersion === PRODUCTION_MODEL_VERSION)!;
    const s = settled.find((s) => s.modelVersion === SHADOW_MODEL_VERSION)!;
    return near(b.predicted.home, baselineHomeProb) && near(s.predicted.home, shadowSnap.homeProbability);
  })());

  const frozenComparison = compareFixture({
    fixtureId: PAIR_FIXTURE,
    homeSlug: "aston-villa",
    awaySlug: "arsenal",
    kickoffUtc: NEXT_KICKOFF,
    ledgerMatches: [ARSENAL_COVENTRY],
    season: "2026-27",
    now: "2026-08-31T21:30:00.000Z",
  });
  check("fixture comparison retains a canonical valid frozen pair", frozenComparison.pairedAndFrozen);
  check(
    "fixture comparison exposes the pair's common canonical stage",
    frozenComparison.baseline.predictionStage === "T24H" &&
      frozenComparison.shadow.predictionStage === "T24H"
  );
  check(
    "fixture comparison exposes only consistency-validated settlements",
    frozenComparison.baseline.settlement !== null && frozenComparison.shadow.settlement !== null
  );

  const settlementFile = process.env.SETTLEMENT_STORE_PATH!;
  const settlementBytes = fs.readFileSync(settlementFile, "utf8");
  try {
    const corruptBytes = settlementBytes
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const row = JSON.parse(line) as SettlementRecord;
        return JSON.stringify(
          row.snapshotUniqueKey === baselineKey ? { ...row, brier: row.brier + 0.25 } : row
        );
      })
      .join("\n");
    fs.writeFileSync(settlementFile, corruptBytes, "utf8");
    const corruptSettlementComparison = compareFixture({
      fixtureId: PAIR_FIXTURE,
      homeSlug: "aston-villa",
      awaySlug: "arsenal",
      kickoffUtc: NEXT_KICKOFF,
      ledgerMatches: [ARSENAL_COVENTRY],
      season: "2026-27",
      now: "2026-08-31T21:30:00.000Z",
    });
    check(
      "fixture comparison redacts a corrupt linked settlement",
      corruptSettlementComparison.baseline.settlement === null
    );
    check(
      "a corrupt settlement does not hide the consistent paired settlement",
      corruptSettlementComparison.shadow.settlement !== null
    );
  } finally {
    fs.writeFileSync(settlementFile, settlementBytes, "utf8");
  }

  const pairing = pairSettlements({
    settlements: loadSettlements(),
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
    season: "2026-27",
  });
  check("one paired settlement produced", pairing.pairs.length === 1);
  check("pair records the same actual outcome for both", pairing.pairs[0].actualOutcome === "away");
  check("pair records both model versions", pairing.pairs[0].baseline.modelVersion === PRODUCTION_MODEL_VERSION && pairing.pairs[0].shadow.modelVersion === SHADOW_MODEL_VERSION);
  check("pair records the shared freeze cutoff", pairing.pairs[0].asOf === NEXT_ASOF);
  check("pair computes a Brier delta", Number.isFinite(pairing.pairs[0].delta.brier));
  check("delta is shadow minus baseline", near(
    pairing.pairs[0].delta.brier,
    pairing.pairs[0].shadow.brier - pairing.pairs[0].baseline.brier
  ));
  check("pair records a probability bucket", pairing.pairs[0].probabilityBucket.length > 0);

  // Unpaired rows must NOT be folded into averages.
  const orphan: SettlementRecord = {
    ...settled[0],
    snapshotUniqueKey: "orphan-key",
    fixtureId: "pl-2026-27-orphan-fixture",
    modelVersion: PRODUCTION_MODEL_VERSION,
  };
  const withOrphan = pairSettlements({
    settlements: [...loadSettlements(), orphan],
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
    season: "2026-27",
  });
  check("an unpaired baseline settlement is excluded from pairs", withOrphan.pairs.length === 1);
  check("an unpaired baseline settlement is counted separately", withOrphan.baselineOnly === 1);
  // A pair settled against different results is rejected, not averaged.
  const conflicting = pairSettlements({
    settlements: [
      settled.find((s) => s.modelVersion === PRODUCTION_MODEL_VERSION)!,
      { ...settled.find((s) => s.modelVersion === SHADOW_MODEL_VERSION)!, actualOutcome: "home" as const },
    ],
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
  });
  check("a pair with disagreeing results is rejected", conflicting.pairs.length === 0);
  check("the rejected pair is reported", conflicting.inconsistent === 1);

  const lateShadow: SettlementRecord = {
    ...settled.find((s) => s.modelVersion === SHADOW_MODEL_VERSION)!,
    snapshotUniqueKey: settled
      .find((s) => s.modelVersion === SHADOW_MODEL_VERSION)!
      .snapshotUniqueKey.replace(NEXT_ASOF, "2026-08-31T18:59:00.000Z"),
  };
  const mismatched = pairSettlements({
    settlements: [
      settled.find((s) => s.modelVersion === PRODUCTION_MODEL_VERSION)!,
      lateShadow,
    ],
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
  });
  check("a cutoff mismatch is not a pair", mismatched.pairs.length === 0);
  check("a cutoff mismatch is counted separately", mismatched.cutoffMismatch === 1);
  check("a cutoff mismatch is not baseline-only", mismatched.baselineOnly === 0);

  // ── Paired metrics ─────────────────────────────────────────────────────
  const metrics = pairedMetrics(pairing.pairs);
  check("metrics count the pairs", metrics.n === 1);
  check("baseline mean Brier computed", metrics.baseline.brier !== null);
  check("shadow mean Brier computed", metrics.shadow.brier !== null);
  check("delta equals shadow minus baseline", near(metrics.delta.brier!, metrics.shadow.brier! - metrics.baseline.brier!));
  check("empty pair set yields nulls, not NaN", (() => {
    const m = pairedMetrics([]);
    return m.n === 0 && m.baseline.brier === null && m.delta.rps === null;
  })());
  check("outcome breakdown groups by actual result", breakdownByOutcome(pairing.pairs)[0].key === "away");
  check("probability buckets are labelled", probabilityBucket(0.55) === "50–60%");
  check("probability bucket handles the top edge", probabilityBucket(1) === "70%+");

  // ── Promotion gate ─────────────────────────────────────────────────────
  const report = shadowEvaluationReport("2026-27");
  check("production serves the BASELINE", report.servingVersion === PRODUCTION_MODEL_VERSION);
  check("production is never the shadow", report.servingVersion !== SHADOW_MODEL_VERSION);
  check("productionModelVersion() is the champion", productionModelVersion() === PRODUCTION_MODEL_VERSION);
  check("isShadowVersion identifies the challenger", isShadowVersion(SHADOW_MODEL_VERSION) && !isShadowVersion(PRODUCTION_MODEL_VERSION));
  check("report counts the paired settlement row", report.pairedSettlementRows === 1);
  check("report counts one independent paired fixture", report.uniquePairedFixtures === 1);
  check("one paired fixture remains EARLY_EVIDENCE", report.evaluationMaturity.status === "EARLY_EVIDENCE");
  check("headline metrics WITHHELD below the display threshold", report.metrics === null);
  check("sample note says the sample is insufficient", report.sampleNote.toLowerCase().includes("insufficient"));
  check("promotion status is NOT_ELIGIBLE", report.promotion.status === "NOT_ELIGIBLE");
  check("display threshold is 20", MIN_PAIRED_FOR_DISPLAY === 20);
  check("decision threshold is 50", MIN_PAIRED_FOR_DECISION === 50);
  check("headline metrics withheld at n=1", report.promotion.metricsVisible === false);
  check("n=19 does not unlock metrics", shadowMetricsVisible(19, true) === false);
  check("n=20 unlocks metrics when integrity holds", shadowMetricsVisible(20, true) === true);
  check("n=20 still withholds metrics if integrity failed", shadowMetricsVisible(20, false) === false);
  check(
    "n=20 metrics-visible is NOT promotion-eligible",
    shadowPromotionStatus({ uniquePairedFixtures: 20, integrityOk: true, hasProductionShadowFreeze: true }) ===
      "NOT_ELIGIBLE"
  );
  check(
    "n=49 still NOT_ELIGIBLE",
    shadowPromotionStatus({ uniquePairedFixtures: 49, integrityOk: true, hasProductionShadowFreeze: true }) ===
      "NOT_ELIGIBLE"
  );
  check(
    "n=50 with integrity and a freeze is UNDER_OBSERVATION, not promoted",
    shadowPromotionStatus({ uniquePairedFixtures: 50, integrityOk: true, hasProductionShadowFreeze: true }) ===
      "UNDER_OBSERVATION"
  );
  check(
    "n=50 without a production freeze stays NOT_ELIGIBLE",
    shadowPromotionStatus({ uniquePairedFixtures: 50, integrityOk: true, hasProductionShadowFreeze: false }) ===
      "NOT_ELIGIBLE"
  );
  check("promotion criteria are declared", PROMOTION_CRITERIA.length >= 8);
  check("accuracy is explicitly NOT a promotion criterion", PROMOTION_CRITERIA.some((c) => c.key === "accuracy-is-not-a-criterion"));
  check("calibration is a criterion", PROMOTION_CRITERIA.some((c) => c.key === "calibration"));
  check("stability across matchweeks is a criterion", PROMOTION_CRITERIA.some((c) => c.key === "stability"));
  check("shadow freezing defaults to enabled", shadowModelEnabled() === true);
  check("shadow freezing can be disabled", (() => {
    process.env.SHADOW_MODEL_ENABLED = "0";
    const off = shadowModelEnabled();
    delete process.env.SHADOW_MODEL_ENABLED;
    return off === false;
  })());
  check("disabling the shadow never changes what production serves", productionModelVersion() === PRODUCTION_MODEL_VERSION);
  check("collection reports resolved paired settlement rows separately from frozen snapshot pairs", report.collection.resolvedPairedSettlementRows === 1);
  check("collection does not treat a frozen-only pair as settled evidence", report.collection.settledSnapshotPairs === report.collection.resolvedPairedSettlementRows);
  check("promotion reasons mention the sample floor", report.promotion.reasons.some((r) => r.includes("display floor")));
  check("integrity is OK for the isolated pair", report.integrity.ok === true, report.integrity.issues.map((i) => i.code).join(","));

  // ── Public fixture-comparison validity gates ────────────────────────────
  function comparisonSnapshot(input: {
    fixtureId: string;
    modelVersion: string;
    kickoff: string;
    asOf: string;
    computedAt: string;
    stage: "PRESEASON" | "T24H" | "T2H";
    evaluationClass?: "LIVE_OOS" | "BACKTEST";
    latestIncludedInputAt?: string | null;
  }) {
    return createSnapshot({
      fixtureId: input.fixtureId,
      competition: "premier-league",
      season: "2026-27",
      asOf: input.asOf,
      kickoff: input.kickoff,
      modelVersion: input.modelVersion,
      predictionStage: input.stage,
      evaluationClass: input.evaluationClass ?? "LIVE_OOS",
      homeSlug: "chelsea",
      awaySlug: "fulham",
      home: input.modelVersion === PRODUCTION_MODEL_VERSION ? 0.5 : 0.48,
      draw: 0.27,
      away: input.modelVersion === PRODUCTION_MODEL_VERSION ? 0.23 : 0.25,
      homeExpectedGoals: 1.5,
      awayExpectedGoals: 1,
      scorelineDistribution: {},
      sourceState: {
        origin: "scheduled",
        computedAt: input.computedAt,
        latestEvidenceObservedAt: input.latestIncludedInputAt ?? null,
      },
    });
  }

  function comparisonPair(input: {
    fixtureId: string;
    kickoff: string;
    snapshotKickoff?: string;
    asOf: string;
    computedAt: string;
    baselineStage?: "PRESEASON" | "T24H" | "T2H";
    shadowStage?: "PRESEASON" | "T24H" | "T2H";
    evaluationClass?: "LIVE_OOS" | "BACKTEST";
    latestIncludedInputAt?: string | null;
  }) {
    const common = {
      fixtureId: input.fixtureId,
      kickoff: input.snapshotKickoff ?? input.kickoff,
      asOf: input.asOf,
      computedAt: input.computedAt,
      evaluationClass: input.evaluationClass,
      latestIncludedInputAt: input.latestIncludedInputAt,
    };
    comparisonSnapshot({
      ...common,
      modelVersion: PRODUCTION_MODEL_VERSION,
      stage: input.baselineStage ?? "T24H",
    });
    comparisonSnapshot({
      ...common,
      modelVersion: SHADOW_MODEL_VERSION,
      stage: input.shadowStage ?? "T24H",
    });
  }

  const invalidLaterAsOf = "2026-08-31T18:00:00.000Z";
  comparisonPair({
    fixtureId: PAIR_FIXTURE,
    kickoff: NEXT_KICKOFF,
    asOf: invalidLaterAsOf,
    computedAt: invalidLaterAsOf,
    baselineStage: "T2H",
    shadowStage: "T2H",
  });
  const invalidLaterComparison = compareFixture({
    fixtureId: PAIR_FIXTURE,
    homeSlug: "aston-villa",
    awaySlug: "arsenal",
    kickoffUtc: NEXT_KICKOFF,
    ledgerMatches: [ARSENAL_COVENTRY],
    season: "2026-27",
    now: "2026-08-31T21:30:00.000Z",
  });
  check(
    "a later mislabeled pair cannot displace the latest canonical frozen pair",
    invalidLaterComparison.pairedAndFrozen &&
      invalidLaterComparison.baseline.asOf === NEXT_ASOF &&
      invalidLaterComparison.baseline.predictionStage === "T24H"
  );

  const postKickFixture = "pl-2026-27-shadow-compare-post-kick";
  const postKickKickoff = "2026-09-20T15:00:00.000Z";
  comparisonPair({
    fixtureId: postKickFixture,
    kickoff: postKickKickoff,
    asOf: "2026-09-19T15:00:00.000Z",
    computedAt: "2026-09-20T15:01:00.000Z",
  });
  const postKickComparison = compareFixture({
    fixtureId: postKickFixture,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    kickoffUtc: postKickKickoff,
    ledgerMatches: [],
    season: "2026-27",
    now: "2026-09-20T16:00:00.000Z",
  });
  check(
    "post-kick generated rows are preview-only and never expose settlement",
    !postKickComparison.pairedAndFrozen &&
      !postKickComparison.baseline.frozen &&
      !postKickComparison.shadow.frozen &&
      postKickComparison.baseline.settlement === null &&
      postKickComparison.shadow.settlement === null
  );

  const obsoleteFixture = "pl-2026-27-shadow-compare-obsolete-kickoff";
  comparisonPair({
    fixtureId: obsoleteFixture,
    kickoff: "2026-09-22T15:00:00.000Z",
    snapshotKickoff: "2026-09-21T15:00:00.000Z",
    asOf: "2026-09-20T15:00:00.000Z",
    computedAt: "2026-09-20T15:00:00.000Z",
  });
  const obsoleteComparison = compareFixture({
    fixtureId: obsoleteFixture,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    kickoffUtc: "2026-09-22T15:00:00.000Z",
    ledgerMatches: [],
    season: "2026-27",
    now: "2026-09-20T16:00:00.000Z",
  });
  check("obsolete-kickoff rows cannot be labeled frozen", !obsoleteComparison.pairedAndFrozen);

  const stageMismatchFixture = "pl-2026-27-shadow-compare-stage-mismatch";
  comparisonPair({
    fixtureId: stageMismatchFixture,
    kickoff: "2026-09-24T15:00:00.000Z",
    asOf: "2026-09-23T15:00:00.000Z",
    computedAt: "2026-09-23T15:00:00.000Z",
    baselineStage: "T24H",
    shadowStage: "PRESEASON",
  });
  const stageMismatchComparison = compareFixture({
    fixtureId: stageMismatchFixture,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    kickoffUtc: "2026-09-24T15:00:00.000Z",
    ledgerMatches: [],
    season: "2026-27",
    now: "2026-09-23T16:00:00.000Z",
  });
  check(
    "same-cutoff snapshots at different canonical stages are not paired",
    !stageMismatchComparison.pairedAndFrozen
  );

  const futureInputFixture = "pl-2026-27-shadow-compare-future-input";
  comparisonPair({
    fixtureId: futureInputFixture,
    kickoff: "2026-09-26T15:00:00.000Z",
    asOf: "2026-09-25T15:00:00.000Z",
    computedAt: "2026-09-25T15:05:00.000Z",
    latestIncludedInputAt: "2026-09-25T15:01:00.000Z",
  });
  const futureInputComparison = compareFixture({
    fixtureId: futureInputFixture,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    kickoffUtc: "2026-09-26T15:00:00.000Z",
    ledgerMatches: [],
    season: "2026-27",
    now: "2026-09-25T16:00:00.000Z",
  });
  check(
    "rows that consumed input after cutoff cannot be labeled frozen",
    !futureInputComparison.pairedAndFrozen
  );

  const wrongClassFixture = "pl-2026-27-shadow-compare-backtest";
  comparisonPair({
    fixtureId: wrongClassFixture,
    kickoff: "2026-09-28T15:00:00.000Z",
    asOf: "2026-09-27T15:00:00.000Z",
    computedAt: "2026-09-27T15:00:00.000Z",
    evaluationClass: "BACKTEST",
  });
  const wrongClassComparison = compareFixture({
    fixtureId: wrongClassFixture,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    kickoffUtc: "2026-09-28T15:00:00.000Z",
    ledgerMatches: [],
    season: "2026-27",
    now: "2026-09-27T16:00:00.000Z",
  });
  check("BACKTEST rows cannot enter the public frozen comparison", !wrongClassComparison.pairedAndFrozen);

  // ── Freeze pipeline rehearsal (isolated; never writes production) ──────
  function succeededJob(input: {
    fixtureId: string;
    kickoff: string;
    asOf: string;
    snapshotKey: string;
  }): PredictionJob {
    return {
      jobId: `${input.fixtureId}::T24H::${input.kickoff}`,
      fixtureId: input.fixtureId,
      season: "2026-27",
      stage: "T24H",
      modelVersion: PRODUCTION_MODEL_VERSION,
      kickoffUtc: input.kickoff,
      scheduledFor: input.asOf,
      eligibleFrom: input.asOf,
      eligibleUntil: input.kickoff,
      plannedAsOf: input.asOf,
      origin: "scheduled",
      status: "SUCCEEDED",
      snapshotKey: input.snapshotKey,
      attemptedAt: input.asOf,
      completedAt: input.asOf,
      failureReason: null,
      failureClass: null,
      retryCount: 0,
      blockedReason: null,
      createdAt: input.asOf,
      updatedAt: input.asOf,
    };
  }

  // Historical baseline-only: a SUCCEEDED job + settlement, no shadow yet.
  // Freeze at the original cutoff after the result is known must be refused.
  upsertJob(
    succeededJob({
      fixtureId: PAIR_FIXTURE,
      kickoff: NEXT_KICKOFF,
      asOf: NEXT_ASOF,
      snapshotKey: baselineKey,
    })
  );
  const afterSettle = freezeShadowForCompletedJobs({
    now: NEXT_ASOF,
    ledgerMatches: [ARSENAL_COVENTRY],
  });
  check(
    "NO BACKFILL: freeze after settlement does not mint a new shadow",
    afterSettle.frozen === 0
  );
  check(
    "NO BACKFILL: the settled fixture is skipped, not reconstructed",
    afterSettle.skipped >= 1
  );

  const REHEARSE_ID = "pl-2026-27-shadowrehearse-fixture";
  const rehearseKick = "2026-09-12T15:00:00.000Z";
  const rehearseAsOf = "2026-09-11T15:00:00.000Z";
  const rehearseBaseline = snapshotPremierLeagueMatch("chelsea", "fulham", {
    asOf: rehearseAsOf,
    kickoff: rehearseKick,
    fixtureId: REHEARSE_ID,
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    origin: "scheduled",
    computedAt: rehearseAsOf,
  });
  archiveOperationalLiveOos([rehearseBaseline]);
  upsertJob(
    succeededJob({
      fixtureId: REHEARSE_ID,
      kickoff: rehearseKick,
      asOf: rehearseAsOf,
      snapshotKey: rehearseBaseline.provenance.uniqueKey,
    })
  );
  const firstFreeze = freezeShadowForCompletedJobs({
    now: rehearseAsOf,
    ledgerMatches: [],
  });
  check("rehearsal freeze mints exactly one shadow", firstFreeze.frozen === 1, String(firstFreeze.frozen));
  check("rehearsal freeze has no errors", firstFreeze.errors.length === 0, firstFreeze.errors.join("; "));
  const rehearseShadow = getSnapshot(REHEARSE_ID, SHADOW_MODEL_VERSION, { asOf: rehearseAsOf });
  check("rehearsal shadow exists", Boolean(rehearseShadow));
  check("rehearsal shadow shares the baseline cutoff", rehearseShadow!.asOf === rehearseBaseline.asOf);
  check("rehearsal shadow shares the baseline stage", String(rehearseShadow!.predictionStage) === String(rehearseBaseline.predictionStage));
  const shadowHome = rehearseShadow!.homeProbability;
  const secondFreeze = freezeShadowForCompletedJobs({
    now: "2026-09-11T16:00:00.000Z",
    ledgerMatches: [ARSENAL_COVENTRY],
  });
  check("rehearsal re-tick does not mint a duplicate", secondFreeze.frozen === 0);
  check("rehearsal re-tick reports already present", secondFreeze.alreadyPresent >= 1);
  const rereadShadow = getSnapshot(REHEARSE_ID, SHADOW_MODEL_VERSION, { asOf: rehearseAsOf });
  check("IMMUTABILITY: rehearsal shadow unchanged on re-tick", rereadShadow!.homeProbability === shadowHome);

  const afterKickoff = freezeShadowForCompletedJobs({
    now: "2026-09-12T16:00:00.000Z",
    ledgerMatches: [],
  });
  check("NO BACKFILL: freeze after kickoff is skipped", afterKickoff.frozen === 0);

  const rehearseFinished: Fixture = {
    id: REHEARSE_ID,
    competition: "premier-league",
    season: "2026-27",
    date: "2026-09-12",
    kickoffUtc: rehearseKick,
    homeSlug: "chelsea",
    awaySlug: "fulham",
    homeGoals: 2,
    awayGoals: 1,
    status: "FINISHED",
    venue: "home",
  };
  const rehearseSettled = settleFixture(rehearseFinished, "2026-09-12T17:00:00.000Z", {
    evaluationClass: "LIVE_OOS",
  });
  check("rehearsal settlement scores both frozen models", rehearseSettled.filter((s) => s.fixtureId === REHEARSE_ID).length >= 2);
  check("rehearsal settlement uses the frozen shadow probability", (() => {
    const row = rehearseSettled.find((s) => s.modelVersion === SHADOW_MODEL_VERSION && s.fixtureId === REHEARSE_ID);
    return Boolean(row) && near(row!.predicted.home, shadowHome);
  })());
  const rehearsePair = pairSettlements({
    settlements: loadSettlements().filter((s) => s.fixtureId === REHEARSE_ID),
    baselineVersion: PRODUCTION_MODEL_VERSION,
    shadowVersion: SHADOW_MODEL_VERSION,
  });
  check("rehearsal produces one paired settlement", rehearsePair.pairs.length === 1);
  check("rehearsal pair is at the freeze cutoff", rehearsePair.pairs[0].asOf === rehearseAsOf);

  const isolatedIntegrity = auditShadowIntegrity({
    snapshots: [baselineSnap, shadowSnap, rehearseBaseline, rehearseShadow!],
    settlements: loadSettlements().filter(
      (s) => s.fixtureId === PAIR_FIXTURE || s.fixtureId === REHEARSE_ID
    ),
    season: "2026-27",
  });
  check("integrity accepts genuine same-cutoff pairs", isolatedIntegrity.ok, isolatedIntegrity.issues.map((i) => i.code).join(","));
  check("integrity counts two frozen snapshot pairs", isolatedIntegrity.frozenSnapshotPairs === 2, String(isolatedIntegrity.frozenSnapshotPairs));
  check("integrity resolved paired rows equal the settled snapshot-pair count", isolatedIntegrity.resolvedPairedSettlementRows === isolatedIntegrity.settledSnapshotPairs);

  const orphanSnap = createSnapshot({
    fixtureId: "pl-2026-27-shadoworphan-fixture",
    competition: "premier-league",
    season: "2026-27",
    asOf: rehearseAsOf,
    kickoff: rehearseKick,
    modelVersion: SHADOW_MODEL_VERSION,
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    homeSlug: "chelsea",
    awaySlug: "fulham",
    home: 0.4,
    draw: 0.3,
    away: 0.3,
    homeExpectedGoals: 1.2,
    awayExpectedGoals: 1.1,
    scorelineDistribution: {},
  });
  const orphanAudit = auditShadowIntegrity({
    snapshots: [orphanSnap],
    settlements: [],
    season: "2026-27",
  });
  check("integrity fails a shadow with no baseline", orphanAudit.ok === false);
  check("integrity reports shadow-without-baseline", orphanAudit.issues.some((i) => i.code === "shadow-without-baseline"));
  check("orphan shadow is not a resolved paired settlement row", orphanAudit.resolvedPairedSettlementRows === 0);

  const missedKickoff = "2026-08-10T15:00:00.000Z";
  const missedAsOf = "2026-08-09T15:00:00.000Z";
  const missedBaseline = snapshotPremierLeagueMatch("chelsea", "fulham", {
    asOf: missedAsOf,
    kickoff: missedKickoff,
    fixtureId: "pl-2026-27-shadowmissed-fixture",
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    origin: "scheduled",
    computedAt: missedAsOf,
  });
  const missedJob = succeededJob({
    fixtureId: "pl-2026-27-shadowmissed-fixture",
    kickoff: missedKickoff,
    asOf: missedAsOf,
    snapshotKey: missedBaseline.provenance.uniqueKey,
  });
  missedJob.status = "MISSED";
  missedJob.eligibleUntil = "2026-08-09T17:00:00.000Z";
  const missedAudit = auditShadowIntegrity({
    snapshots: [missedBaseline],
    settlements: [],
    jobs: [missedJob],
    now: "2026-08-22T12:00:00.000Z",
    season: "2026-27",
  });
  check(
    "closed freeze window without a shadow pair is reported",
    missedAudit.issues.some((i) => i.code === "missed-shadow-freeze-window")
  );
  check("MISSED_SHADOW_FREEZE_WINDOW does not fail integrity.ok", missedAudit.ok === true);
  check("missed window count is 1", missedAudit.missedShadowFreezeWindows === 1);
  const missedFreeze = freezeShadowForCompletedJobs({
    now: "2026-08-22T12:00:00.000Z",
    ledgerMatches: [],
  });
  check(
    "a missed window is NOT backfilled",
    !getSnapshot("pl-2026-27-shadowmissed-fixture", SHADOW_MODEL_VERSION, { asOf: missedAsOf })
  );
  void missedFreeze;

  // ══════════════════════════════════════════════════════════════════════
  // ARSENAL 3-0 SANITY CASE
  // ══════════════════════════════════════════════════════════════════════
  // Freeze Arsenal-Coventry BEFORE kickoff, with no evidence available.
  const arsenalFrozen = createSnapshot({
    fixtureId: "pl-2026-27-arsenal-coventry",
    competition: "premier-league",
    season: "2026-27",
    asOf: "2026-08-20T19:00:00.000Z",
    kickoff: COVENTRY_KICKOFF,
    modelVersion: SHADOW_MODEL_VERSION,
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    homeSlug: "arsenal",
    awaySlug: "coventry",
    home: selfLeak.home,
    draw: selfLeak.draw,
    away: selfLeak.away,
    homeExpectedGoals: selfLeak.homeExpectedGoals,
    awayExpectedGoals: selfLeak.awayExpectedGoals,
    scorelineDistribution: {},
  });
  const frozenHome = arsenalFrozen.homeProbability;

  // Now the 3-0 is observed and Arsenal's next fixture is predicted.
  const afterResult = predictPremierLeagueShadow({
    homeSlug: "aston-villa", awaySlug: "arsenal", asOf: NEXT_ASOF,
    fixtureId: "pl-2026-27-aston-villa-arsenal", ledgerMatches: [ARSENAL_COVENTRY],
  });
  const reread = getSnapshot("pl-2026-27-arsenal-coventry", SHADOW_MODEL_VERSION, {
    asOf: "2026-08-20T19:00:00.000Z",
  });
  check("SANITY: Arsenal-Coventry frozen prediction still exists", Boolean(reread));
  check("SANITY: its probability is UNCHANGED after the 3-0", reread!.homeProbability === frozenHome);
  check("SANITY: the 3-0 DOES affect Arsenal's next fixture", afterResult.away !== afterResult.baseline.away);
  check("SANITY: the next-fixture update is limited by shrinkage", (() => {
    const raw = afterResult.features.awayStrength.rawAttackRatio!;
    const shrunk = afterResult.features.awayStrength.attackMultiplier;
    // The applied multiplier must be far closer to 1 than the raw ratio is.
    return Math.abs(shrunk - 1) < Math.abs(raw - 1) * 0.2;
  })(), `raw ${afterResult.features.awayStrength.rawAttackRatio!.toFixed(3)} → applied ${afterResult.features.awayStrength.attackMultiplier.toFixed(4)}`);
  check("SANITY: exactly one match of evidence was used", afterResult.features.awayStrength.matchesPlayed === 1);
  check("SANITY: the baseline for the next fixture is untouched", (() => {
    const b = predictPremierLeagueMatch("aston-villa", "arsenal", { asOf: NEXT_ASOF });
    return near(b.teamAWinProbability, afterResult.baseline.home, 1e-12);
  })());

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nShadow model gates: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
