/**
 * Big Five research forecast gates.
 *
 * Hard release properties:
 *   - Premier League is refused (no parallel production number)
 *   - no future leakage, no same-match leakage, competition isolation
 *   - parameters are the labeled domestic prior, not pl-live-v0.2.0
 *   - this layer does not freeze snapshots or import the production predictor
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  MATCH_LEDGER_SCHEMA_VERSION,
  emptyMatchEvents,
  type CanonicalMatch,
  type LedgerMatchStatus,
} from "@/lib/match-ledger/types";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { loadPremierLeagueParams, paramsFor } from "@/lib/prediction-engine/model-params";
import {
  BIG_FIVE_RESEARCH_MODEL_VERSION,
  BIG_FIVE_RESEARCH_PARAMS,
  RESEARCH_FORECAST_DISCLAIMER,
  ResearchForecastError,
  assertResearchForecastCompetition,
  buildResearchForecastBoard,
  forecastResearchMatch,
  isResearchForecastCompetitionId,
  researchForecastForMatchId,
  researchRatingsAsOf,
} from "@/lib/competitions/big-five";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) {
    console.error(`✗ ${name}${detail ? " — " + detail : ""}`);
    process.exitCode = 1;
    throw new Error(`failed: ${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}${detail ? " — " + detail : ""}`);
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

function team(slug: string, name: string) {
  return {
    slug,
    providerTeamId: slug,
    name,
    shortName: name,
    tla: slug.slice(0, 3).toUpperCase(),
  };
}

function match(over: {
  id: string;
  competition?: CanonicalMatch["competition"];
  season?: string;
  status?: LedgerMatchStatus;
  kickoffUtc: string;
  home: string;
  away: string;
  homeName?: string;
  awayName?: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
  resultObservedAt?: string | null;
  matchday?: number | null;
}): CanonicalMatch {
  const finished =
    over.status === "FINISHED" ||
    (over.homeGoals !== undefined && over.homeGoals !== null);
  const status: LedgerMatchStatus = over.status ?? (finished ? "FINISHED" : "SCHEDULED");
  const homeGoals = over.homeGoals ?? null;
  const awayGoals = over.awayGoals ?? null;
  return {
    schemaVersion: MATCH_LEDGER_SCHEMA_VERSION,
    canonicalMatchId: over.id,
    competition: over.competition ?? "la-liga",
    season: over.season ?? "2026-27",
    matchday: over.matchday ?? 1,
    stage: "REGULAR_SEASON",
    kickoffUtc: over.kickoffUtc,
    home: team(over.home, over.homeName ?? over.home),
    away: team(over.away, over.awayName ?? over.away),
    status,
    halfTimeHomeGoals: null,
    halfTimeAwayGoals: null,
    fullTimeHomeGoals: homeGoals,
    fullTimeAwayGoals: awayGoals,
    outcome:
      homeGoals === null || awayGoals === null
        ? null
        : homeGoals > awayGoals
          ? "HOME"
          : homeGoals < awayGoals
            ? "AWAY"
            : "DRAW",
    resultObservedAt: over.resultObservedAt ?? (status === "FINISHED" ? over.kickoffUtc : null),
    homeStatistics: null,
    awayStatistics: null,
    events: emptyMatchEvents(),
    provenance: { result: null, statistics: null, events: null },
    observationIds: [`obs-${over.id}`],
    observationCount: 1,
    sources: ["test"],
    corrections: [],
    firstObservedAt: over.kickoffUtc,
    lastObservedAt: over.resultObservedAt ?? over.kickoffUtc,
  };
}

const MW1_HOME = match({
  id: "pd-2026-27-real-madrid-getafe",
  kickoffUtc: "2026-08-16T19:00:00.000Z",
  home: "real-madrid",
  away: "getafe",
  homeGoals: 3,
  awayGoals: 0,
  resultObservedAt: "2026-08-16T21:00:00.000Z",
  matchday: 1,
});
const MW1_OTHER = match({
  id: "pd-2026-27-sevilla-valencia",
  kickoffUtc: "2026-08-16T17:00:00.000Z",
  home: "sevilla",
  away: "valencia",
  homeGoals: 1,
  awayGoals: 1,
  resultObservedAt: "2026-08-16T19:00:00.000Z",
  matchday: 1,
});
const MW2_FUTURE = match({
  id: "pd-2026-27-getafe-celta-vigo",
  kickoffUtc: "2026-09-07T17:00:00.000Z",
  home: "getafe",
  away: "celta-vigo",
  status: "SCHEDULED",
  matchday: 2,
});
const BUNDES_FINISHED = match({
  id: "bl1-2026-27-bayern-munich-union-berlin",
  competition: "bundesliga",
  kickoffUtc: "2026-08-28T18:30:00.000Z",
  home: "bayern-munich",
  away: "union-berlin",
  homeGoals: 4,
  awayGoals: 0,
  resultObservedAt: "2026-08-28T20:30:00.000Z",
});
const BUNDES_FUTURE = match({
  id: "bl1-2026-27-union-berlin-schalke-04",
  competition: "bundesliga",
  kickoffUtc: "2026-09-11T18:30:00.000Z",
  home: "union-berlin",
  away: "schalke-04",
  status: "SCHEDULED",
});
const PL_FINISHED = match({
  id: "pl-2026-27-arsenal-coventry",
  competition: "premier-league",
  kickoffUtc: "2026-08-21T19:00:00.000Z",
  home: "arsenal",
  away: "coventry",
  homeGoals: 3,
  awayGoals: 0,
  resultObservedAt: "2026-08-21T21:00:00.000Z",
});
const PL_FUTURE = match({
  id: "pl-2026-27-chelsea-arsenal",
  competition: "premier-league",
  kickoffUtc: "2026-09-12T14:00:00.000Z",
  home: "chelsea",
  away: "arsenal",
  status: "SCHEDULED",
});

const AS_OF = "2026-09-07T12:00:00.000Z";
const LIGA = [MW1_HOME, MW1_OTHER, MW2_FUTURE];

console.log("── Identity and non-promotion ──────────────────────────────────");
check("research competitions exclude Premier League", !isResearchForecastCompetitionId("premier-league"));
check("research competitions include La Liga", isResearchForecastCompetitionId("la-liga"));
check(
  "model version is not the production champion",
  String(BIG_FIVE_RESEARCH_MODEL_VERSION) !== String(PRODUCTION_MODEL_VERSION)
);
check("research HA is the labeled prior 65, not fitted PL 72", BIG_FIVE_RESEARCH_PARAMS.homeAdvantage === 65);
check("research ρ is the labeled prior −0.10, not fitted PL −0.061", BIG_FIVE_RESEARCH_PARAMS.dcRho === -0.1);
check("research params were not fitted", BIG_FIVE_RESEARCH_PARAMS.fittedAt === null);
check("research training window is absent", BIG_FIVE_RESEARCH_PARAMS.trainingWindow === null);
check("research role is research", BIG_FIVE_RESEARCH_PARAMS.modelRole === "research");
check("research is not included in production", BIG_FIVE_RESEARCH_PARAMS.includedInProduction === false);
check(
  "labeled prior is distinct from loaded PL production/baseline HA",
  BIG_FIVE_RESEARCH_PARAMS.homeAdvantage !== loadPremierLeagueParams().homeAdvantage
);

let plThrew = false;
try {
  assertResearchForecastCompetition("premier-league");
} catch (error) {
  plThrew =
    error instanceof ResearchForecastError &&
    error.code === "PRODUCTION_ISOLATION" &&
    error.status === 409;
}
check("asserting Premier League is PRODUCTION_ISOLATION 409", plThrew);

let boardThrew = false;
try {
  buildResearchForecastBoard({
    competition: "premier-league" as never,
    season: "2026-27",
    asOf: AS_OF,
    matches: [PL_FUTURE, PL_FINISHED],
  });
} catch (error) {
  boardThrew = error instanceof ResearchForecastError && error.code === "PRODUCTION_ISOLATION";
}
check("research board refuses Premier League", boardThrew);

let matchThrew = false;
try {
  forecastResearchMatch({ match: PL_FUTURE, universe: [PL_FUTURE, PL_FINISHED], asOf: AS_OF });
} catch (error) {
  matchThrew = error instanceof ResearchForecastError && error.code === "PRODUCTION_ISOLATION";
}
check("single-match research forecast refuses Premier League", matchThrew);

let paramsThrew = false;
try {
  paramsFor("la-liga");
} catch (error) {
  paramsThrew = error instanceof Error && /no production model parameters/.test(error.message);
}
check("paramsFor(la-liga) fails closed instead of returning World Cup constants", paramsThrew);
check("paramsFor(world-cup) still returns the WC track", paramsFor("world-cup").competition === "world-cup");
check("paramsFor(premier-league) still returns the PL track", paramsFor("premier-league").competition === "premier-league");

console.log("\n── Prior-only and walk-forward ────────────────────────────────────");
const priorBoard = buildResearchForecastBoard({
  competition: "bundesliga",
  season: "2026-27",
  asOf: AS_OF,
  matches: [BUNDES_FUTURE],
});
check("zero completed matches is PRIOR_ONLY", priorBoard.evidenceLevel === "PRIOR_ONLY");
check("prior-only board is labeled research", priorBoard.support === "research" && priorBoard.production === false);
const priorMatch = priorBoard.matches[0];
check("prior-only both sides start at 1500", priorMatch.home.elo === 1500 && priorMatch.away.elo === 1500);
check("prior-only home is favoured by HA", priorMatch.probabilities.home > priorMatch.probabilities.away);
check(
  "prior-only is not a lock",
  priorMatch.probabilities.home < 0.55 && priorMatch.probabilities.draw > 0.2
);
const priorSum =
  priorMatch.probabilities.home + priorMatch.probabilities.draw + priorMatch.probabilities.away;
check("prior-only 1X2 sums to 1", near(priorSum, 1, 1e-12));
check("disclaimer present", priorMatch.disclaimer === RESEARCH_FORECAST_DISCLAIMER);
check(
  "forecast names the production model it is not",
  priorMatch.notProductionModelVersion === PRODUCTION_MODEL_VERSION &&
    String(priorMatch.modelVersion) !== String(priorMatch.notProductionModelVersion)
);

const afterWin = researchRatingsAsOf(
  [MW1_HOME, MW2_FUTURE],
  { asOf: AS_OF, competition: "la-liga", season: "2026-27", excludeMatchId: MW2_FUTURE.canonicalMatchId },
  BIG_FIVE_RESEARCH_PARAMS
);
check("a 3–0 home win raises the home Elo", afterWin.ratings["real-madrid"] > 1500);
check("a 3–0 home win lowers the away Elo", afterWin.ratings["getafe"] < 1500);
check("unplayed club stays at the mean", afterWin.ratings["celta-vigo"] === 1500);

const ligaForecast = forecastResearchMatch({
  match: MW2_FUTURE,
  universe: LIGA,
  asOf: AS_OF,
});
check("Getafe are below mean after a 0–3", ligaForecast.home.elo < 1500);
check("thin evidence with two completed matches", ligaForecast.evidence.evidenceLevel === "THIN");
check("completed matches used equals admissible count", ligaForecast.evidence.completedMatchesUsed === 2);

console.log("\n── Leakage ────────────────────────────────────────────────────────");
const leakedAsOf = "2026-08-16T19:30:00.000Z"; // after Sevilla result, before Madrid resultObservedAt
const earlyState = researchRatingsAsOf(
  LIGA,
  { asOf: leakedAsOf, competition: "la-liga", season: "2026-27" },
  BIG_FIVE_RESEARCH_PARAMS
);
check(
  "resultObservedAt in the future is not applied",
  earlyState.ratings["real-madrid"] === 1500 && earlyState.matchesApplied === 1,
  `applied=${earlyState.matchesApplied}`
);
check("the earlier Sevilla result is applied", earlyState.lastAppliedMatchId === MW1_OTHER.canonicalMatchId);

const futureKickoff = match({
  ...{
    id: "pd-2026-27-future-leak",
    kickoffUtc: "2026-10-01T19:00:00.000Z",
    home: "real-madrid",
    away: "sevilla",
    homeGoals: 5,
    awayGoals: 0,
    resultObservedAt: "2026-08-01T00:00:00.000Z",
    status: "FINISHED",
  },
});
const futureLeakState = researchRatingsAsOf(
  [MW1_HOME, futureKickoff],
  { asOf: AS_OF, competition: "la-liga", season: "2026-27" },
  BIG_FIVE_RESEARCH_PARAMS
);
check(
  "kickoffUtc in the future cannot leak even with an early resultObservedAt",
  futureLeakState.lastAppliedMatchId === MW1_HOME.canonicalMatchId && futureLeakState.matchesApplied === 1
);

const afterFullTime = "2026-09-07T20:00:00.000Z";
const playedFuture = {
  ...MW2_FUTURE,
  status: "FINISHED" as const,
  fullTimeHomeGoals: 7,
  fullTimeAwayGoals: 0,
  outcome: "HOME" as const,
  resultObservedAt: "2026-09-07T19:00:00.000Z",
};
const honest = researchRatingsAsOf(
  [MW1_HOME, MW1_OTHER, playedFuture],
  {
    asOf: afterFullTime,
    competition: "la-liga",
    season: "2026-27",
    excludeMatchId: playedFuture.canonicalMatchId,
  },
  BIG_FIVE_RESEARCH_PARAMS
);
const leaked = researchRatingsAsOf(
  [MW1_HOME, MW1_OTHER, playedFuture],
  { asOf: afterFullTime, competition: "la-liga", season: "2026-27" },
  BIG_FIVE_RESEARCH_PARAMS
);
check(
  "the fixture being predicted is excluded even after full time",
  honest.ratings["getafe"] !== leaked.ratings["getafe"] && honest.matchesApplied === 2 && leaked.matchesApplied === 3
);

const scheduledUnknown = match({
  id: "pd-2026-27-unknown-status",
  kickoffUtc: "2026-09-20T19:00:00.000Z",
  home: "elche",
  away: "levante",
  status: "UNKNOWN",
});
const board = buildResearchForecastBoard({
  competition: "la-liga",
  season: "2026-27",
  asOf: AS_OF,
  matches: [...LIGA, scheduledUnknown],
});
check(
  "UNKNOWN status is not forecast",
  board.matches.every((row) => row.canonicalMatchId !== scheduledUnknown.canonicalMatchId)
);

const pastScheduled = match({
  id: "pd-2026-27-stale-scheduled",
  kickoffUtc: "2026-09-01T19:00:00.000Z",
  home: "elche",
  away: "levante",
  status: "SCHEDULED",
});
const staleBoard = buildResearchForecastBoard({
  competition: "la-liga",
  season: "2026-27",
  asOf: AS_OF,
  matches: [...LIGA, pastScheduled],
});
check(
  "a scheduled kickoff already in the past is not an upcoming forecast",
  staleBoard.matches.every((row) => row.canonicalMatchId !== pastScheduled.canonicalMatchId)
);

let liveThrew = false;
try {
  forecastResearchMatch({
    match: { ...MW2_FUTURE, status: "LIVE" },
    universe: LIGA,
    asOf: AS_OF,
  });
} catch (error) {
  liveThrew = error instanceof ResearchForecastError && error.code === "NOT_FORECASTABLE";
}
check("LIVE matches are not research-forecastable", liveThrew);

console.log("\n── Competition and season isolation ───────────────────────────────");
const mixed = researchRatingsAsOf(
  [...LIGA, BUNDES_FINISHED, BUNDES_FUTURE],
  { asOf: AS_OF, competition: "la-liga", season: "2026-27" },
  BIG_FIVE_RESEARCH_PARAMS
);
check("Bundesliga results do not enter La Liga ratings", mixed.ratings["bayern-munich"] === undefined);
check("La Liga still applied its own results", mixed.matchesApplied === 2);

const otherSeason = match({
  id: "pd-2025-26-real-madrid-getafe",
  season: "2025-26",
  kickoffUtc: "2025-08-16T19:00:00.000Z",
  home: "real-madrid",
  away: "getafe",
  homeGoals: 6,
  awayGoals: 0,
  resultObservedAt: "2025-08-16T21:00:00.000Z",
});
const seasonState = researchRatingsAsOf(
  [MW1_HOME, otherSeason, MW2_FUTURE],
  { asOf: AS_OF, competition: "la-liga", season: "2026-27" },
  BIG_FIVE_RESEARCH_PARAMS
);
check("another season cannot move current-season ratings", seasonState.matchesApplied === 1);

const bundesBoard = buildResearchForecastBoard({
  competition: "bundesliga",
  season: "2026-27",
  asOf: AS_OF,
  matches: [...LIGA, BUNDES_FINISHED, BUNDES_FUTURE],
});
check("Bundesliga board only lists Bundesliga fixtures", bundesBoard.matches.every((row) => row.competition === "bundesliga"));
check(
  "a 4–0 against Union Berlin lowers Union for the next match",
  bundesBoard.matches[0].home.elo < 1500 && bundesBoard.matches[0].home.slug === "union-berlin"
);

console.log("\n── Determinism, lookup, and board contract ────────────────────────");
const again = forecastResearchMatch({ match: MW2_FUTURE, universe: LIGA, asOf: AS_OF });
check(
  "same ledger + asOf is byte-stable",
  again.probabilities.home === ligaForecast.probabilities.home &&
    again.home.elo === ligaForecast.home.elo &&
    again.mostLikelyScoreline === ligaForecast.mostLikelyScoreline
);

const lookedUp = researchForecastForMatchId({
  matchId: MW2_FUTURE.canonicalMatchId,
  competition: "la-liga",
  season: "2026-27",
  asOf: AS_OF,
  matches: LIGA,
});
check("lookup by canonical id matches the board row", lookedUp.canonicalMatchId === MW2_FUTURE.canonicalMatchId);

let missing = false;
try {
  researchForecastForMatchId({
    matchId: "pd-2026-27-does-not-exist",
    competition: "la-liga",
    season: "2026-27",
    asOf: AS_OF,
    matches: LIGA,
  });
} catch (error) {
  missing = error instanceof ResearchForecastError && error.code === "UNKNOWN_MATCH";
}
check("unknown fixture id fails closed", missing);

const limited = buildResearchForecastBoard({
  competition: "la-liga",
  season: "2026-27",
  asOf: AS_OF,
  matches: LIGA,
  limit: 1,
});
check("limit is respected", limited.matches.length === 1 && limited.upcomingCount === 1);
check("true home/away: awayHomeShare is 0", BIG_FIVE_RESEARCH_PARAMS.awayHomeShare === 0);

console.log("\n── Source isolation ───────────────────────────────────────────────");
const researchDir = path.resolve("lib/competitions/big-five");
const researchFiles = fs
  .readdirSync(researchDir)
  .filter((file) => file.startsWith("research-") && file.endsWith(".ts"));
for (const file of researchFiles) {
  const src = fs.readFileSync(path.join(researchDir, file), "utf8");
  check(`${file} does not import createSnapshot`, !src.includes("createSnapshot"));
  check(`${file} does not import predictPremierLeagueMatch`, !src.includes("predictPremierLeagueMatch"));
  check(`${file} does not import loadProductionParams`, !src.includes("loadProductionParams"));
  check(`${file} does not write the LIVE_OOS store`, !src.includes("listLiveSnapshots"));
}

assert.equal(process.exitCode ?? 0, 0);
console.log(`\nAll ${passed} Big Five research forecast checks passed.`);
