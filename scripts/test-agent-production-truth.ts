/**
 * Legacy public agent must copy frozen Premier League LIVE_OOS forecasts.
 * It must never mint ad-hoc production probabilities.
 */
import fs from "node:fs";
import path from "node:path";

process.env.MATCH_AGENT_LLM_ENABLED = "0";

import { runAgent } from "@/lib/agent";
import { POST as predictPost } from "@/app/api/agent/predict/route";
import { latestMatchForecast, MatchForecastError, resolvePremierLeagueFixtureByClubs } from "@/lib/match-forecast/service";
import { predictPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import {
  coreTickUrl,
  fireOpsCadence,
  observersUrl,
} from "./ops-scheduler-worker";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance;
}

async function predictJson(query: string, forwardedFor: string) {
  const response = await predictPost(
    new Request("http://local/api/agent/predict", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ query }),
    })
  );
  return { status: response.status, body: await response.json() };
}

async function main() {
  console.log("\n── Frozen production match path ───────────────────────────────────");
  const now = new Date("2026-09-03T12:00:00.000Z");
  const fixture = resolvePremierLeagueFixtureByClubs("arsenal", "chelsea", now);
  const frozen = await latestMatchForecast(fixture.id, now);
  const agent = await runAgent({
    query: "Who wins Arsenal vs Chelsea?",
    persist: false,
    now,
  });

  check("Arsenal vs Chelsea resolves the official home/away fixture", fixture.id === "pl-2026-27-arsenal-chelsea");
  check("agent serves match-prediction", agent.intent === "match-prediction" && !agent.productionRefusal);
  check("agent copies frozen home win", near(agent.prediction?.teamAWin ?? -1, frozen.result.homeWin));
  check("agent copies frozen draw", near(agent.prediction?.draw ?? -1, frozen.result.draw));
  check("agent copies frozen away win", near(agent.prediction?.teamBWin ?? -1, frozen.result.awayWin));
  check("agent names official home as teamA", agent.prediction?.teamA.slug === "arsenal");
  check("agent names official away as teamB", agent.prediction?.teamB.slug === "chelsea");
  check(
    "agent forecast identity matches Match Room",
    agent.productionForecast?.forecastId === frozen.provenance.immutableForecastId &&
      agent.productionForecast?.cutoffAt === frozen.cutoffAt &&
      agent.productionForecast?.matchId === frozen.matchId
  );

  const inverted = await runAgent({
    query: "Who wins Chelsea vs Arsenal?",
    persist: false,
    now,
  });
  check(
    "query order cannot invert home/away probabilities",
    inverted.prediction?.teamA.slug === "arsenal" &&
      inverted.prediction?.teamB.slug === "chelsea" &&
      near(inverted.prediction?.teamAWin ?? -1, frozen.result.homeWin) &&
      near(inverted.prediction?.teamBWin ?? -1, frozen.result.awayWin)
  );
  check(
    "inverted query still uses the same frozen forecast",
    inverted.productionForecast?.forecastId === frozen.provenance.immutableForecastId
  );

  console.log("\n── Missing frozen production data fails closed ────────────────────");
  const missing = await runAgent({
    query: "Who wins Arsenal vs Luton?",
    persist: false,
    now,
  });
  check("non-season pairing is refused", Boolean(missing.productionRefusal));
  check("missing fixture has no prediction numbers", missing.prediction === undefined);
  check("missing fixture has no champions board", missing.champions === undefined);
  check("missing fixture code is UNKNOWN_MATCH", missing.productionRefusal?.code === "UNKNOWN_MATCH");

  let unknownThrew = false;
  try {
    await latestMatchForecast("pl-does-not-exist", now);
  } catch (error) {
    unknownThrew = error instanceof MatchForecastError && error.code === "UNKNOWN_MATCH";
  }
  check("canonical reader fails closed for an unknown match id", unknownThrew);

  console.log("\n── No ad-hoc Premier League prediction path ───────────────────────");
  const agentSource = fs.readFileSync(path.resolve("lib/agent/index.ts"), "utf8");
  check("legacy agent does not import predictPremierLeagueMatch", !agentSource.includes("predictPremierLeagueMatch"));
  check("legacy agent does not import simulateLeagueSeason", !agentSource.includes("simulateLeagueSeason"));
  check("legacy agent does not import ratingsAsOf", !agentSource.includes("ratingsAsOf"));
  check("legacy agent does not import remainingPremierLeagueFixtures", !agentSource.includes("remainingPremierLeagueFixtures"));

  const liveNow = predictPremierLeagueMatch("arsenal", "chelsea", {
    asOf: now.toISOString(),
    kickoff: fixture.kickoffUtc ?? undefined,
    fixtureId: fixture.id,
  });
  const liveDisagrees =
    !near(liveNow.teamAWinProbability, frozen.result.homeWin, 1e-6) ||
    !near(liveNow.drawProbability, frozen.result.draw, 1e-6) ||
    !near(liveNow.teamBWinProbability, frozen.result.awayWin, 1e-6);
  check(
    "agent still matches frozen forecast even if a live recompute would differ",
    near(agent.prediction?.teamAWin ?? -1, frozen.result.homeWin)
  );
  if (liveDisagrees) {
    check(
      "agent does not equal a live as-of-now recompute",
      !near(agent.prediction?.teamAWin ?? -1, liveNow.teamAWinProbability, 1e-6)
    );
  }

  console.log("\n── Historical fixture cannot consume later model state ────────────");
  const historicalNow = new Date("2026-08-20T12:00:00.000Z");
  const historicalFixture = resolvePremierLeagueFixtureByClubs("arsenal", "coventry", historicalNow);
  const historicalFrozen = await latestMatchForecast(historicalFixture.id, historicalNow);
  const historicalAgent = await runAgent({
    query: "Who wins Arsenal vs Coventry?",
    persist: false,
    now: historicalNow,
  });
  const laterLive = predictPremierLeagueMatch("arsenal", "coventry", {
    asOf: "2026-09-02T12:00:00.000Z",
    kickoff: historicalFixture.kickoffUtc ?? undefined,
    fixtureId: historicalFixture.id,
  });
  check("historical query selects the then-next official fixture", historicalFixture.id === "pl-2026-27-arsenal-coventry");
  check(
    "historical agent copies the frozen snapshot, not later ratings",
    near(historicalAgent.prediction?.teamAWin ?? -1, historicalFrozen.result.homeWin) &&
      historicalAgent.productionForecast?.forecastId === historicalFrozen.provenance.immutableForecastId
  );
  check(
    "historical frozen cutoff is before kickoff",
    Date.parse(historicalFrozen.cutoffAt) < Date.parse(historicalFrozen.kickoffUtc)
  );
  if (!near(laterLive.teamAWinProbability, historicalFrozen.result.homeWin, 1e-6)) {
    check(
      "historical agent does not equal a later live recompute",
      !near(historicalAgent.prediction?.teamAWin ?? -1, laterLive.teamAWinProbability, 1e-6)
    );
  }

  console.log("\n── Title-odds Premier League path is refused ──────────────────────");
  const title = await runAgent({
    query: "Who is most likely to win the Premier League?",
    persist: false,
    now,
  });
  check("PL title is refused", title.productionRefusal?.code === "UNSUPPORTED_PRODUCTION_QUESTION");
  check("PL title has no champion probabilities", title.champions === undefined);
  check("PL title has no match probabilities", title.prediction === undefined);
  check("PL title does not mint synthetic percentages", !/\d+\.\d+% title/.test(title.explanation));

  const scenario = await runAgent({
    query: "What if Saka is unavailable for Arsenal vs Chelsea?",
    persist: false,
    now,
  });
  check(
    "PL scenario is refused rather than recomputed",
    scenario.productionRefusal?.code === "UNSUPPORTED_PRODUCTION_QUESTION" &&
      scenario.prediction === undefined
  );

  console.log("\n── Public API contract ────────────────────────────────────────────");
  const apiMatch = await predictJson("Who wins Arsenal vs Chelsea?", "198.51.100.21");
  check("match API is 200", apiMatch.status === 200);
  check(
    "match API copies frozen home win",
    near(apiMatch.body.prediction?.teamAWin ?? -1, frozen.result.homeWin)
  );
  const apiTitle = await predictJson("Who is most likely to win the Premier League?", "198.51.100.22");
  check("title API fails closed", apiTitle.status === 409);
  check("title API error is explicit", apiTitle.body.error === "UNSUPPORTED_PRODUCTION_QUESTION");
  check("title API has no champions", apiTitle.body.champions === undefined);
  const apiMissing = await predictJson("Who wins Arsenal vs Luton?", "198.51.100.23");
  check("missing fixture API is 404", apiMissing.status === 404);
  check("missing fixture API has no prediction", apiMissing.body.prediction === undefined);

  const wc = await runAgent({ query: "Who will win Argentina vs France?", persist: false });
  check("World Cup research match path remains available", Boolean(wc.prediction) && !wc.productionRefusal);

  console.log("\n── Scheduler worker core/observer split ───────────────────────────");
  const core = coreTickUrl("https://example.invalid/api/ops/tick");
  check("worker core URL sets core=1", core === "https://example.invalid/api/ops/tick?core=1");
  check(
    "worker observers URL is a separate path",
    observersUrl("https://example.invalid/api/ops/tick") === "https://example.invalid/api/ops/observers"
  );
  check(
    "explicit observer URL wins",
    observersUrl("https://example.invalid/api/ops/tick", "https://example.invalid/api/ops/observers") ===
      "https://example.invalid/api/ops/observers"
  );
  const calls: string[] = [];
  await fireOpsCadence({
    tickUrl: "https://example.invalid/api/ops/tick",
    secret: "test-secret",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer test-secret") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  check("worker fires core then observers", calls.length === 2);
  check("first request is core tick", calls[0] === "GET https://example.invalid/api/ops/tick?core=1");
  check("second request is observers", calls[1] === "GET https://example.invalid/api/ops/observers");
  check("worker never puts observers on the 60s tick URL", !calls[0].includes("observers"));

  if (failures) {
    console.error(`\n${failures} agent production-truth check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll agent production-truth checks passed.");
}

void main();
