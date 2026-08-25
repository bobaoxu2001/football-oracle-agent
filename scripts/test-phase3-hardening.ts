import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GET as recentPredictions } from "../app/api/predictions/recent/route";
import {
  aiRequestFingerprint,
  anonymousRateLimitKey,
  requestBodyTooLarge,
  readBoundedJson,
  RequestBodyTooLargeError,
  resetMatchAgentRateLimitsForTests,
  runAiRequestDeduplicated,
  takePublicAiRateLimit,
} from "../lib/match-forecast/rate-limit";
import { replaceNewsBatchSafely } from "../lib/news/teamNewsStore";
import { seasonStatusAt } from "../lib/competitions/premier-league/season-status";
import { getMatchIntelligence, upcomingMatchForecasts } from "../lib/match-forecast/service";

let passed = 0;
async function check(name: string, test: () => void | Promise<void>) {
  await test();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
await check("public recent-predictions route returns no raw sessions", async () => {
  const response = await recentPredictions();
  const body = await response.json();
  assert.deepEqual(body.items, []);
  assert.equal(body.visibility, "private");
  assert.equal(JSON.stringify(body).includes("userQuery"), false);
});

await check("memory page does not enumerate getRecentPredictions", () => {
  const source = fs.readFileSync(path.resolve("app/memory/page.tsx"), "utf8");
  assert.equal(source.includes("getRecentPredictions"), false);
  assert.equal(source.includes("RecentPredictions"), false);
});

await check("rate-limit identity hashes raw network identifiers", () => {
  const raw = "203.0.113.42";
  const key = anonymousRateLimitKey(raw);
  assert.equal(key.includes(raw), false);
  assert.equal(key.length, 24);
});

await check("paid-route limiter blocks over its scoped ceiling", () => {
  resetMatchAgentRateLimitsForTests();
  const key = anonymousRateLimitKey("test");
  assert.equal(takePublicAiRateLimit("paid", key, 1_000, 2).allowed, true);
  assert.equal(takePublicAiRateLimit("paid", key, 1_001, 2).allowed, true);
  assert.equal(takePublicAiRateLimit("paid", key, 1_002, 2).allowed, false);
});

await check("identical paid requests are coalesced", async () => {
  resetMatchAgentRateLimitsForTests();
  let calls = 0;
  const fingerprint = aiRequestFingerprint("test", { query: "same" });
  const task = () => runAiRequestDeduplicated(fingerprint, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true };
  });
  const [a, b] = await Promise.all([task(), task()]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: true });
  assert.equal(calls, 1);
});

await check("oversized JSON request is rejected before parsing", () => {
  const request = new Request("http://local/api", { method: "POST", headers: { "content-length": "5000" } });
  assert.equal(requestBodyTooLarge(request), true);
});

await check("chunked oversized JSON is rejected by actual bytes", async () => {
  const request = new Request("http://local/api", { method: "POST", body: JSON.stringify({ query: "x".repeat(5000) }) });
  await assert.rejects(() => readBoundedJson(request), RequestBodyTooLargeError);
});

await check("failed news staging preserves the last-known-good pointer", async () => {
  let active = "old-batch";
  let cleaned = false;
  await assert.rejects(() => replaceNewsBatchSafely({
    stage: async () => { throw new Error("injected insertMany failure"); },
    activate: async () => { active = "new-batch"; },
    discardStage: async () => undefined,
    cleanupOld: async () => { cleaned = true; },
  }));
  assert.equal(active, "old-batch");
  assert.equal(cleaned, false);
});

await check("successful news refresh activates only after staging", async () => {
  const order: string[] = [];
  await replaceNewsBatchSafely({
    stage: async () => { order.push("stage"); },
    activate: async () => { order.push("activate"); },
    discardStage: async () => { order.push("discard"); },
    cleanupOld: async () => { order.push("cleanup"); },
  });
  assert.deepEqual(order, ["stage", "activate", "cleanup"]);
});

await check("season status follows the season calendar", () => {
  const season = { startDate: "2026-08-21", endDate: "2027-05-30" };
  assert.equal(seasonStatusAt(season, new Date("2026-08-20T12:00:00Z")), "upcoming");
  assert.equal(seasonStatusAt(season, new Date("2026-08-25T12:00:00Z")), "in_progress");
  assert.equal(seasonStatusAt(season, new Date("2027-06-01T12:00:00Z")), "completed");
});

await check("homepage list is backend-produced production data", () => {
  const cards = upcomingMatchForecasts(8, new Date("2026-08-25T00:00:00Z"));
  assert.ok(cards.length > 0);
  assert.ok(cards.every((card) => card.forecast.modelRole === "production"));
  assert.ok(cards.every((card) => card.forecast.modelVersion === "pl-live-v0.2.0"));
});

await check("Arsenal-Chelsea Match Room acceptance values come from backend", async () => {
  const data = await getMatchIntelligence("pl-2026-27-arsenal-chelsea", new Date("2026-08-25T00:00:00Z"));
  assert.ok(Math.abs(data.forecast.result.homeWin - 0.6134875203) < 1e-8);
  assert.ok(Math.abs(data.forecast.result.draw - 0.2236346278) < 1e-8);
  assert.ok(Math.abs(data.forecast.result.awayWin - 0.1628778518) < 1e-8);
  assert.equal(data.timeline.length, 1);
  assert.equal(data.comparison, null);
});

console.log(`\nPhase 3 hardening: ${passed} passed, 0 failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
