/**
 * Live fixture/result sources.
 *
 * Official June 19 CSV is the baseline schedule, not a live competitor
 * against later TV confirmation. football-data.org is the preferred
 * structured live feed; API-Football is corroboration.
 */

import type { Fixture, KickoffCertainty } from "@/lib/identity/types";
import { resolveClubSlug } from "../clubs";
import { officialFixtureId } from "../ingest";
import { utcIsoToLondonLocal } from "../timezone";
import { classifyOfficialKickoffCertainty } from "../kickoff-certainty";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import type { MatchStatus, NormalizedSourceFixture, SourceObservation } from "./types";

export const SOURCE_OFFICIAL = "premier-league-official";
export const SOURCE_FOOTBALL_DATA = "football-data.org";
export const SOURCE_API_FOOTBALL = "api-football";

export const LIVE_SOURCES = [SOURCE_FOOTBALL_DATA, SOURCE_API_FOOTBALL] as const;

export interface FixtureSource {
  id: string;
  kind: "baseline" | "live";
  configured: boolean;
  fetch(nowIso: string): Promise<SourceObservation[]>;
}

export function resolvePlClub(name: string | null | undefined): string | null {
  if (!name) return null;
  const direct = resolveClubSlug(name);
  if (direct) return direct;
  const stripped = name
    .replace(/\s+Football Club$/i, "")
    .replace(/\s+FC$/i, "")
    .replace(/\s+AFC$/i, "")
    .trim();
  return resolveClubSlug(stripped);
}

export function mapSourceStatus(raw: string | null | undefined): MatchStatus {
  const u = String(raw ?? "").toUpperCase();
  if (["FT", "FINISHED", "AWARDED", "AET", "PEN", "COMPLETED"].includes(u)) return "FINISHED";
  if (["LIVE", "IN_PLAY", "INPLAY", "1H", "2H", "HT", "PAUSED", "ET", "BT", "P", "INT"].includes(u)) {
    return "LIVE";
  }
  if (["PST", "POSTPONED"].includes(u)) return "POSTPONED";
  if (["SUSP", "SUSPENDED"].includes(u)) return "SUSPENDED";
  if (["CANC", "CANCELLED", "CANCELED"].includes(u)) return "CANCELLED";
  if (["ABD", "ABAN", "ABANDONED"].includes(u)) return "ABANDONED";
  return "SCHEDULED";
}

export function certaintyFromLiveStatus(status: MatchStatus, kickoffUtc: string | null): KickoffCertainty {
  if (!kickoffUtc) return "TBD";
  if (status === "POSTPONED" || status === "CANCELLED" || status === "ABANDONED") return "TBD";
  // A live feed that merely repeats Sat 15:00 / Wed 20:00 is still DEFAULT.
  // Only a non-default slot is CONFIRMED. Same rule as the official release.
  try {
    const loc = utcIsoToLondonLocal(kickoffUtc);
    return classifyOfficialKickoffCertainty(loc.date, loc.time);
  } catch {
    return "CONFIRMED";
  }
}

export function observationFromNormalized(input: {
  source: string;
  retrievedAt: string;
  sourceFixtureId?: string | null;
  sourceUpdatedAt?: string | null;
  raw?: unknown;
  normalized: NormalizedSourceFixture;
}): SourceObservation {
  const home = input.normalized.homeSlug;
  const away = input.normalized.awaySlug;
  const fixtureId = home && away ? officialFixtureId(home, away) : null;
  return {
    observationId: `${input.source}::${fixtureId ?? input.sourceFixtureId ?? "unknown"}::${input.retrievedAt}`,
    kind: input.normalized.status === "FINISHED" || input.normalized.homeGoals !== null ? "result" : "fixture",
    source: input.source,
    sourceFixtureId: input.sourceFixtureId ?? null,
    fixtureId,
    retrievedAt: input.retrievedAt,
    sourceUpdatedAt: input.sourceUpdatedAt ?? input.normalized.sourceUpdatedAt,
    raw: input.raw ?? input.normalized,
    normalized: input.normalized,
    verificationStatus: fixtureId ? "VERIFIED" : "PROVISIONAL",
  };
}

