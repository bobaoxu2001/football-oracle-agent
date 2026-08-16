/**
 * Current-season production data-validity gate.
 *
 * Structural completeness (20 clubs, 380 fixtures, pairs, provenance) is
 * independent of kickoff-time confirmation. DEFAULT/PROVISIONAL kickoffs
 * do not block DATA_READY.
 */

import type { ClubSeason, CompetitionSeason, Fixture } from "@/lib/identity/types";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { liveClubSeasons, liveCompetitionSeason, liveFixtures } from "./fixture-store";
import { canonicalizeFixtureStatus, PROMOTED_2026_27, RELEGATED_FROM_2025_26 } from "./ingest";

export type DataGateStatus = "DATA_READY" | "DATA_DEGRADED" | "DATA_BLOCKED";

export interface DataGateChecks {
  competition: boolean;
  season: boolean;
  clubCount: boolean;
  uniqueClubs: boolean;
  fixtureCount: boolean;
  uniqueFixtures: boolean;
  homeNotAway: boolean;
  clubsInSeason: boolean;
  fixturesPerClub: boolean;
  homeAwaySplit: boolean;
  pairCompleteness: boolean;
  pairHomeAndAway: boolean;
  scheduledDate: boolean;
  kickoffMetadata: boolean;
  provenance: boolean;
  identitiesResolved: boolean;
  noRelegatedActive: boolean;
  promotedPresent: boolean;
}

export interface DataGate {
  status: DataGateStatus;
  reasons: string[];
  errors: string[];
  warnings: string[];
  checks: DataGateChecks;
  season: string;
  clubCount: number;
  fixtureCount: number;
  scheduleCompleteness: "complete" | "partial" | "missing";
  source: string | null;
  retrievedAt: string | null;
  verificationStatus: string | null;
  verifiedAgainst?: string[];
  verificationArtifact?: string;
}

export interface DataGateInput {
  season?: CompetitionSeason | null;
  fixtures?: Fixture[];
  clubSeasons?: ClubSeason[];
  now?: Date;
}

const EXPECTED_CLUBS = 20;
const EXPECTED_FIXTURES = 380;
const EXPECTED_PER_CLUB = 38;
const EXPECTED_HOME = 19;
const EXPECTED_AWAY = 19;

function emptyChecks(v = false): DataGateChecks {
  return {
    competition: v,
    season: v,
    clubCount: v,
    uniqueClubs: v,
    fixtureCount: v,
    uniqueFixtures: v,
    homeNotAway: v,
    clubsInSeason: v,
    fixturesPerClub: v,
    homeAwaySplit: v,
    pairCompleteness: v,
    pairHomeAndAway: v,
    scheduledDate: v,
    kickoffMetadata: v,
    provenance: v,
    identitiesResolved: v,
    noRelegatedActive: v,
    promotedPresent: v,
  };
}

