/**
 * football-data.org v4 → canonical match observations.
 *
 * This is the authoritative structured provider the project already uses for
 * Premier League live operations; the Big Five ledger reuses it rather than
 * introducing a second vendor.
 *
 * WHAT THIS TIER ACTUALLY SUPPLIES (verified against the live API, not docs):
 *   competition, season, matchday, stage, provider match id, utcDate,
 *   lastUpdated, both teams (+ provider team ids), status,
 *   score.halfTime.{home,away}, score.fullTime.{home,away}, score.winner,
 *   score.duration, referees.
 *
 * WHAT IT DOES NOT SUPPLY — left null, never zero:
 *   possession, shots (any breakdown), xG, corners, offsides, fouls, cards,
 *   goalkeeper saves, lineups, formations, substitutions, player minutes,
 *   goalscorers, assists, injuries. `/v4/matches/{id}` returns no statistics,
 *   lineup, goals, bookings or substitutions block on this plan.
 *
 * See FOOTBALL_DATA_CAPABILITY below; the UI reads it so a missing statistic is
 * shown as unavailable rather than rendered as 0.
 */

import { createHash } from "node:crypto";
import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { seasonStartYear } from "@/lib/competitions/big-five/configs";
import { canonicalMatchId, resolveLedgerTeam, type TeamIdentityRegistry } from "../identity";
import type {
  LedgerMatchStatus,
  MatchObservation,
  MatchOutcome,
  SourceCapability,
} from "../types";
import { MATCH_LEDGER_SCHEMA_VERSION } from "../types";

export const SOURCE_FOOTBALL_DATA = "football-data.org";

export const FOOTBALL_DATA_CAPABILITY: SourceCapability = {
  source: SOURCE_FOOTBALL_DATA,
  tier: "TIER_ONE",
  provides: [
    "competition",
    "season",
    "matchday",
    "stage",
    "providerMatchId",
    "providerTeamId",
    "kickoffUtc",
    "status",
    "halfTimeHomeGoals",
    "halfTimeAwayGoals",
    "fullTimeHomeGoals",
    "fullTimeAwayGoals",
    "outcome",
    "providerUpdatedAt",
  ],
  missing: [
    "possessionPct",
    "totalShots",
    "shotsOnTarget",
    "shotsOffTarget",
    "blockedShots",
    "shotsInsideBox",
    "shotsOutsideBox",
    "expectedGoals",
    "corners",
    "offsides",
    "fouls",
    "yellowCards",
    "redCards",
    "goalkeeperSaves",
    "startingXI",
    "formation",
    "substitutions",
    "playerMinutes",
    "goalscorers",
    "assists",
    "cards",
    "injuries",
  ],
  notes:
    "TIER_ONE exposes results only. Statistics, lineups and match events require a paid plan " +
    "(or a second vendor such as API-Football). No statistic is synthesised: every unavailable " +
    "field stays null. xG is NOT provided by this source, so no xG figure in this ledger can be " +
    "attributed to it.",
};

/** Raw v4 match shape. Every field optional — the API omits and malforms fields. */
export interface FootballDataMatch {
  id?: number;
  utcDate?: string;
  status?: string;
  matchday?: number | null;
  stage?: string | null;
  lastUpdated?: string;
  homeTeam?: { id?: number; name?: string; shortName?: string | null; tla?: string | null };
  awayTeam?: { id?: number; name?: string; shortName?: string | null; tla?: string | null };
  score?: {
    winner?: string | null;
    duration?: string | null;
    fullTime?: { home?: number | null; away?: number | null };
    halfTime?: { home?: number | null; away?: number | null };
  };
}

/**
 * Map a provider status string to our lifecycle enum.
 *
 * Anything unrecognised becomes UNKNOWN, never FINISHED. This is not defensive
 * paranoia: the live PL 2026-27 feed currently returns a timestamp string
 * ("2026-10-10 14:00:00Z") in `status` for 25 future fixtures. Guessing
 * optimistically there would invent completed matches out of a provider bug.
 */
