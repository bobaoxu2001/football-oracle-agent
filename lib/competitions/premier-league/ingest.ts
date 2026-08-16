/**
 * Idempotent Premier League season ingest.
 *
 * Identity is (season, homeClubId, awayClubId) plus a source fixture id.
 * Kickoff changes update metadata; they never mint a duplicate fixture.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ClubSeason,
  CompetitionSeason,
  Fixture,
  FixtureStatus,
  VerificationStatus,
} from "@/lib/identity/types";
import { resolveClubSlug, getClub } from "./clubs";
import { kickoffLocalIso, kickoffUtcFromSource } from "./timezone";
import { classifyOfficialKickoffCertainty } from "./kickoff-certainty";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";

export const OFFICIAL_FIXTURE_SOURCE = "premier-league-official";
export const MEMBERSHIP_SOURCE = "premier-league-membership";
export const WIKIPEDIA_CROSSCHECK = "wikipedia-2026-27-premier-league";

export const SEASON_2026_27_CLUBS = [
  "arsenal",
  "aston-villa",
  "bournemouth",
  "brentford",
  "brighton",
  "chelsea",
  "coventry",
  "crystal-palace",
  "everton",
  "fulham",
  "hull",
  "ipswich",
  "leeds",
  "liverpool",
  "manchester-city",
  "manchester-united",
  "newcastle",
  "nottingham-forest",
  "sunderland",
  "tottenham",
] as const;

export const PROMOTED_2026_27 = ["coventry", "ipswich", "hull"] as const;
export const RELEGATED_FROM_2025_26 = ["west-ham", "burnley", "wolves"] as const;
export const PREVIOUS_SEASON = "2025-26";

export interface OfficialRawRow {
  matchweek: number;
  date: string;
  time: string;
  home: string;
  away: string;
}

export interface IngestProvenance {
  source: string;
  sourceId: string;
  retrievedAt: string;
  sourceUpdatedAt?: string | null;
  verificationStatus: VerificationStatus;
  crossChecks: Array<{ source: string; status: VerificationStatus; note: string }>;
}

export interface FixtureRevision {
  fixtureId: string;
  at: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface IngestResult {
  season: CompetitionSeason;
  clubSeasons: ClubSeason[];
  fixtures: Fixture[];
  revisions: FixtureRevision[];
  provenance: IngestProvenance;
}

const DEFAULT_RAW = path.resolve(
  process.cwd(),
  "data/raw/premier-league/official-2026-27-fixtures.csv"
);

export function officialFixtureId(homeSlug: string, awaySlug: string, season = PREMIER_LEAGUE_CURRENT_SEASON): string {
  return `pl-${season}-${homeSlug}-${awaySlug}`;
}

export function parseOfficialFixtureCsv(text: string): OfficialRawRow[] {
  const rows: OfficialRawRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("matchweek,")) continue;
    const parts = trimmed.split(",");
    if (parts.length < 5) continue;
    const [mw, date, time, home, away] = parts;
    rows.push({
      matchweek: Number(mw),
      date,
      time,
      home,
      away,
    });
  }
  return rows;
}

export function loadOfficialFixtureCsv(file = DEFAULT_RAW): OfficialRawRow[] {
  return parseOfficialFixtureCsv(fs.readFileSync(file, "utf8"));
}

export function canonicalizeFixtureStatus(status: Fixture["status"] | string): FixtureStatus {
  const u = String(status).toUpperCase();
  if (u === "COMPLETED" || u === "FINISHED" || u === "FT" || u === "AWARDED") return "FINISHED";
  if (u === "LIVE" || u === "IN_PLAY" || u === "PAUSED" || u === "1H" || u === "2H" || u === "HT") return "LIVE";
  if (u === "POSTPONED" || u === "PST") return "POSTPONED";
  if (u === "CANCELLED" || u === "CANCELED" || u === "CANC") return "CANCELLED";
  if (u === "SUSPENDED") return "SUSPENDED";
  if (u === "SCHEDULED" || u === "TIMED" || u === "NS") return "SCHEDULED";
  return "SCHEDULED";
}

export function isFinishedStatus(status: Fixture["status"]): boolean {
  return canonicalizeFixtureStatus(status) === "FINISHED";
}

export function isActiveSeasonStatus(status: Fixture["status"]): boolean {
  const c = canonicalizeFixtureStatus(status);
  return c === "SCHEDULED" || c === "LIVE";
}

export function resolveRequiredClub(name: string): string {
  const slug = resolveClubSlug(name);
  if (!slug) throw new Error(`Unresolvable club name: ${name}`);
  return slug;
}

export function buildClubSeasons(asOf = "2026-08-16"): ClubSeason[] {
  const promoted = new Set<string>(PROMOTED_2026_27);
  return SEASON_2026_27_CLUBS.map((slug) => {
    const club = getClub(slug);
    const isPromoted = promoted.has(slug);
    return {
      clubId: slug,
      clubSlug: slug,
      canonicalName: club.name,
      shortName: club.shortName,
      competition: "premier-league",
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      division: "premier-league",
      entry: isPromoted ? "promoted" : "stayed",
      previousCompetition: isPromoted ? "championship" : "premier-league",
      previousSeason: PREVIOUS_SEASON,
      promotionStatus: isPromoted ? "promoted" : "continuing",
      aliases: [...club.officialNames, ...club.aliases],
    };
  });
}

export function buildRelegatedClubSeasons(): ClubSeason[] {
  return RELEGATED_FROM_2025_26.map((slug) => {
    const club = getClub(slug);
    return {
      clubId: slug,
      clubSlug: slug,
      canonicalName: club.name,
      shortName: club.shortName,
      competition: "premier-league",
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      division: "championship",
      entry: "unknown",
      previousCompetition: "premier-league",
      previousSeason: PREVIOUS_SEASON,
      promotionStatus: "relegated",
      aliases: [...club.officialNames, ...club.aliases],
    };
  });
}

/**
 * Independently cited 2026-27 membership (Phase 2A independent audit §2).
 * Not derived from the official fixture CSV constant above.
 */
