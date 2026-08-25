/**
 * Phase 2A.1 guardrail gates. Must not rewrite the committed LIVE_OOS tape.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const STORE = path.join(os.tmpdir(), `foa-2a1-${process.pid}.jsonl`);
const ARCHIVE = path.join(os.tmpdir(), `foa-2a1-arch-${process.pid}.jsonl`);
const OPERATIONAL = path.join(os.tmpdir(), `foa-2a1-ops-${process.pid}.jsonl`);
process.env.SNAPSHOT_STORE_PATH = STORE;
process.env.LIVE_OOS_ARCHIVE_PATH = ARCHIVE;
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = OPERATIONAL;

import {
  archiveLiveOosSnapshots,
  canonicalSnapshotIdentity,
  clearSnapshotsForTests,
  createSnapshot,
  listSnapshots,
  loadCommittedLiveOos,
  replaceCanonicalLiveTape,
  snapshotIndexStats,
  snapshotUniqueKey,
} from "@/lib/snapshots/store";
import { evaluateSeasonData } from "@/lib/competitions/premier-league/data-gate";
import { liveCompetitionSeason, liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import {
  applyKickoffCertainty,
  canScheduleTimedPrediction,
  classifyOfficialKickoffCertainty,
  kickoffCertaintyCounts,
} from "@/lib/competitions/premier-league/kickoff-certainty";
import { upsertFixtures } from "@/lib/competitions/premier-league/ingest";
import { liveOosCount, snapshotsOfClass } from "@/lib/competitions/premier-league/live-ledger";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import type { Fixture } from "@/lib/identity/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");
const START_MD5 = "34f7ca54025a3a48df9f1a169df66315";

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

function snap(partial: Partial<PredictionSnapshot> & { fixtureId: string; asOf: string; predictionStage?: string }): PredictionSnapshot {
  return createSnapshot({
    fixtureId: partial.fixtureId,
    competition: "premier-league",
    season: "2026-27",
    asOf: partial.asOf,
    modelVersion: PRODUCTION_MODEL_VERSION,
    predictionStage: (partial.predictionStage as "EARLY") ?? "EARLY",
    evaluationClass: "LIVE_OOS",
    homeSlug: "arsenal",
    awaySlug: "coventry",
    home: 0.7,
    draw: 0.2,
    away: 0.1,
    homeExpectedGoals: 2,
    awayExpectedGoals: 0.8,
    scorelineDistribution: {},
  });
}

clearSnapshotsForTests();

// ── Tape must start intact ──────────────────────────────────────────────
check("live tape still 380 lines", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380);
check("live tape md5 unchanged at start", md5(TAPE) === START_MD5);

// ── Canonical identity + enumeration ────────────────────────────────────
const a = snap({ fixtureId: "enum-a", asOf: "2026-08-16" });
const again = snap({ fixtureId: "enum-a", asOf: "2026-08-16" });
check("first-write-wins", again.home === 0.7);
check(
  "canonical identity includes stage",
  canonicalSnapshotIdentity(a).includes("EARLY") && snapshotUniqueKey(a) === canonicalSnapshotIdentity(a)
);
const listed = listSnapshots();
check("listSnapshots is unique", listed.length === 1);
check("index may have aliases but enumeration does not", snapshotIndexStats().uniqueSnapshots === 1);

const committed = loadCommittedLiveOos();
check("committed LIVE_OOS unique count is 380", committed.length === 380);
const canonicalLedger = canonicalLedgerMetrics();
check(
  "canonical committed forecast snapshots remain 380",
  canonicalLedger.production.committedForecastSnapshots === 380
);
check(
  "canonical operational forecast snapshots include the isolated working row",
  canonicalLedger.production.operationalForecastSnapshots === 1
);
check(
  "canonical production total is committed plus operational snapshots",
  canonicalLedger.production.totalForecastSnapshots === 381 && liveOosCount() === 381
);

// ── Archive idempotency ─────────────────────────────────────────────────
const sample = committed.slice(0, 5);
const r1 = archiveLiveOosSnapshots(sample.concat(sample)); // aliases in the batch
const r2 = archiveLiveOosSnapshots(sample);
const r3 = archiveLiveOosSnapshots(sample);
check("first archive unique 5", r1.uniqueAfter === 5 && r1.appended === 5);
check("second archive no append", r2.appended === 0 && r2.uniqueAfter === 5);
check("third archive no append", r3.appended === 0 && r3.uniqueAfter === 5);
const archLines = fs.readFileSync(ARCHIVE, "utf8").trim().split("\n").filter(Boolean);
check("archive file has 5 unique lines", archLines.length === 5);

// ── No-overwrite guard ──────────────────────────────────────────────────
let threw = false;
try {
  replaceCanonicalLiveTape();
} catch {
  threw = true;
}
check("destructive replace of live tape throws", threw);

// ── Stage identity still distinct ───────────────────────────────────────
const early = snap({ fixtureId: "stage-x", asOf: "2026-08-16", predictionStage: "EARLY" });
const t24 = createSnapshot({
  fixtureId: "stage-x",
  competition: "premier-league",
  season: "2026-27",
  asOf: "2026-08-16",
  modelVersion: PRODUCTION_MODEL_VERSION,
  predictionStage: "T24H",
  evaluationClass: "LIVE_OOS",
  homeSlug: "arsenal",
  awaySlug: "coventry",
  home: 0.71,
  draw: 0.19,
  away: 0.1,
  homeExpectedGoals: 2,
  awayExpectedGoals: 0.8,
  scorelineDistribution: {},
});
check("stage identity still splits keys", early.provenance.uniqueKey !== t24.provenance.uniqueKey);

// ── Kickoff certainty ───────────────────────────────────────────────────
check("weekend 15:00 is DEFAULT", classifyOfficialKickoffCertainty("2026-10-10", "15:00") === "DEFAULT");
check("Wednesday 20:00 is DEFAULT", classifyOfficialKickoffCertainty("2026-12-02", "20:00") === "DEFAULT");
check("12:30 is CONFIRMED", classifyOfficialKickoffCertainty("2026-08-22", "12:30") === "CONFIRMED");
check("Friday 20:00 listed slot is CONFIRMED", classifyOfficialKickoffCertainty("2026-08-21", "20:00") === "CONFIRMED");
check("missing time is TBD", classifyOfficialKickoffCertainty("2026-10-10", "") === "TBD");

const fixtures = liveFixtures().map(applyKickoffCertainty);
const cert = kickoffCertaintyCounts(fixtures);
check("all 380 fixtures classified", cert.CONFIRMED + cert.DEFAULT + cert.PROVISIONAL + cert.TBD === 380);
check("some CONFIRMED kickoffs exist", cert.CONFIRMED > 0);
check("default slots exist", cert.DEFAULT >= 300);

const defFx = fixtures.find((f) => f.kickoffCertainty === "DEFAULT")!;
const confFx = fixtures.find((f) => f.kickoffCertainty === "CONFIRMED")!;
check("DEFAULT cannot schedule T60M", canScheduleTimedPrediction(defFx, "T60M") === false);
check("DEFAULT cannot schedule T24H", canScheduleTimedPrediction(defFx, "T24H") === false);
check("CONFIRMED can schedule T60M", canScheduleTimedPrediction(confFx, "T60M") === true);
check("EARLY allowed on DEFAULT", canScheduleTimedPrediction(defFx, "EARLY") === true);

// ── Reschedule identity ─────────────────────────────────────────────────
const sat = fixtures.find((f) => f.id === "pl-2026-27-arsenal-leeds") ?? fixtures.find((f) => f.kickoffCertainty === "DEFAULT")!;
const updated = {
  ...sat,
  date: "2026-10-11",
  scheduledDate: "2026-10-11",
  kickoffUtc: "2026-10-11T15:30:00.000Z",
  kickoffLocal: "2026-10-11T16:30:00",
  kickoffCertainty: "CONFIRMED" as const,
};
const merged = upsertFixtures([sat], [updated], "2026-08-16T12:00:00Z");
check("reschedule keeps identity", merged.fixtures.length === 1 && merged.fixtures[0].id === sat.id);
check("reschedule becomes CONFIRMED", merged.fixtures[0].kickoffCertainty === "CONFIRMED");
check("historical EARLY snapshot identity unchanged", early.asOf === "2026-08-16" && early.home === 0.7);
check("confirmed reschedule is timed-eligible", canScheduleTimedPrediction(merged.fixtures[0], "T60M") === true);

// ── DATA_READY real manifest ────────────────────────────────────────────
const season = liveCompetitionSeason();
const real = evaluateSeasonData({ season, fixtures, clubSeasons: undefined });
check("real 2026-27 manifest is DATA_READY", real.status === "DATA_READY", real.errors.join("; "));
check("real manifest fixture count 380", real.checks.fixtureCount && real.checks.pairCompleteness);

check(
  "379 fixtures BLOCKED",
  evaluateSeasonData({ season: season!, fixtures: fixtures.slice(0, 379) }).status === "DATA_BLOCKED"
);

const outsider = structuredClone(fixtures);
outsider[0] = { ...outsider[0], homeSlug: "west-ham", homeClubId: "west-ham" };
check("outsider fixture BLOCKED", evaluateSeasonData({ season: season!, fixtures: outsider }).status === "DATA_BLOCKED");

const dup = structuredClone(fixtures);
dup[1] = { ...dup[0], id: dup[0].id };
check("duplicate fixture id BLOCKED", evaluateSeasonData({ season: season!, fixtures: dup }).status === "DATA_BLOCKED");

const sameHome = structuredClone(fixtures);
const pairMate = sameHome.find((f) => f.awaySlug === sameHome[0].homeSlug && f.homeSlug === sameHome[0].awaySlug);
if (pairMate) {
  pairMate.homeSlug = sameHome[0].homeSlug;
  pairMate.awaySlug = sameHome[0].awaySlug;
  pairMate.id = `${sameHome[0].id}-dupair`;
}
check(
  "same-venue pair twice BLOCKED",
  pairMate
    ? evaluateSeasonData({ season: season!, fixtures: sameHome }).status === "DATA_BLOCKED"
    : false
);

const homeEq = structuredClone(fixtures);
homeEq[2] = { ...homeEq[2], awaySlug: homeEq[2].homeSlug };
check("home = away BLOCKED", evaluateSeasonData({ season: season!, fixtures: homeEq }).status === "DATA_BLOCKED");

const split = structuredClone(fixtures);
const arsenalHome = split.find((f) => f.homeSlug === "arsenal")!;
arsenalHome.homeSlug = "liverpool";
arsenalHome.homeClubId = "liverpool";
check(
  "18/20 home-away split BLOCKED",
  evaluateSeasonData({ season: season!, fixtures: split }).status === "DATA_BLOCKED"
);

const noDate = structuredClone(fixtures);
noDate[3] = { ...noDate[3], date: "", scheduledDate: "" };
check("missing fixture date BLOCKED", evaluateSeasonData({ season: season!, fixtures: noDate }).status === "DATA_BLOCKED");

const unresolved = structuredClone(fixtures);
unresolved[4] = { ...unresolved[4], homeSlug: "", homeClubId: "" };
check("unresolved club BLOCKED", evaluateSeasonData({ season: season!, fixtures: unresolved }).status === "DATA_BLOCKED");

const noProv = structuredClone(season!);
noProv.source = "";
noProv.retrievedAt = "";
const noProvFx = fixtures.map((f) => ({ ...f, source: undefined }));
check(
  "missing provenance BLOCKED",
  evaluateSeasonData({ season: noProv, fixtures: noProvFx }).status === "DATA_BLOCKED"
);

check(
  "DEFAULT kickoff still DATA_READY",
  evaluateSeasonData({ season: season!, fixtures }).status === "DATA_READY" &&
    canScheduleTimedPrediction(defFx, "T60M") === false
);

check(
  "LIVE_OOS isolation still works",
  snapshotsOfClass("BACKTEST", "2025-26").every((s) => s.evaluationClass === "BACKTEST")
);

// ── Ending tape integrity ───────────────────────────────────────────────
check("ending tape line count 380", fs.readFileSync(TAPE, "utf8").trim().split("\n").length === 380);
check("ending tape md5 unchanged", md5(TAPE) === START_MD5);

clearSnapshotsForTests();
if (fs.existsSync(ARCHIVE)) fs.unlinkSync(ARCHIVE);
console.log(`\nPhase 2A.1 gates: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
