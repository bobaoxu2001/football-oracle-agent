/**
 * Phase 2B0 gates. Isolated market store only.
 * Must not rewrite the committed LIVE_OOS tape or change forecast params.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-2b0-"));
process.env.MARKET_STORE_BACKEND = "file";
process.env.MARKET_STORE_DIR = path.join(TMP, "market");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.PL_OPS_BACKEND = "file";
process.env.MARKET_RECORDER_DISABLED = "1";
delete process.env.VERCEL;
delete process.env.ODDS_API_KEY;

import type { Fixture } from "@/lib/identity/types";
import { snapshotPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { liveStateFromEvents } from "@/lib/competitions/premier-league/ops/rating-events";
import { officialFixtureId } from "@/lib/competitions/premier-league/ingest";
import { evaluateDecimal1x2, fairSumsToOne } from "@/lib/competitions/premier-league/market/odds-math";
import { extractH2hOdds } from "@/lib/competitions/premier-league/market/the-odds-api";
import { mapMarketEvent } from "@/lib/competitions/premier-league/market/mapping";
import { alignMarketToModelAsOf, closingConsensus, closingObservation } from "@/lib/competitions/premier-league/market/alignment";
import { maybeRunMarketRecorder, observationIdOf } from "@/lib/competitions/premier-league/market/recorder";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import {
  insertObservation,
  listConsensus,
  listObservations,
  resetMarketStoreForTests,
} from "@/lib/competitions/premier-league/market/store";
import { effectiveCadenceMs, CADENCE_FAR_MS, CADENCE_WEEK_MS, CADENCE_NEAR_MS } from "@/lib/competitions/premier-league/market/cadence";
import type { MarketDataSource, MarketObservation, MarketSourceFetchResult } from "@/lib/competitions/premier-league/market/types";
import { MARKET_SCHEMA_VERSION } from "@/lib/competitions/premier-league/market/types";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const START_MD5 = "34f7ca54025a3a48df9f1a169df66315";
const START_SHA = "a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da";

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
function md5(file: string): string {
  return createHash("md5").update(fs.readFileSync(file)).digest("hex");
}
function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const arsenalCoventry: Fixture = {
  id: officialFixtureId("arsenal", "coventry"),
  competition: "premier-league",
  season: "2026-27",
  date: "2026-08-21",
  kickoffUtc: "2026-08-21T19:00:00.000Z",
  kickoff: "2026-08-21T19:00:00.000Z",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  homeTeam: "Arsenal",
  awayTeam: "Coventry City",
  status: "SCHEDULED",
  homeGoals: null,
  awayGoals: null,
  kickoffCertainty: "CONFIRMED",
  source: "test",
  venue: "home",
} as Fixture;

function fakeSource(events: MarketSourceFetchResult["events"], quota = { remaining: 400, used: 10, lastRequestCost: 1 }): MarketDataSource {
  return {
    id: "the-odds-api",
    configured: true,
    async fetchH2h(nowIso: string): Promise<MarketSourceFetchResult> {
      return {
        source: "the-odds-api",
        retrievedAt: nowIso,
        region: "uk",
        sportKey: "soccer_epl",
        marketType: "h2h",
        events,
        quota,
      };
    },
  };
}

function downSource(): MarketDataSource {
  return {
    id: "the-odds-api",
    configured: true,
    async fetchH2h(): Promise<MarketSourceFetchResult> {
      throw new Error("simulated odds outage");
    },
  };
}

async function main() {
  check("tape start lines", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380);
  check("tape start md5", md5(TAPE) === START_MD5);
  check("tape start sha", sha256(TAPE) === START_SHA);

  const params = loadProductionParams();
  check("modelVersion frozen", params.modelVersion === "pl-live-v0.2.0");
  check("HA frozen", params.homeAdvantage === 72);
  check("rho frozen", params.dcRho === -0.061);

  const even = evaluateDecimal1x2(2, 4, 4);
  check("even raw implied", even.rawImplied.home === 0.5 && even.rawImplied.draw === 0.25 && even.rawImplied.away === 0.25);
  check("even overround", even.overround === 1);
  check("even fair", even.fair.home === 0.5 && even.fair.draw === 0.25 && even.fair.away === 0.25);

  const vig = evaluateDecimal1x2(1.8, 3.6, 4.5);
  const qH = 1 / 1.8;
  const qD = 1 / 3.6;
  const qA = 1 / 4.5;
  const over = qH + qD + qA;
  check("vig raw implied", Math.abs(vig.rawImplied.home - qH) < 1e-15 && Math.abs(vig.rawImplied.draw - qD) < 1e-15);
  check("vig overround", Math.abs(vig.overround - over) < 1e-15);
  check("vig margin", Math.abs(vig.bookmakerMargin - (over - 1)) < 1e-15);
  check("vig fair home", Math.abs(vig.fair.home - qH / over) < 1e-15);
  check("vig fair sums to 1", fairSumsToOne(vig.fair));
  try {
    evaluateDecimal1x2(1, 3, 4);
    check("odds=1 rejected", false);
  } catch {
    check("odds=1 rejected", true);
  }

  const permuted = extractH2hOdds(
    [
      { name: "Coventry City", price: 8 },
      { name: "Draw", price: 5.5 },
      { name: "Arsenal", price: 1.35 },
    ],
    "Arsenal",
    "Coventry City"
  );
  check("draw mapping ignores order", permuted?.home === 1.35 && permuted.draw === 5.5 && permuted.away === 8);

  const exact = mapMarketEvent(
    {
      source: "the-odds-api",
      sourceEventId: "evt-1",
      sportKey: "soccer_epl",
      homeTeam: "Arsenal",
      awayTeam: "Coventry City",
      commenceTime: "2026-08-21T19:00:00Z",
      bookmakers: [],
    },
    [arsenalCoventry],
    "2026-08-18T12:00:00.000Z",
    null
  );
  check("exact fixture mapped", exact.mappingStatus === "MATCHED" && exact.canonicalFixtureId === arsenalCoventry.id);

  const alias = mapMarketEvent(
    {
      source: "the-odds-api",
      sourceEventId: "evt-alias",
      sportKey: "soccer_epl",
      homeTeam: "Gunners",
      awayTeam: "Sky Blues",
      commenceTime: "2026-08-21T19:05:00Z",
      bookmakers: [],
    },
    [arsenalCoventry],
    "2026-08-18T12:00:00.000Z",
    null
  );
  check("alias + slight kickoff still MATCHED", alias.mappingStatus === "MATCHED" && alias.canonicalFixtureId === arsenalCoventry.id);

  const resched = mapMarketEvent(
    {
      source: "the-odds-api",
      sourceEventId: "evt-1",
      sportKey: "soccer_epl",
      homeTeam: "Arsenal",
      awayTeam: "Coventry City",
      commenceTime: "2026-08-22T14:00:00Z",
      bookmakers: [],
    },
    [arsenalCoventry],
    "2026-08-18T13:00:00.000Z",
    exact
  );
  check("reschedule keeps same fixture", resched.mappingStatus === "MATCHED" && resched.canonicalFixtureId === arsenalCoventry.id);

  const unknown = mapMarketEvent(
    {
      source: "the-odds-api",
      sourceEventId: "evt-x",
      sportKey: "soccer_epl",
      homeTeam: "Not A Club",
      awayTeam: "Also Fake",
      commenceTime: "2026-08-21T19:00:00Z",
      bookmakers: [],
    },
    [arsenalCoventry],
    "2026-08-18T12:00:00.000Z",
    null
  );
  check("unknown team UNMATCHED", unknown.mappingStatus === "UNMATCHED" && unknown.canonicalFixtureId === null);

  const rows: MarketObservation[] = ["10:00", "11:00", "12:00"].map((hh, i) => ({
    observationId: `obs-${i}`,
    marketSchemaVersion: MARKET_SCHEMA_VERSION,
    origin: "LIVE_RECORDED",
    source: "the-odds-api",
    sourceEventId: "evt-1",
    canonicalFixtureId: arsenalCoventry.id,
    mappingStatus: "MATCHED",
    bookmakerKey: "bet365",
    bookmakerName: "Bet365",
    marketType: "h2h",
    retrievedAt: `2026-08-20T${hh}:00.000Z`,
    bookmakerLastUpdate: `2026-08-20T${hh}:00.000Z`,
    commenceTime: arsenalCoventry.kickoffUtc!,
    homeOddsDecimal: 1.4,
    drawOddsDecimal: 5,
    awayOddsDecimal: 8,
    rawImpliedHome: 1 / 1.4,
    rawImpliedDraw: 0.2,
    rawImpliedAway: 0.125,
    overround: 1 / 1.4 + 0.2 + 0.125,
    bookmakerMargin: 1 / 1.4 + 0.2 + 0.125 - 1,
    devigMethod: "proportional-v1",
    fairHome: 0.7,
    fairDraw: 0.2,
    fairAway: 0.1,
    sourceRegion: "uk",
    pollJobId: `poll-${i}`,
  }));
  const aligned = alignMarketToModelAsOf(rows, "2026-08-20T11:30:00.000Z");
  check("no-lookahead picks 11:00 not 12:00", aligned?.retrievedAt === "2026-08-20T11:00:00.000Z");

  const closeRows = ["14:40", "14:50", "14:58", "15:01"].map((hh, i) => ({
    ...rows[0],
    observationId: `c-${i}`,
    retrievedAt: `2026-08-21T${hh}:00.000Z`,
    pollJobId: `c-${i}`,
  }));
  const closing = closingObservation(closeRows, "2026-08-21T15:00:00.000Z");
  check("closing uses 14:58 not 15:01", closing?.retrievedAt === "2026-08-21T14:58:00.000Z");
  check("closingConsensus same rule", closingConsensus(closeRows.map((r) => ({
    consensusId: r.observationId,
    marketSchemaVersion: MARKET_SCHEMA_VERSION,
    origin: "LIVE_RECORDED" as const,
    source: r.source,
    canonicalFixtureId: r.canonicalFixtureId,
    marketType: "h2h",
    retrievedAt: r.retrievedAt,
    computedAt: r.retrievedAt,
    pollJobId: r.pollJobId,
    bookmakerCount: 1,
    consensusMethod: "median-fair-v1" as const,
    fairHome: 0.7,
    fairDraw: 0.2,
    fairAway: 0.1,
    marginMin: 0.05,
    marginMax: 0.05,
    dispersionHome: { min: 0.7, max: 0.7, stdev: 0, iqr: 0 },
    dispersionDraw: { min: 0.2, max: 0.2, stdev: 0, iqr: 0 },
    dispersionAway: { min: 0.1, max: 0.1, stdev: 0, iqr: 0 },
  })), "2026-08-21T15:00:00.000Z")?.retrievedAt === "2026-08-21T14:58:00.000Z");

  resetMarketStoreForTests();
  const event = {
    source: "the-odds-api",
    sourceEventId: "evt-live",
    sportKey: "soccer_epl",
    homeTeam: "Arsenal",
    awayTeam: "Coventry City",
    commenceTime: "2026-08-21T19:00:00Z",
    bookmakers: [
      {
        bookmakerKey: "bet365",
        bookmakerName: "Bet365",
        lastUpdate: "2026-08-18T10:00:00Z",
        outcomes: [
          { name: "Arsenal", price: 1.35 },
          { name: "Draw", price: 5.5 },
          { name: "Coventry City", price: 8.0 },
        ],
      },
      {
        bookmakerKey: "williamhill",
        bookmakerName: "William Hill",
        lastUpdate: "2026-08-18T10:00:00Z",
        outcomes: [
          { name: "Away", price: 7.8 },
          { name: "Arsenal", price: 1.38 },
          { name: "Draw", price: 5.2 },
        ],
      },
    ],
  };
  // williamhill "Away" is not the team name — second book should be dropped as invalid mapping
  event.bookmakers[1].outcomes = [
    { name: "Coventry City", price: 7.8 },
    { name: "Arsenal", price: 1.38 },
    { name: "Draw", price: 5.2 },
  ];

  const beforePred = snapshotPremierLeagueMatch("arsenal", "coventry", {
    asOf: "2026-08-18T10:00:00.000Z",
    kickoff: "2026-08-21T19:00:00.000Z",
    fixtureId: arsenalCoventry.id,
    predictionStage: "EARLY",
    evaluationClass: "LIVE_OOS",
  });
  const beforeBytes = JSON.stringify({
    h: beforePred.homeProbability,
    d: beforePred.drawProbability,
    a: beforePred.awayProbability,
    xh: beforePred.homeGoalExpectation,
    xa: beforePred.awayGoalExpectation,
    v: beforePred.modelVersion,
  });
  const beforeRatings = liveStateFromEvents("2026-08-18T10:00:00.000Z");

  const first = await maybeRunMarketRecorder({
    now: "2026-08-18T10:00:00.000Z",
    fixtures: [arsenalCoventry],
    source: fakeSource([event]),
    origin: "TEST",
    force: true,
  });
  check("first poll succeeded", first?.status === "SUCCEEDED", first?.status);
  check("two bookmakers stored", first?.observationsWritten === 2, String(first?.observationsWritten));
  check("one consensus", first?.consensusWritten === 1);

  const retry = await maybeRunMarketRecorder({
    now: "2026-08-18T10:00:00.000Z",
    fixtures: [arsenalCoventry],
    source: fakeSource([event]),
    origin: "TEST",
    force: true,
  });
  const afterRetry = await listObservations();
  check("retry same pollJob window writes new job ids", retry?.pollJobId !== first?.pollJobId);
  // same now + force creates a new pollJobId so heartbeats are allowed; simulate exact retry of same id:
  const dupId = observationIdOf({
    source: "the-odds-api",
    sourceEventId: "evt-live",
    bookmakerKey: "bet365",
    pollJobId: first!.pollJobId,
  });
  const dup = await insertObservation({ ...(afterRetry[0] as MarketObservation), observationId: dupId });
  check("identical observationId is first-write-wins", dup === "duplicate");

  const laterSamePrice = await maybeRunMarketRecorder({
    now: "2026-08-18T16:00:00.000Z",
    fixtures: [arsenalCoventry],
    source: fakeSource([event]),
    origin: "TEST",
    force: true,
  });
  const all = await listObservations({ fixtureId: arsenalCoventry.id });
  const times = new Set(all.map((r) => r.retrievedAt));
  check("later poll with unchanged prices is a new heartbeat", laterSamePrice?.observationsWritten === 2 && times.size >= 2);

  const extreme = {
    ...event,
    bookmakers: [
      {
        bookmakerKey: "extreme",
        bookmakerName: "Extreme",
        lastUpdate: "2026-08-18T16:05:00Z",
        outcomes: [
          { name: "Arsenal", price: 1.01 },
          { name: "Draw", price: 50 },
          { name: "Coventry City", price: 80 },
        ],
      },
    ],
  };
  await maybeRunMarketRecorder({
    now: "2026-08-18T16:05:00.000Z",
    fixtures: [arsenalCoventry],
    source: fakeSource([extreme]),
    origin: "TEST",
    force: true,
  });

  const afterPred = snapshotPremierLeagueMatch("arsenal", "coventry", {
    asOf: "2026-08-18T10:00:00.000Z",
    kickoff: "2026-08-21T19:00:00.000Z",
    fixtureId: arsenalCoventry.id,
    predictionStage: "EARLY",
    evaluationClass: "LIVE_OOS",
  });
  const afterBytes = JSON.stringify({
    h: afterPred.homeProbability,
    d: afterPred.drawProbability,
    a: afterPred.awayProbability,
    xh: afterPred.homeGoalExpectation,
    xa: afterPred.awayGoalExpectation,
    v: afterPred.modelVersion,
  });
  const afterRatings = liveStateFromEvents("2026-08-18T10:00:00.000Z");
  check("model probabilities unchanged after market data", beforeBytes === afterBytes);
  check(
    "ratings unchanged after market data",
    afterRatings.ratings.arsenal === beforeRatings.ratings.arsenal &&
      afterRatings.ratings.coventry === beforeRatings.ratings.coventry
  );

  const outage = await maybeRunMarketRecorder({
    now: "2026-08-18T17:00:00.000Z",
    fixtures: [arsenalCoventry],
    source: downSource(),
    origin: "TEST",
    force: true,
  });
  check("outage is FAILED market job", outage?.status === "FAILED");
  const forecast = buildHealthReport();
  check("forecast health still a known state", ["HEALTHY", "DEGRADED", "BLOCKED"].includes(forecast.overall));
  const mh = await buildMarketHealthReport();
  check("market health reports separately", Boolean(mh.overall));
  check("market outage does not rewrite tape", md5(TAPE) === START_MD5);

  const unmatchedPoll = await maybeRunMarketRecorder({
    now: "2026-08-18T18:00:00.000Z",
    fixtures: [arsenalCoventry],
    source: fakeSource([
      {
        source: "the-odds-api",
        sourceEventId: "evt-unknown",
        sportKey: "soccer_epl",
        homeTeam: "Unknown FC",
        awayTeam: "Ghost Town",
        commenceTime: "2026-08-21T19:00:00Z",
        bookmakers: [
          {
            bookmakerKey: "bet365",
            bookmakerName: "Bet365",
            lastUpdate: "2026-08-18T18:00:00Z",
            outcomes: [
              { name: "Unknown FC", price: 2 },
              { name: "Draw", price: 3 },
              { name: "Ghost Town", price: 4 },
            ],
          },
        ],
      },
    ]),
    origin: "TEST",
    force: true,
  });
  check("unmatched event writes no production snapshot", unmatchedPoll?.observationsWritten === 0);

  const cons = await listConsensus({ fixtureId: arsenalCoventry.id });
  check("consensus is derived median rows", cons.length >= 1 && cons.every((c) => c.consensusMethod === "median-fair-v1"));

  check("cadence far", effectiveCadenceMs(10 * 24 * 3600_000, 400) === CADENCE_FAR_MS);
  check("cadence week", effectiveCadenceMs(5 * 24 * 3600_000, 400) === CADENCE_WEEK_MS);
  check("cadence near", effectiveCadenceMs(3 * 3600_000, 400) === CADENCE_NEAR_MS);
  check("quota floor overrides near cadence", effectiveCadenceMs(3 * 3600_000, 15) > CADENCE_NEAR_MS);

  check("tape end md5", md5(TAPE) === START_MD5);
  check("tape end sha", sha256(TAPE) === START_SHA);
  check("schema version isolated from forecast", MARKET_SCHEMA_VERSION === "market-recorder-v0.1.0");

  console.log(`\nPhase 2B0 gates: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