export function evaluateSeasonData(input: DataGateInput = {}): DataGate {
  const season = input.season === undefined ? liveCompetitionSeason() : input.season;
  const fixtures = input.fixtures ?? liveFixtures();
  const clubSeasons = input.clubSeasons ?? liveClubSeasons();
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks = emptyChecks(false);

  if (!season) {
    errors.push("No CompetitionSeason manifest is loaded.");
    return {
      status: "DATA_BLOCKED",
      reasons: errors,
      errors,
      warnings,
      checks,
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      clubCount: 0,
      fixtureCount: fixtures.length,
      scheduleCompleteness: "missing",
      source: null,
      retrievedAt: null,
      verificationStatus: null,
    };
  }

  checks.competition = season.competition === "premier-league";
  if (!checks.competition) errors.push(`competition is ${season.competition}, expected premier-league.`);

  checks.season = season.season === PREMIER_LEAGUE_CURRENT_SEASON;
  if (!checks.season) errors.push(`Manifest season ${season.season} is not ${PREMIER_LEAGUE_CURRENT_SEASON}.`);

  const clubIds = season.clubIds ?? [];
  checks.clubCount = clubIds.length === EXPECTED_CLUBS && season.expectedClubCount === EXPECTED_CLUBS;
  if (!checks.clubCount) errors.push(`Club count ${clubIds.length} ≠ expected ${EXPECTED_CLUBS}.`);

  checks.uniqueClubs = new Set(clubIds).size === clubIds.length && clubIds.length === EXPECTED_CLUBS;
  if (new Set(clubIds).size !== clubIds.length) errors.push("Duplicate club ids in the season manifest.");

  const relegatedActive = RELEGATED_FROM_2025_26.filter((id) => clubIds.includes(id));
  checks.noRelegatedActive = relegatedActive.length === 0;
  for (const id of relegatedActive) errors.push(`Relegated club ${id} is still listed as active.`);

  const missingPromoted = PROMOTED_2026_27.filter((id) => !clubIds.includes(id));
  checks.promotedPresent = missingPromoted.length === 0;
  for (const id of missingPromoted) errors.push(`Promoted club ${id} is missing from the active set.`);

  const fixtureIds = fixtures.map((f) => f.id);
  checks.fixtureCount = fixtures.length === EXPECTED_FIXTURES;
  if (!checks.fixtureCount) errors.push(`Fixture count ${fixtures.length} ≠ expected ${EXPECTED_FIXTURES}.`);

  checks.uniqueFixtures = new Set(fixtureIds).size === fixtures.length;
  if (!checks.uniqueFixtures) errors.push("Duplicate fixture ids.");

  let homeEqAway = 0;
  let outsider = 0;
  let unresolved = 0;
  let missingDate = 0;
  let badKickoffMeta = 0;
  let missingSource = 0;
  const homeN: Record<string, number> = {};
  const awayN: Record<string, number> = {};
  const directed = new Set<string>();
  const undirected: Record<string, string[]> = {};

  for (const f of fixtures) {
    if (f.homeSlug === f.awaySlug) homeEqAway += 1;
    if (!f.homeSlug || !f.awaySlug) unresolved += 1;
    if (f.homeSlug && !clubIds.includes(f.homeSlug)) outsider += 1;
    if (f.awaySlug && !clubIds.includes(f.awaySlug)) outsider += 1;
    const scheduled = f.scheduledDate ?? f.date;
    if (!scheduled || !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) missingDate += 1;
    const kick = f.kickoffUtc ?? f.kickoff ?? null;
    if (kick && !Number.isFinite(Date.parse(kick))) badKickoffMeta += 1;
    if (!kick && f.kickoffCertainty !== "TBD") badKickoffMeta += 1;
    if (!f.source && !season.source) missingSource += 1;
    homeN[f.homeSlug] = (homeN[f.homeSlug] ?? 0) + 1;
    awayN[f.awaySlug] = (awayN[f.awaySlug] ?? 0) + 1;
    directed.add(`${f.homeSlug}::${f.awaySlug}`);
    const pair = [f.homeSlug, f.awaySlug].sort().join("::");
    (undirected[pair] ??= []).push(`${f.homeSlug}::${f.awaySlug}`);
  }

  checks.homeNotAway = homeEqAway === 0;
  if (homeEqAway) errors.push(`${homeEqAway} fixtures have home = away.`);

  checks.clubsInSeason = outsider === 0;
  if (outsider) errors.push(`${outsider} fixtures involve a club outside the active season.`);

  checks.identitiesResolved = unresolved === 0;
  if (unresolved) errors.push(`${unresolved} fixtures have unresolved team identities.`);

  checks.scheduledDate = missingDate === 0;
  if (missingDate) errors.push(`${missingDate} fixtures lack a valid scheduled date.`);

  checks.kickoffMetadata = badKickoffMeta === 0;
  if (badKickoffMeta) errors.push(`${badKickoffMeta} fixtures have invalid kickoff metadata.`);

  const seasonProvenance = Boolean(season.source && season.retrievedAt);
  const fixtureProvenance = fixtures.every((f) => Boolean(f.source));
  checks.provenance = seasonProvenance && fixtureProvenance && missingSource === 0;
  if (!checks.provenance) errors.push("Missing required provenance (source / retrievedAt).");

  let perClubOk = clubIds.length === EXPECTED_CLUBS && fixtures.length === EXPECTED_FIXTURES;
  let splitOk = perClubOk;
  for (const id of clubIds) {
    const h = homeN[id] ?? 0;
    const a = awayN[id] ?? 0;
    if (h + a !== EXPECTED_PER_CLUB) perClubOk = false;
    if (h !== EXPECTED_HOME || a !== EXPECTED_AWAY) splitOk = false;
  }
  checks.fixturesPerClub = perClubOk;
  if (!perClubOk && fixtures.length > 0) {
    errors.push(`Not every club has exactly ${EXPECTED_PER_CLUB} fixtures.`);
  }
  checks.homeAwaySplit = splitOk;
  if (!splitOk && fixtures.length > 0) {
    errors.push(`Not every club has ${EXPECTED_HOME} home and ${EXPECTED_AWAY} away fixtures.`);
  }

  const expectedPairs = (EXPECTED_CLUBS * (EXPECTED_CLUBS - 1)) / 2;
  let pairComplete = fixtures.length === EXPECTED_FIXTURES;
  let pairHomeAway = pairComplete;
  let sameVenueTwice = 0;
  for (const [pair, dirs] of Object.entries(undirected)) {
    if (dirs.length !== 2) {
      pairComplete = false;
    }
    const uniqueDirs = new Set(dirs);
    if (uniqueDirs.size !== 2) {
      pairHomeAway = false;
      sameVenueTwice += 1;
    }
    void pair;
  }
  if (Object.keys(undirected).length !== expectedPairs) pairComplete = false;
  checks.pairCompleteness = pairComplete;
  if (!pairComplete && fixtures.length > 0) {
    errors.push("Pair completeness failed (each unordered pair must appear exactly twice).");
  }
  checks.pairHomeAndAway = pairHomeAway && sameVenueTwice === 0;
  if (!checks.pairHomeAndAway && fixtures.length > 0) {
    errors.push("A club pair appears twice at the same home venue rather than reversed.");
  }

  if (clubSeasons.length && clubSeasons.length !== EXPECTED_CLUBS) {
    warnings.push(`ClubSeason count is ${clubSeasons.length}, expected ${EXPECTED_CLUBS}.`);
  }

  const blocking = errors.length > 0;
  const status: DataGateStatus = blocking ? "DATA_BLOCKED" : "DATA_READY";

  return {
    status,
    reasons: errors,
    errors,
    warnings,
    checks,
    season: season.season,
    clubCount: clubIds.length,
    fixtureCount: fixtures.length,
    scheduleCompleteness: fixtures.length === EXPECTED_FIXTURES ? "complete" : fixtures.length === 0 ? "missing" : "partial",
    source: season.source,
    retrievedAt: season.retrievedAt,
    verificationStatus: season.verificationStatus,
    verifiedAgainst: season.verifiedAgainst,
    verificationArtifact: season.verificationArtifact,
  };
}

