/**
 * Season-aware honesty layer.
 *
 * Text is generated from CompetitionSeason + the data gate. A new season
 * must not require another hardcoded year in this file.
 */

import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { evaluateDataGate } from "./data-gate";
import { liveCompetitionSeason } from "./fixture-store";

export function currentHonestyText(now = new Date()): string {
  const gate = evaluateDataGate(now);
  const season = liveCompetitionSeason();
  const label = season?.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const source = season?.source ?? "none";
  const dataStatus = gate.status;
  const fixtureStatus = season
    ? `${season.scheduleCompleteness} schedule · ${season.verificationStatus}`
    : "no official fixtures loaded";

  if (gate.status === "DATA_BLOCKED") {
    return (
      `${label} official fixtures and the finalized promoted/relegated club set have not yet been loaded into this model ` +
      `(data status ${dataStatus}; fixture source ${fixtureStatus}). ` +
      `This is a temporary preseason baseline generated from the previous season's club/rating state and should not be treated as a live ${label} forecast.`
    );
  }

  if (gate.status === "DATA_DEGRADED") {
    return (
      `${label} data is degraded (${gate.reasons.join("; ") || fixtureStatus}). ` +
      `Source: ${source}, retrieved ${season?.retrievedAt ?? "unknown"}. ` +
      `Forecasts use the league-strength baseline only and should be treated with extra caution.`
    );
  }

  return (
    `${label} official membership and fixtures are loaded ` +
    `(${gate.clubCount} clubs, ${gate.fixtureCount} fixtures, source ${source}, ${fixtureStatus}). ` +
    `Forecast based on the current league-strength baseline, home advantage, season-transition priors and Dixon-Coles score model. ` +
    `This forecast does not use market odds, injuries, lineups, transfer valuations, or shot-based xG.`
  );
}

/**
 * Blocked-state template. Season year is intentionally omitted so a new
 * season does not require a code change. Prefer currentHonestyText().
 */
export const PRESEASON_BASELINE_CAVEAT =
  "official fixtures and the finalized promoted/relegated club set have not yet been loaded into this model. This is a temporary preseason baseline generated from the previous season's club/rating state and should not be treated as a live forecast.";

export function hasOfficialCurrentSeasonFixtures(): boolean {
  const gate = evaluateDataGate();
  return gate.fixtureCount > 0 && gate.status !== "DATA_BLOCKED";
}

export function isPreseasonBaseline(): boolean {
  return evaluateDataGate().status === "DATA_BLOCKED";
}

export function currentSeasonDisclaimer(): string | null {
  const gate = evaluateDataGate();
  if (gate.status === "DATA_READY") return null;
  return currentHonestyText();
}

export function modelInputHonesty(): string {
  return (
    "Inputs in use: walk-forward club Elo, true home advantage, Dixon-Coles low-score correction, " +
    "and explicit offseason / promotion priors. Not in use: bookmaker odds, injuries, starting XIs, " +
    "transfer fees, tactical databases, or shot-based xG."
  );
}
