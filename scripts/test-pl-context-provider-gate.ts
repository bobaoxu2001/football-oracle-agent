/**
 * API-Football PL context provider gate.
 * No live schema is assumed. Missing keys must refuse the probe.
 */
import assert from "node:assert/strict";
import { WORLD_CUP_CONFIG } from "@/lib/competitions/world-cup/config";
import { PREMIER_LEAGUE_CONFIG } from "@/lib/competitions/premier-league/config";
import { officialFixtureId } from "@/lib/competitions/premier-league/ingest";
import { redactCredentialText } from "@/lib/competitions/premier-league/ops/secrets";
import {
  API_FOOTBALL_AUTH_HEADER,
  API_FOOTBALL_BASE_URL,
  API_FOOTBALL_EPL_LEAGUE_ID,
  AVAILABLE_AT_POLICY,
  ProviderProbeBlockedError,
  apiFootballAuthorizationState,
  firstObservedAvailableAt,
  mapProviderFixtureToCanonical,
  refuseLiveApiFootballProbe,
} from "@/lib/competitions/premier-league/intelligence/provider-gate";
import { getMatchIntelligence } from "@/lib/match-forecast/service";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
  const previous = process.env.API_FOOTBALL_KEY;
  delete process.env.API_FOOTBALL_KEY;

  await check("authorization is NONE_CONFIGURED without a key", () => {
    assert.equal(apiFootballAuthorizationState(), "NONE_CONFIGURED");
  });

  await check("live probe refuses the network without a key", () => {
    assert.throws(() => refuseLiveApiFootballProbe(), (error: unknown) => {
      return error instanceof ProviderProbeBlockedError && error.code === "BLOCKED_PENDING_API_FOOTBALL_AUTHORIZATION";
    });
  });

  await check("World Cup adapter league is not the EPL id", () => {
    assert.equal(WORLD_CUP_CONFIG.apiFootballLeagueId, 1);
    assert.equal(PREMIER_LEAGUE_CONFIG.apiFootballLeagueId, 39);
    assert.equal(API_FOOTBALL_EPL_LEAGUE_ID, 39);
    assert.notEqual(WORLD_CUP_CONFIG.apiFootballLeagueId, API_FOOTBALL_EPL_LEAGUE_ID);
  });

  await check("auth contract is header-based, not a query secret", () => {
    assert.equal(API_FOOTBALL_AUTH_HEADER, "x-apisports-key");
    assert.equal(API_FOOTBALL_BASE_URL, "https://v3.football.api-sports.io");
  });

  const teamIds = new Map<number, string>([
    [42, "arsenal"],
    [49, "chelsea"],
  ]);

  await check("provider identity uses team ids and distinguishes reverse fixtures", () => {
    const forward = mapProviderFixtureToCanonical({
      providerLeagueId: 39,
      season: "2026-27",
      providerHomeTeamId: 42,
      providerAwayTeamId: 49,
      kickoffUtc: "2026-09-06T15:30:00.000Z",
      teamIdToSlug: teamIds,
    });
    const reverse = mapProviderFixtureToCanonical({
      providerLeagueId: 39,
      season: "2026-27",
      providerHomeTeamId: 49,
      providerAwayTeamId: 42,
      kickoffUtc: "2027-03-13T15:00:00.000Z",
      teamIdToSlug: teamIds,
    });
    assert.equal(forward.ok, true);
    assert.equal(reverse.ok, true);
    if (forward.ok && reverse.ok) {
      assert.equal(forward.fixtureId, officialFixtureId("arsenal", "chelsea"));
      assert.equal(reverse.fixtureId, officialFixtureId("chelsea", "arsenal"));
      assert.notEqual(forward.fixtureId, reverse.fixtureId);
    }
  });

  await check("unmapped provider team id fails closed", () => {
    const mapped = mapProviderFixtureToCanonical({
      providerLeagueId: 39,
      season: "2026-27",
      providerHomeTeamId: 42,
      providerAwayTeamId: 999999,
      kickoffUtc: "2026-09-06T15:30:00.000Z",
      teamIdToSlug: teamIds,
    });
    assert.equal(mapped.ok, false);
    if (!mapped.ok) assert.equal(mapped.reason, "unmapped_team_id");
  });

  await check("wrong league id fails closed", () => {
    const mapped = mapProviderFixtureToCanonical({
      providerLeagueId: 1,
      season: "2026-27",
      providerHomeTeamId: 42,
      providerAwayTeamId: 49,
      kickoffUtc: "2026-09-06T15:30:00.000Z",
      teamIdToSlug: teamIds,
    });
    assert.equal(mapped.ok, false);
    if (!mapped.ok) assert.equal(mapped.reason, "league_mismatch");
  });

  await check("availableAt fallback is firstObservedAt, not kickoff", () => {
    assert.equal(firstObservedAvailableAt("2026-09-05T12:00:00.000Z"), "2026-09-05T12:00:00.000Z");
    assert.ok(AVAILABLE_AT_POLICY.forbiddenAsAvailableAt.includes("kickoff"));
    assert.ok(AVAILABLE_AT_POLICY.forbiddenAsAvailableAt.includes("todayProviderLatestStateBackfill"));
  });

  await check("API_FOOTBALL_KEY is redacted from diagnostics", () => {
    const key = "test-api-football-key-SHOULD-NOT-LEAK";
    process.env.API_FOOTBALL_KEY = key;
    const redacted = redactCredentialText(
      `api-football request failed: https://v3.football.api-sports.io/injuries?league=39&x-apisports-key=${key} body=${key}`
    );
    assert.equal(redacted.includes(key), false);
    delete process.env.API_FOOTBALL_KEY;
  });

  await check("short invalid keys are not treated as authorized", () => {
    process.env.API_FOOTBALL_KEY = "short";
    assert.equal(apiFootballAuthorizationState(), "INVALID");
    delete process.env.API_FOOTBALL_KEY;
  });

  await check("provider refusal does not change frozen champion 1X2", async () => {
    assert.throws(() => refuseLiveApiFootballProbe(), ProviderProbeBlockedError);
    const data = await getMatchIntelligence("pl-2026-27-arsenal-chelsea", new Date("2026-08-25T00:00:00Z"));
    assert.equal(data.forecast.modelVersion, PRODUCTION_MODEL_VERSION);
    assert.ok(Math.abs(data.forecast.result.homeWin - 0.6134875203) < 1e-8);
    assert.ok(Math.abs(data.forecast.result.draw - 0.2236346278) < 1e-8);
    assert.ok(Math.abs(data.forecast.result.awayWin - 0.1628778518) < 1e-8);
    assert.equal(data.matchIntelligence.sourceAuthorization, "NONE_CONFIGURED");
    assert.equal(data.matchIntelligence.includedInChampionProbability, false);
    assert.equal(data.audit.contextEvidenceCounts.usedInForecast, 0);
  });

  if (previous) process.env.API_FOOTBALL_KEY = previous;
  else delete process.env.API_FOOTBALL_KEY;

  console.log(`\nPL context provider gate: ${passed} passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