export function evaluateDataGate(now = new Date()): DataGate {
  void now;
  return evaluateSeasonData();
}

export function upcomingLiveFixtures(now = new Date()): Fixture[] {
  const ms = now.getTime();
  return liveFixtures()
    .filter((f) => {
      const status = canonicalizeFixtureStatus(f.status);
      if (status !== "SCHEDULED" && status !== "LIVE") return false;
      const kick = Date.parse(f.kickoffUtc ?? f.kickoff ?? "");
      return Number.isFinite(kick) ? kick > ms : (f.scheduledDate ?? f.date) >= now.toISOString().slice(0, 10);
    })
    .sort((a, b) => (a.kickoffUtc ?? a.date).localeCompare(b.kickoffUtc ?? b.date));
}

export function completedLiveFixtures(): Fixture[] {
  return liveFixtures().filter((f) => {
    const status = canonicalizeFixtureStatus(f.status);
    return status === "FINISHED" && f.homeGoals !== null && f.awayGoals !== null;
  });
}

export function postponedLiveFixtures(): Fixture[] {
  return liveFixtures().filter((f) => canonicalizeFixtureStatus(f.status) === "POSTPONED");
}

export function seasonDataVersion(): string {
  return liveCompetitionSeason()?.dataVersion ?? "missing";
}
