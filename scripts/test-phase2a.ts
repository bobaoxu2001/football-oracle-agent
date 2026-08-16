/**
 * Phase 2A gates: membership, fixtures, time, ingest, ledger, stages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE = path.join(os.tmpdir(), `foa-phase2a-${process.pid}.jsonl`);
const SETTLEMENTS = path.join(os.tmpdir(), `foa-phase2a-set-${process.pid}.jsonl`);
process.env.SNAPSHOT_STORE_PATH = STORE;
process.env.SETTLEMENT_STORE_PATH = SETTLEMENTS;

import {
  createSnapshot,
  getSnapshotByKey,
  clearSnapshotsForTests,
  snapshotUniqueKey,
} from "@/lib/snapshots/store";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import {
  ingestOfficial202627,
  officialFixtureId,
  upsertFixtures,
  PROMOTED_2026_27,
  RELEGATED_FROM_2025_26,
  SEASON_2026_27_CLUBS,
  canonicalizeFixtureStatus,
} from "@/lib/competitions/premier-league/ingest";
import { liveClubSeasons, liveCompetitionSeason, liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { evaluateDataGate } from "@/lib/competitions/premier-league/data-gate";
import {
  londonLocalToUtcIso,
  utcIsoToLondonLocal,
  isBeforeKickoff,
  kickoffUtcFromSource,
} from "@/lib/competitions/premier-league/timezone";
import { stageFromTiming, evaluationClassFor } from "@/lib/competitions/premier-league/stages";
import { initializeSeasonRatings } from "@/lib/prediction-engine/season-init";
import { loadSeasonInitCoefficients } from "@/lib/prediction-engine/season-init-params";
import { snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { canSettle, settleFixture, settlementFromSnapshot, clearSettlementsForTests } from "@/lib/competitions/premier-league/settlement";
import { snapshotsOfClass, ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { BENCHMARK_TRACK, PRODUCTION_TRACK, PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
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

clearSnapshotsForTests();
clearSettlementsForTests();

// ── Membership ──────────────────────────────────────────────────────────
const season = liveCompetitionSeason();
const fixtures = liveFixtures();
const clubSeasons = liveClubSeasons();
check("season manifest exists", !!season);
check("club count is 20", (season?.clubIds.length ?? 0) === 20);
check("club ids unique", new Set(season?.clubIds ?? []).size === 20);
check("club seasons unique", new Set(clubSeasons.map((c) => c.clubSlug)).size === clubSeasons.length && clubSeasons.length === 20);
check(
  "no relegated club remains active",
  RELEGATED_FROM_2025_26.every((id) => !season?.clubIds.includes(id))
);
check(
  "promoted clubs are active",
  PROMOTED_2026_27.every((id) => season?.clubIds.includes(id))
);
check(
  "promoted clubs use promoted entry",
  PROMOTED_2026_27.every((id) => clubSeasons.find((c) => c.clubSlug === id)?.entry === "promoted")
);
check(
  "continuing clubs use stayed entry",
  clubSeasons.filter((c) => c.entry === "stayed").length === 17
);

// ── Fixtures ────────────────────────────────────────────────────────────
const ids = fixtures.map((f) => f.id);
check("no duplicate fixture ids", new Set(ids).size === ids.length);
check("home != away", fixtures.every((f) => f.homeSlug !== f.awaySlug));
check(
  "all clubs belong to active season",
  fixtures.every((f) => season!.clubIds.includes(f.homeSlug) && season!.clubIds.includes(f.awaySlug))
);
check("kickoff timestamp valid", fixtures.every((f) => !!f.kickoffUtc && Number.isFinite(Date.parse(f.kickoffUtc))));
check("fixture source exists", fixtures.every((f) => !!f.source && !!f.sourceFixtureId));
check("season id correct", fixtures.every((f) => f.season === PREMIER_LEAGUE_CURRENT_SEASON));
if (season?.scheduleCompleteness === "complete") {
  check("380 fixtures", fixtures.length === 380);
  const homeN: Record<string, number> = {};
  const awayN: Record<string, number> = {};
  const tot: Record<string, number> = {};
  for (const f of fixtures) {
    homeN[f.homeSlug] = (homeN[f.homeSlug] ?? 0) + 1;
    awayN[f.awaySlug] = (awayN[f.awaySlug] ?? 0) + 1;
    tot[f.homeSlug] = (tot[f.homeSlug] ?? 0) + 1;
    tot[f.awaySlug] = (tot[f.awaySlug] ?? 0) + 1;
  }
  check(
    "38 fixtures per club, 19 home, 19 away",
    SEASON_2026_27_CLUBS.every((c) => tot[c] === 38 && homeN[c] === 19 && awayN[c] === 19)
  );
} else {
  check("partial schedule distinguished", season?.scheduleCompleteness === "partial");
}

// ── Time ────────────────────────────────────────────────────────────────
const bst = londonLocalToUtcIso("2026-08-21", "20:00");
check("BST 20:00 → 19:00Z", bst === "2026-08-21T19:00:00.000Z");
const gmt = londonLocalToUtcIso("2026-12-26", "15:00");
check("GMT 15:00 → 15:00Z", gmt === "2026-12-26T15:00:00.000Z");
const spring = londonLocalToUtcIso("2027-03-28", "16:30");
check("after March DST 16:30 → 15:30Z", spring === "2027-03-28T15:30:00.000Z");
const local = utcIsoToLondonLocal("2026-08-21T19:00:00.000Z");
check("UTC display conversion", local.date === "2026-08-21" && local.time === "20:00");
const midnight = londonLocalToUtcIso("2026-08-22", "00:30");
check("near-midnight UTC stays previous calendar day in UTC", midnight.startsWith("2026-08-21T23:30"));
check("asOf before kickoff", isBeforeKickoff("2026-08-16T12:00:00Z", bst));
check("asOf after kickoff rejected", !isBeforeKickoff("2026-08-21T19:00:00Z", bst));
check(
  "FINAL_PREKICK not assigned after kickoff",
  stageFromTiming("2026-08-21T20:00:00Z", bst) === "RETROSPECTIVE"
);
check("early stage 5 days out", stageFromTiming("2026-08-16T12:00:00Z", bst) === "EARLY");
check("preseason stage 3 weeks out", stageFromTiming("2026-07-30T12:00:00Z", bst) === "PRESEASON");
check(
  "post-kickoff cannot be LIVE_OOS",
  evaluationClassFor({ asOf: "2026-08-21T19:00:00Z", kickoffUtc: bst, intended: "LIVE_OOS" }) ===
    "RETROSPECTIVE"
);

const first = fixtures.find((f) => f.homeSlug === "arsenal" && f.awaySlug === "coventry")!;
const rescheduled = { ...first, kickoffUtc: "2026-08-21T18:00:00.000Z", date: "2026-08-21" };
const merged = upsertFixtures([first], [rescheduled], "2026-08-16T00:00:00Z");
check("reschedule keeps identity", merged.fixtures.length === 1 && merged.fixtures[0].id === first.id);
check("reschedule updates kickoff", merged.fixtures[0].kickoffUtc === "2026-08-21T18:00:00.000Z");
check("reschedule writes revision", merged.revisions.some((r) => r.field === "kickoffUtc"));

// ── Ingest idempotency ──────────────────────────────────────────────────
const a = ingestOfficial202627({ retrievedAt: "2026-08-16T12:00:00.000Z" });
const b = ingestOfficial202627({
  retrievedAt: "2026-08-16T12:00:00.000Z",
  existingFixtures: a.fixtures,
});
check("ingest twice → same fixture count", a.fixtures.length === b.fixtures.length);
check("ingest twice → same ids", a.fixtures.every((f, i) => f.id === b.fixtures[i].id));
check("second ingest no new identities", b.fixtures.length === new Set(b.fixtures.map((f) => f.id)).size);

// result update does not change a frozen prediction
const snap = snapshotPremierLeagueMatch("arsenal", "coventry", {
  asOf: "2026-08-16T12:00:00.000Z",
  kickoff: first.kickoffUtc ?? undefined,
  fixtureId: first.id,
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  evaluationClass: "LIVE_OOS",
});
const originalP = snap.homeProbability;
const finished: Fixture = {
  ...first,
  status: "FINISHED",
  homeGoals: 2,
  awayGoals: 0,
  resultSource: "test",
};
const settled = settleFixture(finished);
check("settlement written", settled.length >= 1);
const reread = getSnapshotByKey({
  competition: "premier-league",
  season: PREMIER_LEAGUE_CURRENT_SEASON,
  fixtureId: first.id,
  modelVersion: snap.modelVersion,
  predictionStage: snap.predictionStage,
  asOf: snap.asOf,
});
check("result update leaves prediction unchanged", reread!.homeProbability === originalP);
const postponed: Fixture = { ...first, status: "POSTPONED", homeGoals: 0, awayGoals: 3 };
check("postponed is not settleable", canSettle(postponed) === false);

// ── Snapshot stage identity ─────────────────────────────────────────────
clearSnapshotsForTests();
const s1 = createSnapshot({
  fixtureId: "pl-test-stage",
  competition: "premier-league",
  season: "2026-27",
  asOf: "2026-08-16",
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "PRESEASON",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.4,
  draw: 0.3,
  away: 0.3,
  homeExpectedGoals: 1.4,
  awayExpectedGoals: 1.2,
  scorelineDistribution: {},
});
const s2 = createSnapshot({
  fixtureId: "pl-test-stage",
  competition: "premier-league",
  season: "2026-27",
  asOf: "2026-08-16",
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "T24H",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.5,
  draw: 0.25,
  away: 0.25,
  homeExpectedGoals: 1.6,
  awayExpectedGoals: 1.1,
  scorelineDistribution: {},
});
check("stage is part of identity", s1.provenance.uniqueKey !== s2.provenance.uniqueKey);
check("both stages coexist", s1.home === 0.4 && s2.home === 0.5);
check("canonical stage stored", canonicalizePredictionStage(s1.predictionStage) === "PRESEASON");
check("legacy alias maps", canonicalizePredictionStage("preseason-baseline") === "PRESEASON");

// ── Ledger isolation ────────────────────────────────────────────────────
createSnapshot({
  fixtureId: "pl-test-backtest",
  competition: "premier-league",
  season: "2025-26",
  asOf: "2025-08-16",
  modelVersion: "pl-baseline-v0.1.0",
  predictionStage: "HISTORICAL",
  evaluationClass: "BACKTEST",
  homeSlug: "arsenal",
  awaySlug: "liverpool",
  home: 0.4,
  draw: 0.3,
  away: 0.3,
  homeExpectedGoals: 1,
  awayExpectedGoals: 1,
  scorelineDistribution: {},
});
createSnapshot({
  fixtureId: "pl-test-retro",
  competition: "premier-league",
  season: "2026-27",
  asOf: "2026-08-22",
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "RETROSPECTIVE",
  evaluationClass: "RETROSPECTIVE",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  home: 0.6,
  draw: 0.2,
  away: 0.2,
  homeExpectedGoals: 1,
  awayExpectedGoals: 1,
  scorelineDistribution: {},
});
const liveOnly = snapshotsOfClass("LIVE_OOS", "2026-27");
const retroOnly = snapshotsOfClass("RETROSPECTIVE", "2026-27");
const backOnly = snapshotsOfClass("BACKTEST", "2025-26");
check(
  "LIVE_OOS query excludes retro/backtest",
  liveOnly.every((s) => s.evaluationClass === "LIVE_OOS") &&
    !liveOnly.some((s) => s.fixtureId === "pl-test-retro" || s.fixtureId === "pl-test-backtest")
);
check("RETROSPECTIVE isolated", retroOnly.every((s) => s.evaluationClass === "RETROSPECTIVE"));
check("BACKTEST isolated", backOnly.every((s) => s.evaluationClass === "BACKTEST"));

// ── Model tracks ────────────────────────────────────────────────────────
check("benchmark feeder OFF", BENCHMARK_TRACK.useChampionshipFeeder === false);
check("production feeder ON", PRODUCTION_TRACK.useChampionshipFeeder === true);
check("tracks have different versions", BENCHMARK_TRACK.modelVersion !== PRODUCTION_TRACK.modelVersion);
check("production version is pl-live-v0.2.0", PRODUCTION_TRACK.modelVersion === "pl-live-v0.2.0");

// ── Season init paths ───────────────────────────────────────────────────
const coeffs = loadSeasonInitCoefficients();
const init = initializeSeasonRatings({
  previousPlRatings: { arsenal: 1800, "west-ham": 1450 },
  previousPlClubSlugs: ["arsenal", "west-ham"],
  newSeasonClubSlugs: ["arsenal", "coventry"],
  feederRatings: { coventry: 1650 },
  season: "2026-27",
  coefficients: coeffs,
});
check("continuing club uses shrink path", init.paths.arsenal === "staying-shrunk");
check("promoted club uses feeder path", init.paths.coventry === "promoted-from-championship");
check("west ham not active", !init.clubSeasons.some((c) => c.clubSlug === "west-ham" && c.entry === "stayed"));

// ── Honesty is season-aware ─────────────────────────────────────────────
const honesty = currentHonestyText();
check("honesty mentions current season from config", honesty.includes(PREMIER_LEAGUE_CURRENT_SEASON));
check("honesty does not invent injuries", !/injury crisis/i.test(honesty));

// ── Data gate ───────────────────────────────────────────────────────────
const gate = evaluateDataGate();
check("data gate is not blocked once ingested", gate.status !== "DATA_BLOCKED", gate.status);
check("official fixture id is pairing-stable", officialFixtureId("arsenal", "coventry").includes("arsenal-coventry"));
check("status enum maps completed → FINISHED", canonicalizeFixtureStatus("completed") === "FINISHED");

// ── Kickoff helper ──────────────────────────────────────────────────────
check(
  "weekend default 15:00 BST",
  kickoffUtcFromSource("2026-10-10", "15:00") === "2026-10-10T14:00:00.000Z"
);

clearSnapshotsForTests();
clearSettlementsForTests();
console.log(`\nPhase 2A gates: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
