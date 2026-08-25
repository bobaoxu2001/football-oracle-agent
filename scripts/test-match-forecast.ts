/**
 * Match Forecast Engine + Match Agent V1 regression gates.
 *
 * Covers the canonical score distribution, derived markets, temporal cutoff,
 * production/shadow isolation, immutable timeline comparison, Agent grounding,
 * API error handling, privacy and abuse controls.
 */

process.env.MATCH_AGENT_LLM_ENABLED = "0";

import { scorelineGridFromGoals } from "@/lib/prediction-engine/elo";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { SHADOW_MODEL_VERSION } from "@/lib/competitions/premier-league/shadow/track";
import { loadCommittedLiveOos } from "@/lib/snapshots/store";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import type { Fixture } from "@/lib/identity/types";
import {
  assertForecastInvariants,
  deriveForecastMath,
  PROBABILITY_TOLERANCE,
} from "@/lib/match-forecast/derive";
import {
  buildMatchForecast,
  compareForecastSnapshots,
  forecastTimeline,
  isAvailableAtCutoff,
  isProductionForecastSnapshot,
  MatchForecastError,
  productionSnapshotsForMatch,
  resolvePremierLeagueFixture,
  selectProductionSnapshot,
} from "@/lib/match-forecast/service";
import { clearMatchAgentCacheForTests, runMatchAgent } from "@/lib/match-forecast/agent";
import {
  getMarketProbabilities,
  getMatchContext,
  getScoreDistribution,
  runSupportedScenario,
} from "@/lib/match-forecast/tools";
import {
  anonymousRateLimitKey,
  resetMatchAgentRateLimitsForTests,
  takeMatchAgentRateLimit,
} from "@/lib/match-forecast/rate-limit";
import { GET as intelligenceGet } from "@/app/api/matches/[matchId]/intelligence/route";
import { POST as agentPost } from "@/app/api/matches/[matchId]/agent/route";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tolerance = PROBABILITY_TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance;
}

function matrix(lambdaHome = 1.8, lambdaAway = 1.1, rho = -0.061): number[][] {
  const out = Array.from({ length: 9 }, () => Array(9).fill(0));
  for (const cell of scorelineGridFromGoals(lambdaHome, lambdaAway, rho)) {
    out[cell.a][cell.b] = cell.p;
  }
  return out;
}

function snapshotFor(
  fixture: Fixture,
  input: {
    modelVersion?: string;
    asOf?: string;
    lambdaHome?: number;
    lambdaAway?: number;
    stage?: PredictionSnapshot["predictionStage"];
  } = {}
): PredictionSnapshot {
  const lambdaHome = input.lambdaHome ?? 1.8;
  const lambdaAway = input.lambdaAway ?? 1.1;
  const rho = -0.061;
  const scoreGrid = scorelineGridFromGoals(lambdaHome, lambdaAway, rho);
  const math = deriveForecastMath(matrix(lambdaHome, lambdaAway, rho));
  const modelVersion = input.modelVersion ?? PRODUCTION_MODEL_VERSION;
  const asOf = input.asOf ?? "2026-08-20T10:00:00.000Z";
  const stage = input.stage ?? "EARLY";
  const key = `premier-league::${fixture.season}::${fixture.id}::${modelVersion}::${stage}::${asOf}`;
  return {
    competition: "premier-league",
    season: fixture.season,
    fixtureId: fixture.id,
    homeTeam: fixture.homeSlug,
    awayTeam: fixture.awaySlug,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoff: fixture.kickoffUtc ?? null,
    createdAt: asOf,
    asOf,
    dataCutoff: asOf,
    modelVersion,
    predictionStage: stage,
    evaluationClass: "LIVE_OOS",
    homeProbability: math.result.homeWin,
    drawProbability: math.result.draw,
    awayProbability: math.result.awayWin,
    homeGoalExpectation: lambdaHome,
    awayGoalExpectation: lambdaAway,
    scorelineDistribution: Object.fromEntries(
      scoreGrid.map((cell) => [`${cell.a}–${cell.b}`, cell.p])
    ),
    modelParameters: {
      dcRho: rho,
      trainingWindow: { from: "2018-08-01", to: "2025-05-31" },
    },
    sourceState: {
      eloHome: 1700,
      eloAway: 1600,
      ratingStateAsOf: asOf,
      fixtureDataVersion: "test-fixtures-v1",
    },
    provenance: { store: "memory", uniqueKey: key, notes: "test fixture" },
    market: null,
    home: math.result.homeWin,
    draw: math.result.draw,
    away: math.result.awayWin,
    homeExpectedGoals: lambdaHome,
    awayExpectedGoals: lambdaAway,
  };
}

