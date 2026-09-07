/**
 * API-Football provider authorization gate for Premier League Match Intelligence.
 *
 * This module does not fetch live data. A missing key must refuse the probe
 * rather than invent lineup/injury schemas. The World Cup client in
 * lib/live-sports/apiFootball.ts is not reused: it defaults to league 1 and
 * maps national-team names.
 */

import { officialFixtureId } from "@/lib/competitions/premier-league/ingest";
import { PREMIER_LEAGUE_CONFIG, PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

export const API_FOOTBALL_PROVIDER = "api-football";
export const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
export const API_FOOTBALL_AUTH_HEADER = "x-apisports-key";
export const API_FOOTBALL_ENV_NAME = "API_FOOTBALL_KEY";
export const API_FOOTBALL_EPL_LEAGUE_ID = PREMIER_LEAGUE_CONFIG.apiFootballLeagueId;
export const API_FOOTBALL_TARGET_SEASON_YEAR = Number(PREMIER_LEAGUE_CURRENT_SEASON.slice(0, 4));

export type ProviderAuthorizationState =
  | "AUTHORIZED"
  | "NONE_CONFIGURED"
  | "INVALID"
  | "PLAN_RESTRICTED"
  | "UNKNOWN";

export const AVAILABLE_AT_POLICY = {
  preferred:
    "Use a provider timestamp only when its documented meaning is information availability (when the fact became observable), not when the injury occurred or when the match is scheduled.",
  fallback: "firstObservedAt — the instant this collector successfully received the observation.",
  forbiddenAsAvailableAt: [
    "injuryOccurrenceDate",
    "matchDate",
    "kickoff",
    "guessedPublicationTime",
    "providerEntityEffectiveDate",
    "todayProviderLatestStateBackfill",
  ],
} as const;

export class ProviderProbeBlockedError extends Error {
  readonly code = "BLOCKED_PENDING_API_FOOTBALL_AUTHORIZATION";
  constructor(message: string) {
    super(message);
    this.name = "ProviderProbeBlockedError";
  }
}

export function apiFootballAuthorizationState(): ProviderAuthorizationState {
  const key = process.env.API_FOOTBALL_KEY;
  if (key == null || !key.trim()) return "NONE_CONFIGURED";
  if (key.trim().length < 8) return "INVALID";
  return "AUTHORIZED";
}

export function refuseLiveApiFootballProbe(): never {
  const state = apiFootballAuthorizationState();
  throw new ProviderProbeBlockedError(
    `Live API-Football Premier League context probe refused (${state}). No lineup, injury, suspension, or minutes schema is authorized without a configured ${API_FOOTBALL_ENV_NAME}.`
  );
}

export function assertLiveProbeAuthorized(): void {
  if (apiFootballAuthorizationState() !== "AUTHORIZED") refuseLiveApiFootballProbe();
}

export type CanonicalFixtureMapResult =
  | { ok: true; fixtureId: string; homeSlug: string; awaySlug: string }
  | { ok: false; reason: string };

/**
 * Fail-closed identity. Names are never used. Reverse fixtures (A vs B vs B vs A)
 * map to different official IDs because home/away order is part of the key.
 */
export function mapProviderFixtureToCanonical(input: {
  providerLeagueId: number;
  season: string;
  providerHomeTeamId: number | null;
  providerAwayTeamId: number | null;
  kickoffUtc: string | null;
  teamIdToSlug: ReadonlyMap<number, string>;
}): CanonicalFixtureMapResult {
  if (input.providerLeagueId !== API_FOOTBALL_EPL_LEAGUE_ID) {
    return { ok: false, reason: "league_mismatch" };
  }
  if (input.providerHomeTeamId == null || input.providerAwayTeamId == null) {
    return { ok: false, reason: "missing_team_ids" };
  }
  if (input.providerHomeTeamId === input.providerAwayTeamId) {
    return { ok: false, reason: "identity_collision" };
  }
  const homeSlug = input.teamIdToSlug.get(input.providerHomeTeamId);
  const awaySlug = input.teamIdToSlug.get(input.providerAwayTeamId);
  if (!homeSlug || !awaySlug) return { ok: false, reason: "unmapped_team_id" };
  if (homeSlug === awaySlug) return { ok: false, reason: "slug_collision" };
  if (!input.kickoffUtc || !Number.isFinite(Date.parse(input.kickoffUtc))) {
    return { ok: false, reason: "missing_kickoff" };
  }
  return {
    ok: true,
    fixtureId: officialFixtureId(homeSlug, awaySlug, input.season),
    homeSlug,
    awaySlug,
  };
}

export function firstObservedAvailableAt(retrievedAt: string): string {
  const ms = Date.parse(retrievedAt);
  if (!Number.isFinite(ms)) {
    throw new Error("firstObservedAt must be a valid ISO timestamp");
  }
  return new Date(ms).toISOString();
}