export function officialBaselineObservations(fixtures: Fixture[], retrievedAt: string): SourceObservation[] {
  return fixtures.map((f) =>
    observationFromNormalized({
      source: SOURCE_OFFICIAL,
      retrievedAt,
      sourceFixtureId: f.sourceFixtureId ?? f.id,
      sourceUpdatedAt: f.sourceUpdatedAt ?? null,
      raw: {
        id: f.id,
        kickoffUtc: f.kickoffUtc,
        kickoffCertainty: f.kickoffCertainty,
        status: f.status,
      },
      normalized: {
        homeSlug: f.homeSlug,
        awaySlug: f.awaySlug,
        kickoffUtc: f.kickoffUtc ?? f.kickoff ?? null,
        kickoffLocal: f.kickoffLocal ?? null,
        scheduledDate: f.scheduledDate ?? f.date,
        kickoffCertainty: f.kickoffCertainty ?? null,
        status: mapSourceStatus(String(f.status)),
        homeGoals: f.homeGoals,
        awayGoals: f.awayGoals,
        sourceUpdatedAt: f.sourceUpdatedAt ?? null,
      },
    })
  );
}

function londonBits(utc: string | null): { local: string | null; date: string | null } {
  if (!utc) return { local: null, date: null };
  try {
    const l = utcIsoToLondonLocal(utc);
    return { local: `${l.date}T${l.time}:00`, date: l.date };
  } catch {
    return { local: null, date: utc.slice(0, 10) };
  }
}

interface FdPlMatch {
  id?: number;
  utcDate?: string;
  status?: string;
  lastUpdated?: string;
  homeTeam?: { name?: string; tla?: string | null };
  awayTeam?: { name?: string; tla?: string | null };
  score?: { fullTime?: { home?: number | null; away?: number | null } };
}

function isDateOnlyUtc(utc: string | null | undefined): boolean {
  if (!utc) return true;
  return /T00:00:00(?:\.000)?Z$/.test(utc);
}

export function mapFootballDataMatch(m: FdPlMatch, retrievedAt: string): SourceObservation | null {
  const home = resolvePlClub(m.homeTeam?.name) ?? resolvePlClub(m.homeTeam?.tla ?? undefined);
  const away = resolvePlClub(m.awayTeam?.name) ?? resolvePlClub(m.awayTeam?.tla ?? undefined);
  if (!home || !away) return null;
  const status = mapSourceStatus(m.status);
  const rawUtc = m.utcDate ? new Date(m.utcDate).toISOString() : null;
  const timed =
    m.status === "TIMED" || m.status === "IN_PLAY" || m.status === "FINISHED" || m.status === "PAUSED";
  // football-data.org uses T00:00:00Z + SCHEDULED when the time is not yet set.
  const kickoffUtc = timed && rawUtc && !isDateOnlyUtc(rawUtc) ? rawUtc : null;
  const bits = londonBits(kickoffUtc ?? rawUtc);
  return observationFromNormalized({
    source: SOURCE_FOOTBALL_DATA,
    retrievedAt,
    sourceFixtureId: m.id != null ? String(m.id) : null,
    sourceUpdatedAt: m.lastUpdated ?? null,
    raw: m,
    normalized: {
      homeSlug: home,
      awaySlug: away,
      kickoffUtc,
      kickoffLocal: kickoffUtc ? bits.local : null,
      scheduledDate: bits.date,
      kickoffCertainty: kickoffUtc ? certaintyFromLiveStatus(status, kickoffUtc) : "TBD",
      status,
      homeGoals: m.score?.fullTime?.home ?? null,
      awayGoals: m.score?.fullTime?.away ?? null,
      sourceUpdatedAt: m.lastUpdated ?? null,
    },
  });
}