async function main() {
  console.log("\n── Probability mathematics ────────────────────────────────────────");
  const scoreMatrix = matrix();
  const math = deriveForecastMath(scoreMatrix);
  check("score matrix sums to 1", near(scoreMatrix.flat().reduce((s, p) => s + p, 0), 1));
  check("1X2 sums to 1", near(math.result.homeWin + math.result.draw + math.result.awayWin, 1));
  check("O/U 0.5 complements", near(math.totals.over05 + math.totals.under05, 1));
  check("O/U 1.5 complements", near(math.totals.over15 + math.totals.under15, 1));
  check("O/U 2.5 complements", near(math.totals.over25 + math.totals.under25, 1));
  check("O/U 3.5 complements", near(math.totals.over35 + math.totals.under35, 1));
  check("O/U 4.5 complements", near(math.totals.over45 + math.totals.under45, 1));
  check("BTTS complements", near(math.btts.yes + math.btts.no, 1));
  check("DNB normalizes", near(math.drawNoBet.home + math.drawNoBet.away, 1));
  check("double chance 1X derived", near(math.doubleChance.homeOrDraw, math.result.homeWin + math.result.draw));
  check("team home O/U 2.5 complements", near(math.teamTotals.home.over25 + math.teamTotals.home.under25, 1));
  check("team away O/U 2.5 complements", near(math.teamTotals.away.over25 + math.teamTotals.away.under25, 1));
  check(
    "every exact score equals its matrix cell",
    math.exactScores.every((score) => near(score.probability, scoreMatrix[score.homeGoals][score.awayGoals]))
  );

  console.log("\n── Canonical production forecast ──────────────────────────────────");
  const fixture = resolvePremierLeagueFixture("pl-2026-27-arsenal-chelsea");
  const realSnapshot = selectProductionSnapshot(fixture);
  const realForecast = buildMatchForecast(fixture, realSnapshot);
  assertForecastInvariants(realForecast);
  check("real supported match resolves", realForecast.matchId === fixture.id);
  check("real forecast is production", realForecast.modelRole === "production");
  check("real forecast version is champion", realForecast.modelVersion === PRODUCTION_MODEL_VERSION);
  check("real forecast cutoff precedes kickoff", Date.parse(realForecast.cutoffAt) < Date.parse(realForecast.kickoffUtc));
  check("legacy matrix reconstruction is explicit", realForecast.provenance.scoreDistributionArtifact === "reconstructed-from-frozen-lambdas-and-rho");
  check("market odds are absent from production inputs", !realForecast.provenance.inputsUsed.some((input) => /market|odds/i.test(input)));

  console.log("\n── Temporal integrity ──────────────────────────────────────────────");
  check("input at cutoff is admissible", isAvailableAtCutoff("2026-08-16T05:33:34.616Z", "2026-08-16T05:33:34.616Z"));
  check("future input is excluded", !isAvailableAtCutoff("2026-08-16T05:33:34.617Z", "2026-08-16T05:33:34.616Z"));
  check("invalid timestamp fails closed", !isAvailableAtCutoff("unknown", realForecast.cutoffAt));
  check("current tactical profiles are not forecast inputs", !realForecast.provenance.inputsUsed.some((input) => /tactic/i.test(input)));
  check("current availability is not forecast input", !realForecast.provenance.inputsUsed.some((input) => /availability|injury|lineup/i.test(input)));
  check("rating-state cutoff is recorded", typeof realForecast.provenance.dataFreshness.ratingStateAsOf === "string");

  console.log("\n── Production / shadow isolation ──────────────────────────────────");
  const base = snapshotFor(fixture, { asOf: "2026-08-20T10:00:00.000Z", stage: "EARLY" });
  const laterShadow = snapshotFor(fixture, {
    modelVersion: SHADOW_MODEL_VERSION,
    asOf: "2026-08-21T10:00:00.000Z",
    lambdaHome: 2.2,
    stage: "T24H",
  });
  const earlierShadow = snapshotFor(fixture, {
    modelVersion: SHADOW_MODEL_VERSION,
    asOf: "2026-08-19T10:00:00.000Z",
    lambdaHome: 0.9,
    stage: "EARLY",
  });
  check("production predicate accepts champion", isProductionForecastSnapshot(base));
  check("production predicate rejects shadow", !isProductionForecastSnapshot(laterShadow));
  check("shadow inserted later cannot win", selectProductionSnapshot(fixture, [base, laterShadow]).provenance.uniqueKey === base.provenance.uniqueKey);
  check("shadow inserted earlier cannot win", selectProductionSnapshot(fixture, [earlierShadow, base]).provenance.uniqueKey === base.provenance.uniqueKey);
  check("insertion order cannot alter production", selectProductionSnapshot(fixture, [laterShadow, base, earlierShadow]).provenance.uniqueKey === base.provenance.uniqueKey);
  check("production query excludes every shadow", productionSnapshotsForMatch(fixture.id, [laterShadow, base, earlierShadow]).every((row) => row.modelVersion === PRODUCTION_MODEL_VERSION));
  check("direct shadow build is refused", (() => {
    try {
      buildMatchForecast(fixture, laterShadow);
      return false;
    } catch (error) {
      return error instanceof MatchForecastError && error.code === "FORECAST_INTEGRITY";
    }
  })());

  console.log("\n── Immutable probability history ──────────────────────────────────");
  const newer = snapshotFor(fixture, {
    asOf: "2026-08-22T10:00:00.000Z",
    lambdaHome: 1.95,
    lambdaAway: 1.0,
    stage: "T24H",
  });
  const timeline = forecastTimeline(fixture, [laterShadow, newer, base, earlierShadow]);
  check("timeline contains production only", timeline.length === 2 && timeline.every((row) => row.modelVersion === PRODUCTION_MODEL_VERSION));
  check("timeline is cutoff ordered", timeline[0].cutoffAt < timeline[1].cutoffAt);
  const oldForecast = buildMatchForecast(fixture, base);
  const newForecast = buildMatchForecast(fixture, newer);
  const comparison = compareForecastSnapshots(oldForecast, newForecast);
  check("comparison delta is deterministic", near(comparison.probabilityChanges.homeWin, newForecast.result.homeWin - oldForecast.result.homeWin));
  check("comparison refuses causal attribution", comparison.causalAttribution === "not-established");
  check("input changes are machine-readable", Array.isArray(comparison.inputChanges));

  console.log("\n── Agent grounding and privacy ────────────────────────────────────");
  clearMatchAgentCacheForTests();
  const who = await runMatchAgent(fixture.id, "Who wins?");
  check("agent returns production role", who.modelRole === "production");
  check("agent uses the canonical forecast id", who.forecastId === realForecast.provenance.immutableForecastId);
  check("agent home number comes from tool output", who.answer.includes(`${(who.numericEvidence.homeWin * 100).toFixed(1)}%`));
  check("agent draw number comes from tool output", who.answer.includes(`${(who.numericEvidence.draw * 100).toFixed(1)}%`));
  check("agent does not persist raw prompt", who.privacy.rawPromptPersisted === false);
  check("agent does not create public conversation", who.privacy.publicConversationCreated === false);
  check("LLM disabled yields deterministic template", who.narration.mode === "deterministic-template");
  check("tool trace names deterministic forecast", who.tools.some((tool) => tool.name === "get_match_forecast" && tool.forecastId === who.forecastId));
  const over = await runMatchAgent(fixture.id, "Over 2.5?");
  check("over 2.5 is from canonical market", near(over.numericEvidence.over, realForecast.totals.over25));
  const exact = await runMatchAgent(fixture.id, "What is the probability of 2-1?");
  check("exact score is from matrix cell", near(exact.numericEvidence.exactScore, realForecast.scoreMatrix[2][1]));
  const compare = await runMatchAgent(fixture.id, "Arsenal win or Over 2.5 — which is more likely?");
  check("comparison reads home win from the matrix", near(compare.numericEvidence.homeWin, realForecast.result.homeWin));
  check("comparison reads over 2.5 from the same matrix", near(compare.numericEvidence.over25, realForecast.totals.over25));
  check("comparison difference is deterministic", near(compare.numericEvidence.difference, Math.abs(realForecast.result.homeWin - realForecast.totals.over25)));
  const dnb = await runMatchAgent(fixture.id, "What is Arsenal draw no bet?");
  check("DNB is conditionally normalized", near(dnb.numericEvidence.homeDnb, realForecast.drawNoBet.home));
  const dnbComparison = await runMatchAgent(fixture.id, "Compare home win versus draw-no-bet.");
  check("hyphenated DNB comparison is supported", near(dnbComparison.numericEvidence.homeDnb, realForecast.drawNoBet.home) && near(dnbComparison.numericEvidence.homeWin, realForecast.result.homeWin));
  const doubleChance = await runMatchAgent(fixture.id, "What is 1X double chance?");
  check("double chance is a 1X2 sum", near(doubleChance.numericEvidence.oneX, realForecast.doubleChance.homeOrDraw));
  const teamTotal = await runMatchAgent(fixture.id, "Arsenal team total over 1.5?");
  check("team total comes from score matrix", near(teamTotal.numericEvidence.teamTotal, realForecast.teamTotals.home.over15));
  const scenario = await runMatchAgent(fixture.id, "What if Saka is unavailable?");
  check("unsupported scenario returns no probability", Object.keys(scenario.numericEvidence).length === 0);
  check("unsupported scenario is refused honestly", scenario.answer.includes("does not support player-level"));
  const toolContext = await getMatchContext(fixture.id);
  check("market tool shares canonical forecast id", getMarketProbabilities(toolContext).immutableForecastId === who.forecastId);
  check("score tool shares canonical matrix", near(getScoreDistribution(toolContext).scoreMatrix[2][1], realForecast.scoreMatrix[2][1]));
  check("scenario tool cannot modify baseline", runSupportedScenario(toolContext, { type: "PLAYER_UNAVAILABLE", playerId: "saka" }).supported === false);

  console.log("\n── API and abuse controls ─────────────────────────────────────────");
  const intelligenceResponse = await intelligenceGet(
    new Request(`http://local/api/matches/${fixture.id}/intelligence`),
    { params: Promise.resolve({ matchId: fixture.id }) }
  );
  check("valid intelligence API is 200", intelligenceResponse.status === 200);
  const intelligenceJson = await intelligenceResponse.json();
  check("intelligence API is production-only", intelligenceJson.forecast.modelRole === "production" && intelligenceJson.forecast.modelVersion === PRODUCTION_MODEL_VERSION);
  const unknownResponse = await intelligenceGet(
    new Request("http://local/api/matches/unknown/intelligence"),
    { params: Promise.resolve({ matchId: "unknown" }) }
  );
  check("unknown match is 404", unknownResponse.status === 404);
  const invalidAgent = await agentPost(
    new Request(`http://local/api/matches/${fixture.id}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
      body: JSON.stringify({ question: "" }),
    }),
    { params: Promise.resolve({ matchId: fixture.id }) }
  );
  check("empty agent question is 400", invalidAgent.status === 400);
  resetMatchAgentRateLimitsForTests();
  const rateKey = anonymousRateLimitKey("198.51.100.10");
  for (let i = 0; i < 12; i += 1) takeMatchAgentRateLimit(rateKey, 1_000);
  const blocked = takeMatchAgentRateLimit(rateKey, 1_000);
  check("thirteenth request is rate limited", blocked.allowed === false && blocked.retryAfterSeconds > 0);
  check("raw IP is not retained as rate-limit key", rateKey !== "198.51.100.10" && rateKey.length === 24);

  console.log("\n── Immutable source evidence ──────────────────────────────────────");
  const tape = loadCommittedLiveOos();
  check("committed tape remains 380 rows", tape.length === 380);
  check("committed tape remains production-only", tape.every((row) => row.modelVersion === PRODUCTION_MODEL_VERSION));

  if (failures) {
    console.error(`\n${failures} Match Forecast check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll Match Forecast Engine + Match Agent V1 checks passed.");
}

void main();
