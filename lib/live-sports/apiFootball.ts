/**
 * API-Football (API-SPORTS) client — the real sports data provider for the live
 * tournament-state layer.
 *
 * Reads its key ONLY from the environment (never hard-coded / logged):
 *   API_FOOTBALL_KEY=<secret>   ← .env.local / Vercel env
 *
 * Every call is timed out and wrapped; any failure returns null so the caller
 * falls back to the MongoDB cache, then to demo mode. Free-tier friendly: the
 * orchestrator (tournamentState.ts) caches aggressively so we don't call the API
 * on every user query.
 */

import { integerFromEnv } from "@/lib/config/env";
import { TEAMS } from "@/lib/seed/world-cup-2026-groups";
import type { LiveFixture, LiveInjury } from "./types";

const BASE = "https://v3.football.api-sports.io";
// FIFA World Cup competition id in API-Football is 1. Season is the start year.
const WORLD_CUP_LEAGUE_ID = integerFromEnv("API_FOOTBALL_LEAGUE_ID", 1);
const SEASON = integerFromEnv("API_FOOTBALL_SEASON", 2026);

export function apiFootballConfigured(): boolean {
  return Boolean(process.env.API_FOOTBALL_KEY && process.env.API_FOOTBALL_KEY.length > 10);
}

// ---- Canonical team normalization (API team name/code → app slug) ----------

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_CODE = new Map<string, string>(); // FIFA 3-letter code → slug
const BY_NAME = new Map<string, string>(); // normalized name → slug
for (const t of TEAMS) {
  BY_CODE.set(t.fifaCode.toUpperCase(), t.slug);
  BY_NAME.set(norm(t.name), t.slug);
  BY_NAME.set(norm(t.slug.replace(/-/g, " ")), t.slug);
}
// Common API-Football naming variants → app slug.
const NAME_ALIASES: Record<string, string> = {
  "usa": "usa",
  "united states": "usa",
  "korea republic": "south-korea",
  "south korea": "south-korea",
  "ir iran": "iran",
  "iran": "iran",
  "turkey": "turkey",
  "turkiye": "turkey",
  "ivory coast": "ivory-coast",
  "cote d ivoire": "ivory-coast",
  "czechia": "czech-republic",
  "czech republic": "czech-republic",
  "bosnia and herzegovina": "bosnia-and-herzegovina",
  "cape verde islands": "cape-verde",
  "cape verde": "cape-verde",
  "dr congo": "dr-congo",
  "congo dr": "dr-congo",
};

/** Map an API-Football team name (+ optional 3-letter code) to a canonical slug. */
export function toSlug(name: string | undefined, code?: string | null): string | null {
  if (code && BY_CODE.has(code.toUpperCase())) return BY_CODE.get(code.toUpperCase())!;
  if (!name) return null;
  const n = norm(name);
  if (NAME_ALIASES[n]) return NAME_ALIASES[n];
  if (BY_NAME.has(n)) return BY_NAME.get(n)!;
  return null;
}

// ---- Low-level fetch (timed out, key from env, never logs the key) ----------

async function apiGet(path: string, timeoutMs = 8000): Promise<unknown | null> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-apisports-key": key },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[api-football] request failed: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[api-football] request error:", (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Public fetchers (normalized) ------------------------------------------

interface RawFixture {
  fixture?: { id?: number; date?: string; status?: { short?: string } };
  league?: { round?: string };
  teams?: {
    home?: { name?: string; winner?: boolean | null };
    away?: { name?: string; winner?: boolean | null };
  };
  goals?: { home?: number | null; away?: number | null };
}

export async function fetchFixtures(): Promise<LiveFixture[] | null> {
  const data = (await apiGet(`/fixtures?league=${WORLD_CUP_LEAGUE_ID}&season=${SEASON}`)) as
    | { response?: RawFixture[] }
    | null;
  if (!data?.response) return null;
  return data.response.map((r) => ({
    id: r.fixture?.id ?? 0,
    round: r.league?.round ?? "",
    status: r.fixture?.status?.short ?? "",
    homeSlug: toSlug(r.teams?.home?.name),
    awaySlug: toSlug(r.teams?.away?.name),
    goalsHome: r.goals?.home ?? null,
    goalsAway: r.goals?.away ?? null,
    homeWinner: r.teams?.home?.winner ?? null,
    awayWinner: r.teams?.away?.winner ?? null,
    date: r.fixture?.date ?? "",
  }));
}

interface RawInjury {
  player?: { name?: string; reason?: string; type?: string };
  team?: { name?: string; code?: string | null };
  fixture?: { date?: string };
}

export async function fetchInjuries(): Promise<LiveInjury[] | null> {
  const data = (await apiGet(`/injuries?league=${WORLD_CUP_LEAGUE_ID}&season=${SEASON}`)) as
    | { response?: RawInjury[] }
    | null;
  if (!data?.response) return null;
  return data.response.map((r) => ({
    slug: toSlug(r.team?.name, r.team?.code),
    team: r.team?.name ?? "",
    player: r.player?.name ?? "",
    reason: r.player?.reason ?? "",
    type: r.player?.type,
    date: r.fixture?.date,
  }));
}
