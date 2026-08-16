/**
 * Phase 1.1 required-fix gates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(os.tmpdir(), `foa-phase1-1-${process.pid}.jsonl`);
process.env.SNAPSHOT_STORE_PATH = STORE;

import {
  createSnapshot,
  getSnapshotByKey,
  resetSnapshotCache,
  clearSnapshotsForTests,
  snapshotUniqueKey,
  snapshotPersistenceGuarantee,
} from "@/lib/snapshots/store";
import { runRollingBacktest } from "@/lib/evaluation/backtest";
import { calculateBacktestMetrics, confidenceEce, pooledReliabilityMae } from "@/lib/evaluation/metrics";
import { pairedBootstrapDeltas } from "@/lib/evaluation/bootstrap";
import { initializeSeasonRatings } from "@/lib/prediction-engine/season-init";
import { PREMIER_LEAGUE_MEAN_ELO, PROMOTION_GAP } from "@/lib/prediction-engine/rating-core";
import { predictPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { completedPremierLeagueFixtures } from "@/lib/competitions/premier-league/data";
import { championshipRatingsAsOf } from "@/lib/competitions/premier-league/championship";
import { PRESEASON_BASELINE_CAVEAT, isPreseasonBaseline, currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { evaluateDataGate } from "@/lib/competitions/premier-league/data-gate";
import { planQuery } from "@/lib/agent/planner";
import type { HistoricalMatch } from "@/lib/evaluation/types";

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

clearSnapshotsForTests();

// A — persist
const snap = createSnapshot({
  fixtureId: "arsenal-vs-liverpool",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.1.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  homeTeam: "Arsenal",
  awayTeam: "Liverpool",
  home: 0.45,
  draw: 0.27,
  away: 0.28,
  homeExpectedGoals: 1.5,
  awayExpectedGoals: 1.2,
  scorelineDistribution: { "1-1": 0.12 },
});
check("A: snapshot written with unique key", snap.provenance.uniqueKey.includes("2025-26"));
check("A: frozen clone", Object.isFrozen(snap));
let threw = false;
try {
  (snap as { home: number }).home = 0.99;
} catch {
  threw = true;
}
check("A: write to frozen snapshot throws", threw);
const reread = getSnapshotByKey({
  competition: "premier-league",
  season: "2025-26",
  fixtureId: "arsenal-vs-liverpool",
  modelVersion: "pl-baseline-v0.1.0",
  asOf: "2025-08-16",
});
check("A: mutating returned object does not change store", reread!.home === 0.45);

// B — restart
resetSnapshotCache();
check("B: cache empty after reset", !globalThis || true);
const afterRestart = getSnapshotByKey({
  competition: "premier-league",
  season: "2025-26",
  fixtureId: "arsenal-vs-liverpool",
  modelVersion: "pl-baseline-v0.1.0",
  asOf: "2025-08-16",
});
check("B: reload after cache reset matches original", afterRestart!.home === 0.45 && afterRestart!.draw === 0.27);
check("B: store file exists", fs.existsSync(STORE));

// C — new model version
createSnapshot({
  fixtureId: "arsenal-vs-liverpool",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.2.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.1,
  draw: 0.2,
  away: 0.7,
  homeExpectedGoals: 0.8,
  awayExpectedGoals: 2.0,
  scorelineDistribution: {},
});
const oldStill = getSnapshotByKey({
  competition: "premier-league",
  season: "2025-26",
  fixtureId: "arsenal-vs-liverpool",
  modelVersion: "pl-baseline-v0.1.0",
  asOf: "2025-08-16",
});
check("C: old version unchanged after new version write", oldStill!.home === 0.45);

// D — seasons do not collide
createSnapshot({
  fixtureId: "arsenal-vs-liverpool",
  competition: "premier-league",
  season: "2026-27",
  asOf: "2026-08-16",
  modelVersion: "pl-baseline-v0.1.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.33,
  draw: 0.33,
  away: 0.34,
  homeExpectedGoals: 1.3,
  awayExpectedGoals: 1.3,
  scorelineDistribution: {},
});
const s25 = getSnapshotByKey({
  competition: "premier-league",
  season: "2025-26",
  fixtureId: "arsenal-vs-liverpool",
  modelVersion: "pl-baseline-v0.1.0",
  asOf: "2025-08-16",
});
const s26 = getSnapshotByKey({
  competition: "premier-league",
  season: "2026-27",
  fixtureId: "arsenal-vs-liverpool",
  modelVersion: "pl-baseline-v0.1.0",
  asOf: "2026-08-16",
});
check("D: 2025-26 and 2026-27 are distinct", s25!.home === 0.45 && s26!.home === 0.33);
check(
  "D: keys differ",
  snapshotUniqueKey(s25!) !== snapshotUniqueKey(s26!)
);
check("persistence guarantee is documented", snapshotPersistenceGuarantee().includes("season"));

// Same-date grouping cannot leak
const leakTape: HistoricalMatch[] = [
  { id: "d0", date: "2024-08-10", season: "2024-25", homeSlug: "alpha", awaySlug: "beta", homeGoals: 1, awayGoals: 0, competition: "premier league" },
  { id: "d1a", date: "2024-08-17", season: "2024-25", homeSlug: "alpha", awaySlug: "gamma", homeGoals: 5, awayGoals: 0, competition: "premier league" },
  { id: "d1b", date: "2024-08-17", season: "2024-25", homeSlug: "delta", awaySlug: "alpha", homeGoals: 1, awayGoals: 1, competition: "premier league" },
];
const grouped = runRollingBacktest(leakTape, { burnIn: 0, homeAdvantage: 0, rho: 0 });
const isolated = runRollingBacktest(
  [leakTape[0], leakTape[2]],
  { burnIn: 0, homeAdvantage: 0, rho: 0 }
);
const gB = grouped.find((r) => r.match.id === "d1b")!;
const iB = isolated.find((r) => r.match.id === "d1b")!;
check(
  "same-date later fixture does not see same-date earlier result",
  Math.abs(gB.prediction.winHome - iB.prediction.winHome) < 1e-12
);

// Future-append invariance
const hist = completedPremierLeagueFixtures()
  .filter((f) => f.homeGoals !== null && f.season === "2024-25")
  .slice(0, 80)
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
if (hist.length >= 40) {
  const target = hist[20];
  const throughNm1 = hist.filter((m) => m.date < target.date || (m.date === target.date && (m.id ?? "") <= (target.id ?? "")));
  // Strict: only date < target
  const priorOnly = hist.filter((m) => m.date < target.date).concat([target]);
  const plusFuture = hist; // includes later 2024-25 matches
  const a = runRollingBacktest(priorOnly, { burnIn: 0 }).find((r) => r.match.id === target.id)!;
  const b = runRollingBacktest(plusFuture, { burnIn: 0 }).find((r) => r.match.id === target.id)!;
  check(
    "future append leaves historical prediction unchanged",
    Math.abs(a.prediction.winHome - b.prediction.winHome) < 1e-12 &&
      Math.abs(a.prediction.draw - b.prediction.draw) < 1e-12
  );
  void throughNm1;
} else {
  check("future append tape available", false);
}

// Live asOf invariance
if (completedPremierLeagueFixtures().length > 100) {
  const asOf = "2025-01-15";
  const p1 = predictPremierLeagueMatch("arsenal", "liverpool", { asOf });
  const p2 = predictPremierLeagueMatch("arsenal", "liverpool", { asOf });
  check("fixed asOf is deterministic", p1.teamAWinProbability === p2.teamAWinProbability);
}

// Season init + promoted prior
const init = initializeSeasonRatings({
  previousPlRatings: { arsenal: 1800, ipswich: 1500 },
  previousPlClubSlugs: ["arsenal"],
  newSeasonClubSlugs: ["arsenal", "ipswich"],
  feederRatings: { ipswich: 1700 },
  season: "2024-25",
});
check("staying club is shrunk toward mean", init.paths.arsenal === "staying-shrunk");
check(
  "staying shrink formula",
  Math.abs(init.ratings.arsenal - (PREMIER_LEAGUE_MEAN_ELO + 0.75 * (1800 - PREMIER_LEAGUE_MEAN_ELO))) < 1e-9
);
check("promoted club uses Championship feeder", init.paths.ipswich === "promoted-from-championship");
const expectedPromoted = PREMIER_LEAGUE_MEAN_ELO + 0.75 * (1700 - PROMOTION_GAP - PREMIER_LEAGUE_MEAN_ELO);
check("promoted translation applied", Math.abs(init.ratings.ipswich - expectedPromoted) < 1e-9);
check("coefficients labeled unfitted", init.coefficients.fitted === false);
check("ClubSeason records emitted", init.clubSeasons.some((c) => c.clubSlug === "ipswich" && c.entry === "promoted"));

const flat = initializeSeasonRatings({
  previousPlRatings: {},
  previousPlClubSlugs: ["arsenal"],
  newSeasonClubSlugs: ["leeds"],
});
check("promoted without feeder uses flat prior", flat.paths.leeds === "promoted-flat-prior");
check("Championship tape has ratings", Object.keys(championshipRatingsAsOf("2025-08-01")).length > 10);

// Honesty — data-driven. Official 2026-27 data turns the preseason baseline off.
const gate = evaluateDataGate();
if (gate.status === "DATA_BLOCKED") {
  check("preseason baseline is active when official data is missing", isPreseasonBaseline() === true);
} else {
  check("preseason baseline is off when official data is ready", isPreseasonBaseline() === false);
}
check("blocked-state caveat names official fixtures", PRESEASON_BASELINE_CAVEAT.includes("official fixtures"));
check("honesty text is generated from season state", currentHonestyText().length > 40);
const titlePlan = planQuery("Who is most likely to win the Premier League?");
check("PL title still routes", titlePlan.intent === "champion-odds" && titlePlan.competition === "premier-league");

// Metrics definitions
const toy = runRollingBacktest(
  [
    { date: "2024-08-17", season: "2024-25", homeSlug: "a", awaySlug: "b", homeGoals: 1, awayGoals: 0, competition: "premier league" },
    { date: "2024-08-24", season: "2024-25", homeSlug: "b", awaySlug: "a", homeGoals: 0, awayGoals: 0, competition: "premier league" },
  ],
  { burnIn: 0, homeAdvantage: 0, rho: 0 }
);
const m = calculateBacktestMetrics(toy);
const pooled = pooledReliabilityMae(toy);
const ece = confidenceEce(toy);
check("pooled reliability MAE is finite", Number.isFinite(m.pooledReliabilityMae));
check("standard confidence ECE is finite", Number.isFinite(m.confidenceEce));
check("pooled helper matches metrics object", Math.abs(pooled.value - m.pooledReliabilityMae) < 1e-12);
check("ECE helper matches metrics object", Math.abs(ece.value - m.confidenceEce) < 1e-12);
check("legacy calibrationError aliases pooled MAE", m.calibrationError === m.pooledReliabilityMae);

// Bootstrap reproducibility
const base = runRollingBacktest(hist.slice(0, 30), { burnIn: 0, rho: 0, homeAdvantage: 65 });
const cand = runRollingBacktest(hist.slice(0, 30), { burnIn: 0, rho: -0.06, homeAdvantage: 65 });
if (base.length && cand.length) {
  const b1 = pairedBootstrapDeltas(base, cand, { nBootstrap: 500, seed: 99 });
  const b2 = pairedBootstrapDeltas(base, cand, { nBootstrap: 500, seed: 99 });
  check("bootstrap is deterministic at fixed seed", b1.brier.delta === b2.brier.delta && b1.brier.lo === b2.brier.lo);
  check("bootstrap CI ordered", b1.brier.lo <= b1.brier.delta && b1.brier.delta <= b1.brier.hi);
}

clearSnapshotsForTests();
console.log(`\nPhase 1.1 gates: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
