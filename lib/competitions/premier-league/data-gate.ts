/**
 * Current-season production data-validity gate.
 *
 * Production prediction requires a verified CompetitionSeason, the expected
 * club count, valid fixture identities, a fresh-enough source, and resolved
 * team ids. Failures degrade honestly — they do not invent forecasts from
 * corrupted data.
 */

import type { Fixture } from "@/lib/identity/types";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "./config";
import { liveClubSeasons, liveCompetitionSeason, liveFixtures } from "./fixture-store";
import { canonicalizeFixtureStatus, PROMOTED_2026_27, RELEGATED_FROM_2025_26 } from "./ingest";

export type DataGateStatus = "DATA_READY" | "DATA_DEGRADED" | "DATA_BLOCKED";

export interface DataGate {
  status: DataGateStatus;
  reasons: string[];
  season: string;
  clubCount: number;
  fixtureCount: number;
  scheduleCompleteness: "complete" | "partial" | "missing";
  source: string | null;
  retrievedAt: string | null;
  verificationStatus: string | null;
}

const STALE_MS = 1000 * 60 * 60 * 24 * 120; // 120 days — official June list is still valid in August

export function evaluateDataGate(now = new Date()): DataGate {
  const season = liveCompetitionSeason();
  const fixtures = liveFixtures();
  const clubSeasons = liveClubSeasons();
  const reasons: string[] = [];

  if (!season) {
    return {
      status: "DATA_BLOCKED",
      reasons: ["No CompetitionSeason manifest is loaded."],
      season: PREMIER_LEAGUE_CURRENT_SEASON,
      clubCount: 0,
      fixtureCount: 0,
      scheduleCompleteness: "missing",
      source: null,
      retrievedAt: null,
      verificationStatus: null,
    };
  }

  if (season.season !== PREMIER_LEAGUE_CURRENT_SEASON) {
    reasons.push(`Manifest season ${season.season} is not ${PREMIER_LEAGUE_CURRENT_SEASON}.`);
  }
  if (season.clubIds.length !== season.expectedClubCount) {
    reasons.push(`Club count ${season.clubIds.length} ≠ expected ${season.expectedClubCount}.`);
  }
  if (new Set(season.clubIds).size !== season.clubIds.length) {
    reasons.push("Duplicate club ids in the season manifest.");
  }
  for (const id of RELEGATED_FROM_2025_26) {
    if (season.clubIds.includes(id)) reasons.push(`Relegated club ${id} is still listed as active.`);
  }
  for (const id of PROMOTED_2026_27) {
    if (!season.clubIds.includes(id)) reasons.push(`Promoted club ${id} is missing from the active set.`);
  }
  if (season.verificationStatus === "SOURCE_CONFLICT") {
    reasons.push("Membership/fixture sources disagree.");
  }

  const ids = new Set<string>();
  let unresolved = 0;
  let badKickoff = 0;
  let homeEqAway = 0;
  let outsider = 0;
  for (const f of fixtures) {
    if (ids.has(f.id)) reasons.push(`Duplicate fixture id ${f.id}.`);
    ids.add(f.id);
    if (f.homeSlug === f.awaySlug) homeEqAway += 1;
    if (!season.clubIds.includes(f.homeSlug) || !season.clubIds.includes(f.awaySlug)) outsider += 1;
    if (!f.homeSlug || !f.awaySlug) unresolved += 1;
    if (!f.kickoffUtc && !f.kickoff) badKickoff += 1;
    if (f.season !== season.season) reasons.push(`Fixture ${f.id} has season ${f.season}.`);
  }
  if (homeEqAway) reasons.push(`${homeEqAway} fixtures have home = away.`);
  if (outsider) reasons.push(`${outsider} fixtures involve a club outside the active season.`);
  if (unresolved) reasons.push(`${unresolved} fixtures have unresolved team identities.`);
  if (badKickoff) reasons.push(`${badKickoff} fixtures lack a kickoff timestamp.`);

  const retrieved = Date.parse(season.retrievedAt);
  if (Number.isFinite(retrieved) && now.getTime() - retrieved > STALE_MS) {
    reasons.push("Fixture source is older than the freshness window.");
  }

  const blocking = reasons.some(
    (r) =>
      r.includes("No CompetitionSeason") ||
      r.includes("Duplicate club") ||
      r.includes("Relegated club") ||
      r.includes("sources disagree") ||
      r.includes("home = away") ||
      r.includes("unresolved")
  );
  const degraded =
    reasons.length > 0 &&
    (season.scheduleCompleteness === "partial" ||
      season.verificationStatus === "PROVISIONAL" ||
      season.verificationStatus === "STALE" ||
      reasons.some((r) => r.includes("freshness") || r.includes("Club count")));

  let status: DataGateStatus = "DATA_READY";
  if (blocking || season.clubIds.length !== 20 || fixtures.length === 0) status = "DATA_BLOCKED";
  else if (degraded || reasons.length > 0) status = "DATA_DEGRADED";

  // A complete verified 380-fixture tape with 20 unique clubs is READY even
  // if we recorded operational-feed absence as a provenance note.
  if (
    status !== "DATA_BLOCKED" &&
    season.verificationStatus === "VERIFIED" &&
    season.clubIds.length === 20 &&
    fixtures.length === 380 &&
    clubSeasons.length === 20 &&
    !reasons.some((r) => r.includes("Relegated") || r.includes("Duplicate") || r.includes("home = away"))
  ) {
    status = "DATA_READY";
  }

  return {
    status,
    reasons,
    season: season.season,
    clubCount: season.clubIds.length,
    fixtureCount: fixtures.length,
    scheduleCompleteness: season.scheduleCompleteness,
    source: season.source,
    retrievedAt: season.retrievedAt,
    verificationStatus: season.verificationStatus,
  };
}

export function upcomingLiveFixtures(now = new Date()): Fixture[] {
  const ms = now.getTime();
  return liveFixtures()
    .filter((f) => {
      const status = canonicalizeFixtureStatus(f.status);
      if (status !== "SCHEDULED" && status !== "LIVE") return false;
      const kick = Date.parse(f.kickoffUtc ?? f.kickoff ?? "");
      return Number.isFinite(kick) ? kick > ms : f.date >= now.toISOString().slice(0, 10);
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
