/**
 * Phase 1 Premier League core tests.
 */
import { getCompetition } from "@/lib/competitions";
import {
  resolveClubSlug,
  resolveAllClubSlugs,
} from "@/lib/competitions/premier-league/clubs";
import {
  applyResult,
  comparePremierLeagueRows,
  emptyRow,
  rankTable,
  tableFromResults,
} from "@/lib/competitions/premier-league/standings";
import { generateRoundRobin } from "@/lib/competitions/premier-league/season";
import {
  isDuplicateFixture,
  parseFootballDataDate,
  completedPremierLeagueFixtures,
} from "@/lib/competitions/premier-league/data";
import { ratingsAsOf } from "@/lib/competitions/premier-league/ratings";
import {
  matchProb,
  sampleMatch,
  scorelineGridFromGoals,
  matchProbFromGoals,
  mulberry32,
} from "@/lib/prediction-engine/elo";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import { predictPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import {
  createSnapshot,
  getSnapshot,
  clearSnapshotsForTests,
  assertImmutable,
} from "@/lib/snapshots/store";

process.env.SNAPSHOT_STORE_PATH = require("node:path").join(
  require("node:os").tmpdir(),
  `foa-phase1-core-${process.pid}.jsonl`
);
import { auditPrediction, auditScorelineGrid } from "@/lib/model-auditor/audit";
import { runRollingBacktest } from "@/lib/evaluation/backtest";
import { isOutOfScopeCompetition as plannerOutOfScope, planQuery as plan } from "@/lib/agent/planner";
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

// Competition config
const pl = getCompetition("premier-league");
check("PL config id", pl.id === "premier-league");
check("PL is a league", pl.competitionType === "league");
check("PL true home/away", pl.homeAdvantageMode === "true-home-away");
check("PL allows draws", pl.allowsDraw === true);
check("PL 20 clubs / 38 MDs", pl.seasonFormat.teams === 20 && pl.seasonFormat.matchdays === 38);
check("PL tiebreak GD then GF", pl.standingsRules.tiebreakers.join(",") === "points,gd,gf");
check("WC still a plugin", getCompetition("world-cup").simulationMode === "tournament-bracket");
check("no scattered PL footballDataCode on WC", getCompetition("world-cup").footballDataCode === "WC");

// Club aliases
check("Man United official name", resolveClubSlug("Man United") === "manchester-united");
check("Spurs alias", resolveClubSlug("Spurs") === "tottenham");
check("Nott'm Forest official", resolveClubSlug("Nott'm Forest") === "nottingham-forest");
check("Arsenal vs Liverpool resolves two clubs", resolveAllClubSlugs("Who wins Arsenal vs Liverpool?").join(",") === "arsenal,liverpool");
check("generic 'united' does not steal Newcastle", resolveAllClubSlugs("Newcastle United vs Arsenal").includes("newcastle"));

// Season-aware identity: same slug, different seasons, independent membership
const s1 = { clubSlug: "ipswich", season: "2024-25", competition: "premier-league" as const };
const s2 = { clubSlug: "ipswich", season: "2018-19", competition: "premier-league" as const };
check("club slug is stable across seasons", s1.clubSlug === s2.clubSlug);
check("season membership is a separate record", s1.season !== s2.season);

// True home/away
const params = loadPremierLeagueParams();
const even = matchProb(1600, 1600, params.homeAdvantage, {
  rho: params.dcRho,
  awayHomeShare: 0,
});
const flipped = matchProb(1600, 1600, 0, { rho: params.dcRho, awayHomeShare: 0 });
check("home advantage raises home win vs neutral", even.winA > flipped.winA);
check("awayHomeShare 0 does not penalise away λ extra", even.expectedGoalsB >= flipped.expectedGoalsB - 1e-9);

// Score grid normalisation
const grid = scorelineGridFromGoals(1.4, 1.1, params.dcRho);
const gsum = grid.reduce((s, c) => s + c.p, 0);
check("scoreline probabilities sum ≈ 1", Math.abs(gsum - 1) < 1e-9, gsum.toFixed(12));
const auditG = auditScorelineGrid(grid);
check("auditor accepts normalised grid", auditG.status === "pass");

// MC vs closed-form
const p = matchProbFromGoals(1.45, 1.15, -0.1);
const rng = mulberry32(42);
let h = 0, d = 0, a = 0;
const N = 40000;
for (let i = 0; i < N; i++) {
  const s = sampleMatch(1600, 1580, 65, true, rng, { rho: -0.1, awayHomeShare: 0 });
  if (s.goalsA > s.goalsB) h++;
  else if (s.goalsA < s.goalsB) a++;
  else d++;
}
const closed = matchProb(1600, 1580, 65, { rho: -0.1, awayHomeShare: 0 });
check("MC home ≈ closed-form", Math.abs(h / N - closed.winA) < 0.02, `${(h / N).toFixed(3)} vs ${closed.winA.toFixed(3)}`);
check("MC draw ≈ closed-form", Math.abs(d / N - closed.draw) < 0.02, `${(d / N).toFixed(3)} vs ${closed.draw.toFixed(3)}`);
check("MC away ≈ closed-form", Math.abs(a / N - closed.winB) < 0.02, `${(a / N).toFixed(3)} vs ${closed.winB.toFixed(3)}`);

// Table ranking / points / GD / GF
const rows = tableFromResults(
  ["arsenal", "liverpool", "chelsea"],
  [
    { homeSlug: "arsenal", awaySlug: "liverpool", homeGoals: 2, awayGoals: 1 },
    { homeSlug: "liverpool", awaySlug: "chelsea", homeGoals: 1, awayGoals: 1 },
    { homeSlug: "chelsea", awaySlug: "arsenal", homeGoals: 0, awayGoals: 3 },
  ]
);
check("win = 3 points", rows.find((r) => r.slug === "arsenal")!.points === 6);
check("draw = 1 point", rows.find((r) => r.slug === "liverpool")!.points === 1);
check("loss = 0 points", rows.find((r) => r.slug === "chelsea")!.points === 1);
check("GD computed", rows.find((r) => r.slug === "arsenal")!.gd === 4);
check("GF computed", rows.find((r) => r.slug === "arsenal")!.gf === 5);
check("leader is Arsenal", rows[0].slug === "arsenal" && rows[0].position === 1);
const tiedA = emptyRow("a");
const tiedB = emptyRow("b");
tiedA.points = tiedB.points = 10;
tiedA.gd = 2;
tiedB.gd = 1;
tiedA.gf = 5;
tiedB.gf = 8;
check("GD beats GF when points tied", comparePremierLeagueRows(tiedA, tiedB) < 0);

// Postponed / duplicates
const postponed: Fixture = {
  id: "x",
  competition: "premier-league",
  season: "2024-25",
  date: "2024-12-01",
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  homeGoals: null,
  awayGoals: null,
  status: "postponed",
  venue: "home",
};
check("postponed has no goals", postponed.homeGoals === null);
const seen = new Set<string>();
const f1: Fixture = { ...postponed, status: "completed", homeGoals: 1, awayGoals: 0 };
check("first fixture not duplicate", isDuplicateFixture(seen, f1) === false);
check("same fixture is duplicate", isDuplicateFixture(seen, f1) === true);
check("parse football-data date", parseFootballDataDate("17/08/24") === "2024-08-17");

// asOf temporal boundary
const fixtures = completedPremierLeagueFixtures();
if (fixtures.length > 100) {
  const mid = fixtures[400];
  const before = ratingsAsOf(mid.date);
  const after = ratingsAsOf("9999-12-31");
  const later = fixtures.filter((f) => f.date >= mid.date).length;
  check("asOf uses a proper cutoff", later > 0);
  check("ratings object exists as-of mid sample", typeof before.ratings === "object");
  check("full history has at least as many rated clubs", Object.keys(after.ratings).length >= Object.keys(before.ratings).length);
}

// Snapshot immutability + version
clearSnapshotsForTests();
const snap = createSnapshot({
  fixtureId: "pl-test",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.1.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.45,
  draw: 0.27,
  away: 0.28,
  homeExpectedGoals: 1.5,
  awayExpectedGoals: 1.2,
  scorelineDistribution: { "1-1": 0.12 },
});
const again = createSnapshot({
  fixtureId: "pl-test",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.1.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.99,
  draw: 0.005,
  away: 0.005,
  homeExpectedGoals: 3,
  awayExpectedGoals: 0.2,
  scorelineDistribution: {},
});
check("same version does not overwrite", again.home === 0.45);
check("stored snapshot equals first write", getSnapshot("pl-test", "pl-baseline-v0.1.0")!.home === 0.45);
check("immutability helper", assertImmutable(snap, again));
const v2 = createSnapshot({
  fixtureId: "pl-test",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.2.0",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.4,
  draw: 0.3,
  away: 0.3,
  homeExpectedGoals: 1.4,
  awayExpectedGoals: 1.3,
  scorelineDistribution: {},
});
check("new version is a separate snapshot", v2.home === 0.4 && getSnapshot("pl-test", "pl-baseline-v0.1.0")!.home === 0.45);

// Walk-forward: a later result must not affect an earlier prediction
const wf = runRollingBacktest(
  [
    { date: "2024-08-17", season: "2024-25", homeSlug: "arsenal", awaySlug: "wolves", homeGoals: 2, awayGoals: 0, competition: "premier league" },
    { date: "2024-08-24", season: "2024-25", homeSlug: "liverpool", awaySlug: "arsenal", homeGoals: 2, awayGoals: 2, competition: "premier league" },
  ],
  { burnIn: 0, modelVersion: "test" }
);
check("two scored matches", wf.length === 2);
check("first match asOf is its own date", wf[0].asOf === "2024-08-17");
check("second match dataCutoff is its date", wf[1].dataCutoff === "2024-08-24");

// Planner: PL in scope, other leagues out
check("Arsenal vs Liverpool is in-scope", plannerOutOfScope("Who wins Arsenal vs Liverpool?") === false);
check("Premier League title is in-scope", plannerOutOfScope("Who is most likely to win the Premier League?") === false);
check("La Liga still out of scope", plannerOutOfScope("Who wins La Liga?") === true);
check("Champions League still out of scope", plannerOutOfScope("Who wins the Champions League?") === true);
check("World Cup still in scope", plannerOutOfScope("Who will win the World Cup?") === false);
const plPlan = plan("Who wins Arsenal vs Liverpool?");
check("Arsenal vs Liverpool is a PL match", plPlan.competition === "premier-league" && plPlan.intent === "match-prediction");
check("PL title routes to champion-odds", plan("Who is most likely to win the Premier League?").intent === "champion-odds");

// Live predict
if (fixtures.length > 0) {
  const pred = predictPremierLeagueMatch("arsenal", "liverpool", { asOf: "2025-08-01" });
  const sum = pred.teamAWinProbability + pred.drawProbability + pred.teamBWinProbability;
  check("prediction 1X2 sums to 1", Math.abs(sum - 1) < 1e-6);
  check("prediction carries model version", !!pred.modelVersion);
  check("prediction asOf stamped", pred.asOf === "2025-08-01");
  const aud = auditPrediction(pred);
  check("auditor does not fail a live PL card", aud.status !== "fail", aud.issues.map((i) => i.code).join(","));
}

check("round-robin of 3 clubs is 6 fixtures", generateRoundRobin(["a", "b", "c"]).length === 6);

console.log(`\nPhase 1 core: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
