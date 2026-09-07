/**
 * Live API-Football PL context probe.
 * Refuses the network when API_FOOTBALL_KEY is missing. Never prints secrets.
 */
import {
  API_FOOTBALL_EPL_LEAGUE_ID,
  API_FOOTBALL_ENV_NAME,
  apiFootballAuthorizationState,
  refuseLiveApiFootballProbe,
} from "@/lib/competitions/premier-league/intelligence/provider-gate";

function main(): void {
  const state = apiFootballAuthorizationState();
  console.log(
    JSON.stringify({
      authorizationState: state,
      envName: API_FOOTBALL_ENV_NAME,
      configuredLeagueId: API_FOOTBALL_EPL_LEAGUE_ID,
      liveProbe: state === "AUTHORIZED" ? "eligible" : "refused",
    })
  );
  if (state !== "AUTHORIZED") {
    try {
      refuseLiveApiFootballProbe();
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
  }
  console.error("Live schema probe is not implemented until authorization is confirmed in a dedicated run.");
  process.exit(2);
}

main();