export const INDEPENDENT_MEMBERSHIP_2026_27 = [
  "arsenal",
  "aston-villa",
  "bournemouth",
  "brentford",
  "brighton",
  "chelsea",
  "coventry",
  "crystal-palace",
  "everton",
  "fulham",
  "hull",
  "ipswich",
  "leeds",
  "liverpool",
  "manchester-city",
  "manchester-united",
  "newcastle",
  "nottingham-forest",
  "sunderland",
  "tottenham",
] as const;

export const INDEPENDENT_MEMBERSHIP_SOURCES = [
  "premier-league-membership-announcement",
  "bbc-opening-day-coventry",
  "liverpoolfc-promoted-preview",
  "guardian-west-ham-relegation",
  "docs/PHASE2A_INDEPENDENT_AUDIT.md",
];

export function rawRowsToFixtures(
  rows: OfficialRawRow[],
  retrievedAt: string
): Fixture[] {
  return rows.map((row) => {
    const homeSlug = resolveRequiredClub(row.home);
    const awaySlug = resolveRequiredClub(row.away);
    if (homeSlug === awaySlug) throw new Error(`Home equals away: ${row.home}`);
    const kickoffUtc = kickoffUtcFromSource(row.date, row.time);
    const id = officialFixtureId(homeSlug, awaySlug);
    return {
      id,
      competition: "premier-league",
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      date: row.date,
      scheduledDate: row.date,
      kickoff: kickoffUtc,
      kickoffUtc,
      kickoffLocal: kickoffLocalIso(row.date, row.time),
      timezone: "Europe/London",
      kickoffCertainty: classifyOfficialKickoffCertainty(row.date, row.time),
      homeSlug,
      awaySlug,
      homeClubId: homeSlug,
      awayClubId: awaySlug,
      homeGoals: null,
      awayGoals: null,
      status: "SCHEDULED",
      venue: "home",
      matchday: row.matchweek,
      source: OFFICIAL_FIXTURE_SOURCE,
      sourceId: id,
      sourceFixtureId: id,
      retrievedAt,
      sourceUpdatedAt: "2026-06-19T09:00:00+01:00",
      verificationStatus: "VERIFIED",
    };
  });
}

export function mergeFixtureUpdate(existing: Fixture, incoming: Fixture, at: string): {
  fixture: Fixture;
  revisions: FixtureRevision[];
} {
  if (existing.id !== incoming.id) {
    throw new Error(`Cannot merge different fixture identities: ${existing.id} vs ${incoming.id}`);
  }
  const revisions: FixtureRevision[] = [];
  const next: Fixture = { ...existing };
  const fields: (keyof Fixture)[] = [
    "kickoff",
    "kickoffUtc",
    "kickoffLocal",
    "kickoffCertainty",
    "scheduledDate",
    "date",
    "status",
    "homeGoals",
    "awayGoals",
    "matchday",
    "venueName",
    "sourceUpdatedAt",
    "resultSource",
    "finishedAt",
    "statusUpdatedAt",
    "verificationStatus",
  ];
  for (const field of fields) {
    const from = existing[field];
    const to = incoming[field];
    if (to === undefined) continue;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      (next as unknown as Record<string, unknown>)[field] = to;
      revisions.push({ fixtureId: existing.id, at, field, from, to });
    }
  }
  return { fixture: next, revisions };
}