export function mapLedgerStatus(raw: string | null | undefined): LedgerMatchStatus {
  const u = String(raw ?? "").trim().toUpperCase();
  switch (u) {
    case "FINISHED":
    case "AWARDED":
      return "FINISHED";
    case "IN_PLAY":
    case "PAUSED":
      return "LIVE";
    case "SCHEDULED":
    case "TIMED":
      return "SCHEDULED";
    case "POSTPONED":
      return "POSTPONED";
    case "SUSPENDED":
      return "SUSPENDED";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

function outcomeFromWinner(winner: string | null | undefined): MatchOutcome | null {
  switch (String(winner ?? "").toUpperCase()) {
    case "HOME_TEAM":
      return "HOME";
    case "AWAY_TEAM":
      return "AWAY";
    case "DRAW":
      return "DRAW";
    default:
      return null;
  }
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Fields dropped from the stored raw payload.
 *
 * `area`, `competition` and `season` are per-request constants that v4 repeats
 * on every match row — identical bytes duplicated once per fixture. All three
 * are already recorded on the observation itself (competition, season) or are
 * derivable from it, so dropping them loses no provenance while cutting the
 * stored log by roughly 60%. This is an explicit, documented normalisation, not
 * silent truncation: everything match-specific is kept verbatim.
 */
export const RAW_ENVELOPE_FIELDS = ["area", "competition", "season"] as const;

export function trimRawEnvelope(raw: FootballDataMatch): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const field of RAW_ENVELOPE_FIELDS) delete clone[field];
  return clone;
}

/**
 * Content fingerprint → observation id.
 *
 * Identical provider content re-observed yields the SAME id, so a replayed tick
 * is a no-op. A genuine change (score correction, status transition, kickoff
 * move) yields a new id, so the change is recorded as an additional observation
 * and stays detectable — rather than overwriting what we previously believed.
 *
 * `providerUpdatedAt` is deliberately NOT part of the fingerprint. It describes
 * when the provider last touched its own row, not what the match is; including
 * it would mint a fresh observation for every republish of unchanged data and
 * grow the log without adding information. It is still stored on the
 * observation, so publication provenance is retained.
 */
export function observationIdFor(
  source: string,
  canonicalId: string,
  fingerprint: Record<string, unknown>
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex")
    .slice(0, 16);
  return `${source}::${canonicalId}::${digest}`;
}

export interface MapResult {
  observation: MatchObservation | null;
  registry: TeamIdentityRegistry;
  /** Why a row was rejected, for the ingest report. */
  rejectedReason?: string;
}

/** Map one provider match into an observation, threading team identity. */
export function mapFootballDataMatch(
  raw: FootballDataMatch,
  input: {
    competition: BigFiveCompetitionId;
    season: string;
    observedAt: string;
    registry: TeamIdentityRegistry;
  }
): MapResult {
  const homeName = raw.homeTeam?.name;
  const awayName = raw.awayTeam?.name;
  if (!homeName || !awayName) {
    return { observation: null, registry: input.registry, rejectedReason: "missing team name" };
  }

  const homeResolved = resolveLedgerTeam(
    input.registry,
    input.competition,
    {
      providerTeamId: raw.homeTeam?.id != null ? String(raw.homeTeam.id) : null,
      name: homeName,
      shortName: raw.homeTeam?.shortName ?? null,
      tla: raw.homeTeam?.tla ?? null,
    },
    input.observedAt
  );
  const awayResolved = resolveLedgerTeam(
    homeResolved.registry,
    input.competition,
    {
      providerTeamId: raw.awayTeam?.id != null ? String(raw.awayTeam.id) : null,
      name: awayName,
      shortName: raw.awayTeam?.shortName ?? null,
      tla: raw.awayTeam?.tla ?? null,
    },
    input.observedAt
  );
  const registry = awayResolved.registry;

  const status = mapLedgerStatus(raw.status);
  const ftHome = intOrNull(raw.score?.fullTime?.home);
  const ftAway = intOrNull(raw.score?.fullTime?.away);

  // A "finished" match without a score is not a result. Refuse to record one.
  const finishedWithScore = status === "FINISHED" && ftHome !== null && ftAway !== null;
  if (status === "FINISHED" && !finishedWithScore) {
    return {
      observation: null,
      registry,
      rejectedReason: "status FINISHED but no full-time score",
    };
  }

  const canonicalId = canonicalMatchId(
    input.competition,
    input.season,
    homeResolved.team.slug,
    awayResolved.team.slug
  );
  const providerMatchId = raw.id != null ? String(raw.id) : null;
  const providerUpdatedAt = isoOrNull(raw.lastUpdated);

  const observation: MatchObservation = {
    observationId: observationIdFor(SOURCE_FOOTBALL_DATA, canonicalId, {
      status,
      ftHome,
      ftAway,
      htHome: intOrNull(raw.score?.halfTime?.home),
      htAway: intOrNull(raw.score?.halfTime?.away),
      kickoff: isoOrNull(raw.utcDate),
      matchday: intOrNull(raw.matchday),
      providerMatchId,
    }),
    schemaVersion: MATCH_LEDGER_SCHEMA_VERSION,
    competition: input.competition,
    season: input.season,
    canonicalMatchId: canonicalId,
    providerMatchId,
    source: SOURCE_FOOTBALL_DATA,
    observedAt: input.observedAt,
    providerUpdatedAt,
    matchday: intOrNull(raw.matchday),
    stage: typeof raw.stage === "string" ? raw.stage : null,
    kickoffUtc: isoOrNull(raw.utcDate),
    home: homeResolved.team,
    away: awayResolved.team,
    status,
    halfTimeHomeGoals: intOrNull(raw.score?.halfTime?.home),
    halfTimeAwayGoals: intOrNull(raw.score?.halfTime?.away),
    fullTimeHomeGoals: ftHome,
    fullTimeAwayGoals: ftAway,
    outcome: finishedWithScore
      ? outcomeFromWinner(raw.score?.winner) ??
        (ftHome > ftAway ? "HOME" : ftHome < ftAway ? "AWAY" : "DRAW")
      : null,
    // This tier supplies neither. Null means "not available from this source".
    homeStatistics: null,
    awayStatistics: null,
    events: null,
    raw: trimRawEnvelope(raw),
  };

  return { observation, registry };
}

export function footballDataConfigured(): boolean {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  return Boolean(key && key.length > 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one competition-season's full match list, respecting the provider's
 * rate limit.
 *
 * The free tier allows ~10 requests/minute and answers 429 past that. Ingesting
 * five competitions back-to-back reaches it in practice, so a 429 is retried
 * after the interval the provider asks for (Retry-After, else a 60s window)
 * rather than being reported as a competition-wide failure.
 */
export async function fetchCompetitionMatches(
  competition: BigFiveCompetitionId,
  season: string,
  options: { timeoutMs?: number; maxRetries?: number; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<{ matches: FootballDataMatch[]; httpStatus: number; retries: number }> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  const code = getCompetition(competition).footballDataCode;
  const year = seasonStartYear(season);
  const maxRetries = options.maxRetries ?? 3;
  const wait = options.sleepFn ?? sleep;
  let retries = 0;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const res = await fetch(
        `https://api.football-data.org/v4/competitions/${code}/matches?season=${year}`,
        { headers: { "X-Auth-Token": key }, signal: controller.signal }
      );
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
        retries += 1;
        console.warn(
          `[ledger] ${code} rate limited — waiting ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`
        );
        clearTimeout(timeout);
        await wait(delayMs);
        continue;
      }
      if (!res.ok) return { matches: [], httpStatus: res.status, retries };
      const data = (await res.json()) as { matches?: FootballDataMatch[] };
      return { matches: data.matches ?? [], httpStatus: res.status, retries };
    } finally {
      clearTimeout(timeout);
    }
  }
}