interface AfPlFixture {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string };
    timestamp?: number;
  };
  teams?: { home?: { name?: string }; away?: { name?: string } };
  goals?: { home?: number | null; away?: number | null };
}

export function mapApiFootballFixture(r: AfPlFixture, retrievedAt: string): SourceObservation | null {
  const home = resolvePlClub(r.teams?.home?.name);
  const away = resolvePlClub(r.teams?.away?.name);
  if (!home || !away) return null;
  const status = mapSourceStatus(r.fixture?.status?.short);
  const kickoffUtc = r.fixture?.date ? new Date(r.fixture.date).toISOString() : null;
  const bits = londonBits(kickoffUtc);
  return observationFromNormalized({
    source: SOURCE_API_FOOTBALL,
    retrievedAt,
    sourceFixtureId: r.fixture?.id != null ? String(r.fixture.id) : null,
    raw: r,
    normalized: {
      homeSlug: home,
      awaySlug: away,
      kickoffUtc,
      kickoffLocal: bits.local,
      scheduledDate: bits.date,
      kickoffCertainty: certaintyFromLiveStatus(status, kickoffUtc),
      status,
      homeGoals: r.goals?.home ?? null,
      awayGoals: r.goals?.away ?? null,
      sourceUpdatedAt: null,
    },
  });
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      console.warn(`[pl-ops] ${url} HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[pl-ops] fetch error:", (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function footballDataConfigured(): boolean {
  return Boolean(process.env.FOOTBALL_DATA_API_KEY && process.env.FOOTBALL_DATA_API_KEY.length > 10);
}

export function apiFootballConfigured(): boolean {
  return Boolean(process.env.API_FOOTBALL_KEY && process.env.API_FOOTBALL_KEY.length > 10);
}

export function footballDataSource(): FixtureSource {
  return {
    id: SOURCE_FOOTBALL_DATA,
    kind: "live",
    configured: footballDataConfigured(),
    async fetch(nowIso: string) {
      const key = process.env.FOOTBALL_DATA_API_KEY;
      if (!key) return [];
      const year = Number(PREMIER_LEAGUE_CURRENT_SEASON.slice(0, 4));
      const data = (await fetchJson(
        `https://api.football-data.org/v4/competitions/PL/matches?season=${year}`,
        { "X-Auth-Token": key },
        12000
      )) as { matches?: FdPlMatch[] } | null;
      if (!data?.matches) return [];
      return data.matches.map((m) => mapFootballDataMatch(m, nowIso)).filter((x): x is SourceObservation => Boolean(x));
    },
  };
}

export function apiFootballSource(): FixtureSource {
  return {
    id: SOURCE_API_FOOTBALL,
    kind: "live",
    configured: apiFootballConfigured(),
    async fetch(nowIso: string) {
      const key = process.env.API_FOOTBALL_KEY;
      if (!key) return [];
      const year = Number(PREMIER_LEAGUE_CURRENT_SEASON.slice(0, 4));
      const data = (await fetchJson(
        `https://v3.football.api-sports.io/fixtures?league=39&season=${year}`,
        { "x-apisports-key": key },
        12000
      )) as { response?: AfPlFixture[] } | null;
      if (!data?.response) return [];
      return data.response
        .map((r) => mapApiFootballFixture(r, nowIso))
        .filter((x): x is SourceObservation => Boolean(x));
    },
  };
}

export function officialBaselineSource(fixtures: Fixture[]): FixtureSource {
  return {
    id: SOURCE_OFFICIAL,
    kind: "baseline",
    configured: true,
    async fetch(nowIso: string) {
      return officialBaselineObservations(fixtures, nowIso);
    },
  };
}

export function defaultLiveSources(): FixtureSource[] {
  return [footballDataSource(), apiFootballSource()];
}