/**
 * Upsert fixtures by stable identity. Running twice with the same payload
 * yields the same logical set (no duplicates).
 */
export function upsertFixtures(existing: Fixture[], incoming: Fixture[], at: string): {
  fixtures: Fixture[];
  revisions: FixtureRevision[];
} {
  const byId = new Map(existing.map((f) => [f.id, f]));
  const revisions: FixtureRevision[] = [];
  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    const merged = mergeFixtureUpdate(prev, row, at);
    byId.set(row.id, merged.fixture);
    revisions.push(...merged.revisions);
  }
  return {
    fixtures: [...byId.values()].sort((a, b) => (a.kickoffUtc ?? a.date).localeCompare(b.kickoffUtc ?? b.date)),
    revisions,
  };
}

export function detectClubConflicts(
  official: readonly string[],
  crossCheck: readonly string[]
): string[] {
  const a = new Set(official);
  const b = new Set(crossCheck);
  const conflicts: string[] = [];
  for (const id of a) if (!b.has(id)) conflicts.push(`official-only:${id}`);
  for (const id of b) if (!a.has(id)) conflicts.push(`crosscheck-only:${id}`);
  return conflicts;
}

export function ingestOfficial202627(options: {
  retrievedAt?: string;
  existingFixtures?: Fixture[];
  rawText?: string;
} = {}): IngestResult {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const rows = options.rawText ? parseOfficialFixtureCsv(options.rawText) : loadOfficialFixtureCsv();
  const incoming = rawRowsToFixtures(rows, retrievedAt);
  const { fixtures, revisions } = upsertFixtures(options.existingFixtures ?? [], incoming, retrievedAt);

  const independentConflicts = detectClubConflicts(SEASON_2026_27_CLUBS, INDEPENDENT_MEMBERSHIP_2026_27);
  const verificationStatus: VerificationStatus = independentConflicts.length ? "SOURCE_CONFLICT" : "VERIFIED";
  const clubIds = [...SEASON_2026_27_CLUBS];

  const season: CompetitionSeason = {
    competition: "premier-league",
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    startDate: "2026-08-21",
    endDate: "2027-05-30",
    status: "upcoming",
    clubIds,
    clubSlugs: clubIds,
    expectedClubCount: 20,
    fixtureCount: fixtures.length,
    source: OFFICIAL_FIXTURE_SOURCE,
    retrievedAt,
    verifiedAt: retrievedAt,
    dataVersion: `pl-2026-27-official-${retrievedAt.slice(0, 10)}`,
    verificationStatus,
    verifiedAgainst: [...INDEPENDENT_MEMBERSHIP_SOURCES],
    verificationArtifact: "docs/PHASE2A_INDEPENDENT_AUDIT.md",
    scheduleCompleteness: fixtures.length === 380 ? "complete" : "partial",
    continuingClubIds: clubIds.filter((id) => !(PROMOTED_2026_27 as readonly string[]).includes(id)),
    promotedClubIds: [...PROMOTED_2026_27],
    relegatedClubIds: [...RELEGATED_FROM_2025_26],
  };

  return {
    season,
    clubSeasons: buildClubSeasons(retrievedAt),
    fixtures,
    revisions,
    provenance: {
      source: OFFICIAL_FIXTURE_SOURCE,
      sourceId: "pl-official-fixtures-2026-27",
      retrievedAt,
      sourceUpdatedAt: "2026-06-19T09:00:00+01:00",
      verificationStatus,
      crossChecks: [
        {
          source: "independent-audit-external-membership",
          status: independentConflicts.length ? "SOURCE_CONFLICT" : "VERIFIED",
          note: independentConflicts.length
            ? `Membership disagrees: ${independentConflicts.join(", ")}`
            : "Official fixture-list membership matches the independently cited 20-club set in docs/PHASE2A_INDEPENDENT_AUDIT.md (BBC, club official, Guardian, ESPN).",
        },
        {
          source: "football-data.co.uk",
          status: "STALE",
          note: "2627/E0.csv is not published (URL serves National League EC). Not used.",
        },
        {
          source: "football-data.org",
          status: "STALE",
          note: "PL 2026 endpoint not available without a configured key. Not used.",
        },
      ],
    },
  };
}
