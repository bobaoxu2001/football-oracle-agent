/** Phase 4B fail-closed scenario service and HTTP boundary gates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-phase4b-scenario-"));
process.env.PL_OPS_BACKEND = "file";
process.env.PL_OPS_DIR = path.join(TEMP, "ops");
process.env.SNAPSHOT_STORE_PATH = path.join(TEMP, "working-snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TEMP, "live-oos-archive.jsonl");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TEMP, "live-oos-operational.jsonl");
process.env.PL_CONTEXT_SNAPSHOT_PATH = path.join(TEMP, "match-context-snapshots.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TEMP, "settlements.jsonl");
delete process.env.MONGODB_URI;
delete process.env.MONGODB_DB;

import { POST as scenarioPost } from "@/app/api/matches/[matchId]/scenario/route";
import { resetDurableMetaForTests } from "@/lib/competitions/premier-league/ops/durable-store";
import {
  MatchScenarioBoundaryError,
  runMatchScenario,
} from "@/lib/match-forecast/scenario";
import { resetMatchAgentRateLimitsForTests } from "@/lib/match-forecast/rate-limit";
import { latestMatchForecast } from "@/lib/match-forecast/service";
import type { MatchForecast } from "@/lib/match-forecast/types";
import { resetSnapshotCache } from "@/lib/snapshots/store";

const MATCH_ID = "pl-2026-27-arsenal-chelsea";
const PROJECT = process.cwd();
const GUARDED_FILES = [
  path.join(PROJECT, "data/processed/premier-league/live-oos-2026-27.jsonl"),
  path.join(PROJECT, "data/processed/premier-league/ops/live-oos-operational.jsonl"),
  path.join(PROJECT, "data/processed/premier-league/ops/match-context-snapshots.jsonl"),
  path.join(PROJECT, "data/processed/predictions/snapshots.jsonl"),
] as const;
const REDIRECTED_STORES = [
  process.env.SNAPSHOT_STORE_PATH!,
  process.env.LIVE_OOS_ARCHIVE_PATH!,
  process.env.PL_OPERATIONAL_LIVE_OOS_PATH!,
  process.env.PL_CONTEXT_SNAPSHOT_PATH!,
] as const;

interface FileIdentity {
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

function fileIdentity(file: string): FileIdentity {
  if (!fs.existsSync(file)) return { exists: false, bytes: 0, sha256: null };
  const bytes = fs.readFileSync(file);
  return {
    exists: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fileIdentities(files: readonly string[]): Record<string, FileIdentity> {
  return Object.fromEntries(files.map((file) => [file, fileIdentity(file)]));
}

function numericLeaves(value: unknown, pathParts: string[] = []): string[] {
  if (typeof value === "number") return [pathParts.join(".") || "<root>"];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => numericLeaves(item, [...pathParts, String(index)]));
  }
  return Object.entries(value).flatMap(([key, child]) =>
    numericLeaves(child, [...pathParts, key])
  );
}

function jsonRequest(
  body: unknown,
  ip: string,
  contentType = "application/json"
): Request {
  return new Request(`http://local/api/matches/${MATCH_ID}/scenario`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-forwarded-for": ip,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(
  request: Request,
  matchId = MATCH_ID
): Promise<Response> {
  return scenarioPost(request, { params: Promise.resolve({ matchId }) });
}

function scenarioError(code: MatchScenarioBoundaryError["code"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof MatchScenarioBoundaryError && error.code === code;
}

async function main(): Promise<void> {
  const guardedBefore = fileIdentities(GUARDED_FILES);
  const redirectedBefore = fileIdentities(REDIRECTED_STORES);
  resetSnapshotCache();
  resetDurableMetaForTests();
  resetMatchAgentRateLimitsForTests();

  const baseline = await latestMatchForecast(MATCH_ID);
  const baselineBytes = JSON.stringify(baseline);
  const valid = runMatchScenario({
    baseline,
    matchId: MATCH_ID,
    forecastId: baseline.provenance.immutableForecastId,
    override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
  });
  assert.equal(valid.supported, false);
  assert.equal(valid.status, "UNSUPPORTED_SCENARIO");
  assert.equal(valid.baselineForecastId, baseline.provenance.immutableForecastId);
  assert.equal(valid.persisted, false);
  assert.equal(valid.evaluationClass, null);
  assert.deepEqual(numericLeaves(valid), [], "unsupported result must contain no numeric output");
  assert.deepEqual(valid.scenario, { type: "PLAYER_UNAVAILABLE", playerId: "saka" });
  assert.equal(Object.isFrozen(valid), true);
  assert.equal(Object.isFrozen(valid.scenario), true);
  assert.equal(JSON.stringify(baseline), baselineBytes, "scenario evaluation must not mutate baseline");

  assert.throws(
    () => runMatchScenario({
      baseline,
      matchId: MATCH_ID,
      forecastId: `${baseline.provenance.immutableForecastId}-other`,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    }),
    scenarioError("FORECAST_MISMATCH")
  );
  assert.throws(
    () => runMatchScenario({
      baseline,
      matchId: "another-match",
      forecastId: baseline.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    }),
    scenarioError("INVALID_BASELINE")
  );

  const invalidProbability = structuredClone(baseline);
  invalidProbability.result.homeWin = 1.5;
  assert.throws(
    () => runMatchScenario({
      baseline: invalidProbability,
      matchId: MATCH_ID,
      forecastId: invalidProbability.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    }),
    scenarioError("INVALID_BASELINE")
  );
  const invalidProvenance = structuredClone(baseline) as MatchForecast;
  (invalidProvenance.provenance as unknown as { evaluationClass: string }).evaluationClass = "SHADOW";
  assert.throws(
    () => runMatchScenario({
      baseline: invalidProvenance,
      matchId: MATCH_ID,
      forecastId: invalidProvenance.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    }),
    scenarioError("INVALID_BASELINE")
  );
  assert.throws(
    () => runMatchScenario({
      baseline,
      matchId: MATCH_ID,
      forecastId: baseline.provenance.immutableForecastId,
      override: {
        type: "PLAYER_UNAVAILABLE",
        playerId: "saka",
        probability: 0.99,
      } as unknown as { type: string; playerId: string },
    }),
    scenarioError("INVALID_OVERRIDE")
  );

  resetMatchAgentRateLimitsForTests();
  const validResponse = await post(jsonRequest(
    {
      forecastId: baseline.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    },
    "198.51.100.41"
  ));
  assert.equal(validResponse.status, 422);
  assert.match(validResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(validResponse.headers.get("x-ratelimit-limit"), "12");
  assert.equal(validResponse.headers.get("x-ratelimit-remaining"), "11");
  assert.equal(validResponse.headers.get("x-forwarded-for"), null);
  const validJson = await validResponse.json();
  assert.equal(validJson.status, "UNSUPPORTED_SCENARIO");
  assert.equal(validJson.persisted, false);
  assert.deepEqual(numericLeaves(validJson), []);
  assert.equal(JSON.stringify(validJson).includes("198.51.100.41"), false);

  const mismatchResponse = await post(jsonRequest(
    {
      forecastId: `${baseline.provenance.immutableForecastId}-stale`,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    },
    "198.51.100.42"
  ));
  assert.equal(mismatchResponse.status, 409);
  assert.equal((await mismatchResponse.json()).error, "FORECAST_MISMATCH");
  assert.match(mismatchResponse.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(mismatchResponse.headers.get("x-ratelimit-remaining"), "11");

  const invalidCases: Array<{ body: unknown; expectedError: string }> = [
    { body: null, expectedError: "INVALID_REQUEST" },
    {
      body: {
        forecastId: baseline.provenance.immutableForecastId,
        override: { type: "PLAYER_UNAVAILABLE", playerId: "saka", probability: 0.9 },
      },
      expectedError: "INVALID_SCENARIO",
    },
    {
      body: {
        forecastId: baseline.provenance.immutableForecastId,
        override: { type: " player unavailable ", playerId: "saka" },
      },
      expectedError: "INVALID_SCENARIO",
    },
    {
      body: {
        forecastId: baseline.provenance.immutableForecastId,
        override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
        probability: 0.9,
      },
      expectedError: "INVALID_REQUEST",
    },
  ];
  for (let index = 0; index < invalidCases.length; index += 1) {
    const item = invalidCases[index];
    const response = await post(jsonRequest(item.body, `198.51.100.${50 + index}`));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, item.expectedError);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-ratelimit-limit"), "12");
  }

  const invalidJson = await post(jsonRequest("{", "198.51.100.60"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error, "INVALID_JSON");
  assert.match(invalidJson.headers.get("cache-control") ?? "", /no-store/);

  const wrongMedia = await post(jsonRequest(
    {
      forecastId: baseline.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    },
    "198.51.100.61",
    "text/plain"
  ));
  assert.equal(wrongMedia.status, 415);
  assert.equal((await wrongMedia.json()).error, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(wrongMedia.headers.get("x-ratelimit-remaining"), "11");

  const oversized = await post(new Request(`http://local/api/matches/${MATCH_ID}/scenario`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "5000",
      "x-forwarded-for": "198.51.100.62",
    },
    body: "{}",
  }));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, "REQUEST_TOO_LARGE");
  assert.match(oversized.headers.get("cache-control") ?? "", /no-store/);

  const unknown = await post(jsonRequest(
    {
      forecastId: baseline.provenance.immutableForecastId,
      override: { type: "PLAYER_UNAVAILABLE", playerId: "saka" },
    },
    "198.51.100.63"
  ), "unknown-match");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, "UNKNOWN_MATCH");
  assert.match(unknown.headers.get("cache-control") ?? "", /no-store/);

  resetMatchAgentRateLimitsForTests();
  let rateLimited: Response | null = null;
  for (let index = 0; index < 13; index += 1) {
    rateLimited = await post(jsonRequest({}, "198.51.100.70"));
  }
  assert.ok(rateLimited);
  assert.equal(rateLimited.status, 429);
  assert.equal((await rateLimited.json()).error, "RATE_LIMITED");
  assert.equal(rateLimited.headers.get("x-ratelimit-limit"), "12");
  assert.equal(rateLimited.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(Number(rateLimited.headers.get("retry-after")) >= 1);
  assert.match(rateLimited.headers.get("cache-control") ?? "", /no-store/);

  assert.equal(JSON.stringify(baseline), baselineBytes, "HTTP boundary must not mutate baseline");
  assert.deepEqual(fileIdentities(GUARDED_FILES), guardedBefore, "project evidence stores changed");
  assert.deepEqual(fileIdentities(REDIRECTED_STORES), redirectedBefore, "redirected stores changed");
  assert.equal(
    REDIRECTED_STORES.every((file) => !fs.existsSync(file)),
    true,
    "scenario boundary must not create any redirected store"
  );

  console.log("Phase 4B scenario boundary tests passed");
}

void main();
