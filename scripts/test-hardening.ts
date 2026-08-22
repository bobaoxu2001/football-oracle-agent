/**
 * Hardening gates — regression cover for the durability, evaluation-metric and
 * secret-handling invariants that had no test before.
 *
 * Everything runs against an isolated temp store. This suite must never touch
 * the committed LIVE_OOS tape, the production settlement ledger, or Mongo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-harden-"));
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TMP, "ops/live-oos-operational.jsonl");
process.env.PL_TICK_LOCK_PATH = path.join(TMP, "ops/tick.lock.json");
process.env.PL_OPS_BACKEND = "file";
process.env.MARKET_RECORDER_DISABLED = "1";
delete process.env.VERCEL;
delete process.env.CRON_SECRET;

import { brier3, rps3, calculateBacktestMetrics, confidenceEce, pooledReliabilityMae } from "@/lib/evaluation/metrics";
import type { BacktestResult, Outcome } from "@/lib/evaluation/types";
import { matchProbFromGoals, scorelineGridFromGoals, matchProb } from "@/lib/prediction-engine/elo";
import { readJsonFile, readJsonl, rewriteJsonl, writeJsonFile } from "@/lib/competitions/premier-league/ops/jsonl";
import { loadSettlements, persistSettlement, type SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import { secretsMatch, authorizeOpsTick } from "@/lib/competitions/premier-league/ops/tick-auth";
import { evaluateDecimal1x2, median, iqr } from "@/lib/competitions/premier-league/market/odds-math";
import { geminiAuthHeaders, geminiEndpoint } from "@/lib/llm/gemini";
import { durationMsFromEnv, integerFromEnv, numberFromEnv } from "@/lib/config/env";
import { snapshotsOfClass, ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { loadCommittedLiveOos } from "@/lib/snapshots/store";

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

// ── Evaluation metrics: analytic values, not just "it runs" ────────────────
// A certain, correct forecast scores 0 on every proper score.
check("brier3 perfect = 0", brier3(1, 0, 0, "home") === 0);
check("rps3 perfect = 0", rps3(1, 0, 0, "home") === 0);
// A certain, WRONG forecast is the worst case: Brier 2, RPS 1.
check("brier3 confidently wrong = 2", brier3(1, 0, 0, "away") === 2);
check("rps3 confidently wrong = 1", rps3(1, 0, 0, "away") === 1);
// Uniform 1/3 baseline, stated in the module docs.
check("brier3 uniform = 2/3", near(brier3(1 / 3, 1 / 3, 1 / 3, "draw"), 2 / 3));
// RPS is ORDER-AWARE: missing by one step must beat missing by two.
const nearMiss = rps3(0, 1, 0, "home"); // predicted draw, was home
const farMiss = rps3(0, 0, 1, "home"); // predicted away, was home
check("rps3 penalises distance in the 1X2 order", nearMiss < farMiss, `${nearMiss} < ${farMiss}`);
check("rps3 one-step miss = 0.5", near(nearMiss, 0.5));
// Brier is order-blind — both misses cost the same. This is why both are kept.
check("brier3 is order-blind", brier3(0, 1, 0, "home") === brier3(0, 0, 1, "home"));

function result(home: number, draw: number, away: number, actual: Outcome): BacktestResult {
  const pActual = actual === "home" ? home : actual === "draw" ? draw : away;
  const top: Outcome = home >= draw && home >= away ? "home" : away >= draw ? "away" : "draw";
  return {
    match: {
      id: `m-${home}-${draw}-${away}-${actual}`,
      date: "2026-08-01",
      season: "2026-27",
      homeSlug: "a",
      awaySlug: "b",
      homeGoals: 1,
      awayGoals: actual === "draw" ? 1 : actual === "home" ? 0 : 2,
      competition: "premier league",
    },
    prediction: {
      winHome: home,
      draw,
      winAway: away,
      expectedGoalsHome: 1.4,
      expectedGoalsAway: 1.1,
      mostLikelyScore: { home: 1, away: 1 },
    },
    asOf: "2026-08-01",
    dataCutoff: "2026-08-01",
    modelVersion: "test",
    actual,
    predicted: top,
    correct1x2: top === actual,
    exactScore: false,
    top3Score: false,
    probAssignedToActual: pActual,
  };
}

// Perfectly calibrated set: four 50% favourites, two of which come in.
const calibrated = [
  result(0.5, 0.25, 0.25, "home"),
  result(0.5, 0.25, 0.25, "home"),
  result(0.5, 0.25, 0.25, "away"),
  result(0.5, 0.25, 0.25, "draw"),
];
const ece = confidenceEce(calibrated);
check("confidenceEce = 0 when hit rate matches confidence", near(ece.value, 0), ece.value.toFixed(12));
check("confidenceEce bins only populated ones", ece.table.length === 1 && ece.table[0].count === 4);

// Maximally overconfident: 100% favourite that never wins → ECE 1.
const overconfident = [result(1, 0, 0, "away"), result(1, 0, 0, "draw")];
check("confidenceEce = 1 when always wrong at 100%", near(confidenceEce(overconfident).value, 1));

const pooled = pooledReliabilityMae(calibrated);
check("pooledReliabilityMae is finite and non-negative", pooled.value >= 0 && Number.isFinite(pooled.value));
check(
  "pooled bins weight by 3N points",
  pooled.table.reduce((s, b) => s + b.count, 0) === calibrated.length * 3
);

const metrics = calculateBacktestMetrics(calibrated);
check("metrics accuracy1x2 = 2/4", near(metrics.accuracy1x2, 0.5));
check("metrics actualDrawRate = 1/4", near(metrics.actualDrawRate, 0.25));
check("metrics avgDrawPred = 0.25", near(metrics.avgDrawPred, 0.25));
check("empty result set is all zeros, not NaN", calculateBacktestMetrics([]).matches === 0);
check("empty logLoss is 0 not NaN", Number.isFinite(calculateBacktestMetrics([]).logLoss));

// ── Dixon-Coles grid invariants ────────────────────────────────────────────
const grid = scorelineGridFromGoals(1.5, 1.2, -0.13);
const gridSum = grid.reduce((s, g) => s + g.p, 0);
check("scoreline grid normalises to 1", near(gridSum, 1, 1e-12), gridSum.toFixed(15));
check("every grid cell is a probability", grid.every((g) => g.p >= 0 && g.p <= 1));
const p1x2 = matchProbFromGoals(1.5, 1.2, -0.13);
check("1X2 sums to 1", near(p1x2.winA + p1x2.draw + p1x2.winB, 1, 1e-12));
// The closed form and the grid must agree — they are the same distribution.
const gridHome = grid.filter((g) => g.a > g.b).reduce((s, g) => s + g.p, 0);
check("closed-form home = grid home mass", near(p1x2.winA, gridHome, 1e-12));
// Symmetry: equal λ and no home bonus must give a symmetric 1X2.
const sym = matchProbFromGoals(1.3, 1.3, -0.13);
check("equal lambdas give symmetric win probabilities", near(sym.winA, sym.winB, 1e-12));
// Monotonicity: a stronger home side cannot lower the home win probability.
const weak = matchProb(1500, 1500, 0, { rho: -0.13, awayHomeShare: 0 });
const strong = matchProb(1700, 1500, 0, { rho: -0.13, awayHomeShare: 0 });
check("higher Elo raises the home win probability", strong.winA > weak.winA);

// ── Odds math ──────────────────────────────────────────────────────────────
const fair = evaluateDecimal1x2(2.0, 3.5, 4.0);
check("de-vigged 1X2 sums to 1", near(fair.fair.home + fair.fair.draw + fair.fair.away, 1, 1e-12));
check("overround exceeds 1 for a vigged book", fair.overround > 1);
check("margin = overround - 1", near(fair.bookmakerMargin, fair.overround - 1));
check("odds <= 1 rejected", (() => { try { evaluateDecimal1x2(1, 3, 4); return false; } catch { return true; } })());
check("NaN odds rejected", (() => { try { evaluateDecimal1x2(NaN, 3, 4); return false; } catch { return true; } })());
check("median of even-length list averages the middle pair", near(median([1, 2, 3, 4]), 2.5));
check("median ignores input order", near(median([4, 1, 3, 2]), 2.5));
check("iqr of a single value is 0", iqr([5]) === 0);

// ── Durability: corrupt stores must degrade, not wedge the app ─────────────
const settlementFile = process.env.SETTLEMENT_STORE_PATH!;
function settlement(key: string): SettlementRecord {
  return {
    snapshotUniqueKey: key,
    fixtureId: "pl-test-fixture",
    season: "2026-27",
    modelVersion: "test",
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    settledAt: "2026-08-01T12:00:00.000Z",
    actualOutcome: "home",
    actualScore: { home: 2, away: 0 },
    predicted: { home: 0.5, draw: 0.25, away: 0.25 },
    brier: 0.375,
    rps: 0.1875,
    logLoss: 0.693,
    topPickCorrect: true,
  };
}
fs.mkdirSync(path.dirname(settlementFile), { recursive: true });
persistSettlement(settlement("key-a"));
persistSettlement(settlement("key-b"));
check("two distinct settlements stored", loadSettlements().length === 2);
check("re-persisting a key is a no-op", (persistSettlement(settlement("key-a")), loadSettlements().length === 2));

// Simulate a crash mid-append: a torn final line.
fs.appendFileSync(settlementFile, '{"snapshotUniqueKey":"key-c","fixt', "utf8");
const afterTear = loadSettlements();
check("torn trailing line is skipped, not thrown", afterTear.length === 2);
check("intact rows survive a torn line", afterTear.map((r) => r.snapshotUniqueKey).join(",") === "key-a,key-b");

// A whole-file JSON document that was truncated must read as absent.
const stateFile = path.join(TMP, "ops", "tick.state.json");
writeJsonFile(stateFile, { ticks: 7 });
check("writeJsonFile round-trips", readJsonFile<{ ticks: number }>(stateFile)?.ticks === 7);
check("atomic write leaves no temp files", fs.readdirSync(path.dirname(stateFile)).every((f) => !f.endsWith(".tmp")));
fs.writeFileSync(stateFile, '{"ticks": 7', "utf8");
check("truncated JSON state reads as absent", readJsonFile(stateFile) === null);
check("missing file reads as absent", readJsonFile(path.join(TMP, "nope.json")) === null);

const jsonlFile = path.join(TMP, "ops", "rows.jsonl");
rewriteJsonl(jsonlFile, [{ a: 1 }, { a: 2 }]);
check("rewriteJsonl round-trips", readJsonl<{ a: number }>(jsonlFile).length === 2);
rewriteJsonl(jsonlFile, []);
check("rewriteJsonl of an empty list writes an empty file", fs.readFileSync(jsonlFile, "utf8") === "");
check("empty jsonl reads as an empty list", readJsonl(jsonlFile).length === 0);

// ── Ledger source modes are distinct ──────────────────────────────────────
// Each of the three sources must answer from its own store. Before the fix,
// "committed" silently fell through to the union branch and reported it under
// a committed label.
const committed = snapshotsOfClass("LIVE_OOS", "2026-27", { source: "committed" });
const index = snapshotsOfClass("LIVE_OOS", "2026-27", { source: "index" });
const union = snapshotsOfClass("LIVE_OOS", "2026-27", { source: "union" });
const tapeRows = loadCommittedLiveOos().filter((s) => s.season === "2026-27").length;
check("committed source reads the canonical tape", committed.length === tapeRows, String(tapeRows));
check("committed rows are all LIVE_OOS", committed.every((s) => s.evaluationClass === "LIVE_OOS"));
// LIVE_OOS_ARCHIVE_PATH is a write-redirect; it must NOT rewrite committed history.
check("committed view ignores the write-redirect env var", tapeRows > 0);
check("index source reads the isolated working index only", index.length === 0);
check("union source is a superset of committed", union.length >= committed.length);
const counts = ledgerCounts("2026-27");
check("ledgerCounts LIVE_OOS is the deduped union", counts.LIVE_OOS === union.length);
check("ledgerCounts splits committed vs operational", counts.liveOosCommitted + counts.liveOosOperational === counts.LIVE_OOS);
check("ledgerCounts committed matches the tape", counts.liveOosCommitted === tapeRows);

// ── Secret handling ───────────────────────────────────────────────────────
check("secretsMatch accepts an exact match", secretsMatch("s3cret", "s3cret"));
check("secretsMatch rejects a different secret", !secretsMatch("s3cret", "s3crey"));
check("secretsMatch rejects a prefix", !secretsMatch("s3c", "s3cret"));
check("secretsMatch rejects a longer candidate", !secretsMatch("s3cretX", "s3cret"));
check("secretsMatch rejects empty against non-empty", !secretsMatch("", "s3cret"));
check("secretsMatch handles multi-byte input", secretsMatch("密码-é", "密码-é"));

function req(headers: Record<string, string>, url = "http://local/api/ops/tick") {
  return { headers: new Headers(headers), url };
}
process.env.CRON_SECRET = "correct-secret";
check("bearer secret accepted", authorizeOpsTick(req({ authorization: "Bearer correct-secret" })).ok);
check("near-miss secret rejected", !authorizeOpsTick(req({ authorization: "Bearer correct-secrez" })).ok);
check("malformed authorization rejected", !authorizeOpsTick(req({ authorization: "correct-secret" })).ok);
check("malformed URL does not throw", !authorizeOpsTick(req({}, "not a url")).ok);
delete process.env.CRON_SECRET;

// ── The Gemini key must never travel in a URL ─────────────────────────────
check("gemini endpoint carries no key query param", !geminiEndpoint().includes("key="));
check("gemini endpoint is the generateContent route", geminiEndpoint().endsWith(":generateContent"));
check("gemini key is sent as a header", geminiAuthHeaders("abc123")["x-goog-api-key"] === "abc123");
check("gemini headers still declare JSON", geminiAuthHeaders("abc123")["Content-Type"] === "application/json");

// ── Numeric env reads must never yield NaN ────────────────────────────────
// A NaN TTL silently disables caching; a NaN interval becomes a tight loop.
delete process.env.FOA_TEST_NUM;
check("unset env uses the default", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "";
check("empty env uses the default", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "  ";
check("whitespace env uses the default", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "abc";
check("malformed env falls back, never NaN", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "0";
check("zero is rejected as a duration/id", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "-5";
check("negative is rejected", numberFromEnv("FOA_TEST_NUM", 42) === 42);
process.env.FOA_TEST_NUM = "1500";
check("valid env value is honoured", numberFromEnv("FOA_TEST_NUM", 42) === 1500);
process.env.FOA_TEST_NUM = "2.5";
check("integerFromEnv rejects a fraction", integerFromEnv("FOA_TEST_NUM", 7) === 7);
process.env.FOA_TEST_NUM = "9";
check("integerFromEnv accepts a whole number", integerFromEnv("FOA_TEST_NUM", 7) === 9);
process.env.FOA_TEST_NUM = "1";
check(
  "sub-floor duration is clamped up, not left as a hot loop",
  durationMsFromEnv("FOA_TEST_NUM", 300_000, { min: 60_000, max: 3_600_000 }) === 60_000
);
process.env.FOA_TEST_NUM = "99999999";
check(
  "over-ceiling duration is clamped down",
  durationMsFromEnv("FOA_TEST_NUM", 300_000, { min: 60_000, max: 3_600_000 }) === 3_600_000
);
process.env.FOA_TEST_NUM = "nonsense";
check(
  "malformed duration falls back inside the band",
  durationMsFromEnv("FOA_TEST_NUM", 300_000, { min: 60_000, max: 3_600_000 }) === 300_000
);
delete process.env.FOA_TEST_NUM;

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nHardening gates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
