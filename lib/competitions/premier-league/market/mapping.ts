/**
 * External odds events → canonical Premier League fixture IDs.
 * Home/away identity is unique per season, so a kickoff change is a
 * reschedule, not a new fixture.
 */

import type { Fixture } from "@/lib/identity/types";
import { officialFixtureId } from "../ingest";
import { resolvePlClub } from "../ops/sources";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import type { MarketEventMapping, MarketMappingStatus, MarketSourceEvent } from "./types";

const KICKOFF_SANITY_MS = 14 * 24 * 60 * 60 * 1000;

export function mappingIdOf(source: string, sourceEventId: string): string {
  return `${source}::${sourceEventId}`;
}

export function mapMarketEvent(
  event: MarketSourceEvent,
  fixtures: Fixture[],
  nowIso: string,
  prior: MarketEventMapping | null
): MarketEventMapping {
  const homeSlug = resolvePlClub(event.homeTeam);
  const awaySlug = resolvePlClub(event.awayTeam);
  const base = {
    mappingId: mappingIdOf(event.source, event.sourceEventId),
    source: event.source,
    sourceEventId: event.sourceEventId,
    mappedAt: nowIso,
    sourceHome: event.homeTeam,
    sourceAway: event.awayTeam,
    sourceCommenceTime: event.commenceTime,
    resolvedHomeSlug: homeSlug,
    resolvedAwaySlug: awaySlug,
  };

  if (prior && prior.mappingStatus === "MATCHED" && prior.canonicalFixtureId) {
    return {
      ...base,
      canonicalFixtureId: prior.canonicalFixtureId,
      mappingStatus: "MATCHED",
      mappingEvidence: `retained prior MATCHED mapping ${prior.canonicalFixtureId} after commence_time ${prior.sourceCommenceTime} → ${event.commenceTime}`,
    };
  }

  if (!homeSlug || !awaySlug) {
    return {
      ...base,
      canonicalFixtureId: null,
      mappingStatus: "UNMATCHED",
      mappingEvidence: `unresolved team(s): home=${event.homeTeam}→${homeSlug ?? "null"} away=${event.awayTeam}→${awaySlug ?? "null"}`,
    };
  }

  const canonical = officialFixtureId(homeSlug, awaySlug, PREMIER_LEAGUE_CURRENT_SEASON);
  const matches = fixtures.filter((f) => f.homeSlug === homeSlug && f.awaySlug === awaySlug);
  if (matches.length > 1) {
    return {
      ...base,
      canonicalFixtureId: null,
      mappingStatus: "AMBIGUOUS",
      mappingEvidence: `multiple live fixtures for ${homeSlug} vs ${awaySlug}: ${matches.map((f) => f.id).join(",")}`,
    };
  }

  const fixture = matches[0] ?? fixtures.find((f) => f.id === canonical) ?? null;
  if (!fixture) {
    return {
      ...base,
      canonicalFixtureId: null,
      mappingStatus: "UNMATCHED",
      mappingEvidence: `no live fixture ${canonical}`,
    };
  }

  if (prior && prior.mappingStatus === "MATCHED" && prior.canonicalFixtureId && prior.canonicalFixtureId !== fixture.id) {
    return {
      ...base,
      canonicalFixtureId: null,
      mappingStatus: "CONFLICT",
      mappingEvidence: `source event previously mapped to ${prior.canonicalFixtureId}, now resolves to ${fixture.id}`,
    };
  }

  const kick = fixture.kickoffUtc ?? fixture.kickoff ?? null;
  let evidence = `teams ${event.homeTeam}/${event.awayTeam} → ${homeSlug}/${awaySlug} → ${fixture.id}`;
  if (event.commenceTime && kick) {
    const delta = Math.abs(Date.parse(event.commenceTime) - Date.parse(kick));
    if (Number.isFinite(delta) && delta > KICKOFF_SANITY_MS) {
      evidence += `; kickoff drifted ${Math.round(delta / 3600000)}h (treated as reschedule, identity kept)`;
    }
  }

  return {
    ...base,
    canonicalFixtureId: fixture.id,
    mappingStatus: "MATCHED" satisfies MarketMappingStatus,
    mappingEvidence: evidence,
  };
}
