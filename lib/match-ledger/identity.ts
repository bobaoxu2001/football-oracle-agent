/**
 * Ledger identity: teams and matches.
 *
 * IDENTITY RULE. A team's slug is assigned ONCE, the first time we see its
 * provider team id, and never changes afterwards. Providers rename clubs
 * ("Deportivo Alavés" → "Alavés"), and a slug derived fresh from the current
 * name on every ingest would silently fork one club into two — breaking match
 * identity, rolling form, and settlement links. The provider's numeric team id
 * is the anchor; the slug is the stable human-readable projection of it.
 *
 * Premier League slugs deliberately defer to the existing club registry so the
 * ledger, the frozen LIVE_OOS tape, the ratings state and settlement all speak
 * the same identity.
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { resolveClubSlug } from "@/lib/competitions/premier-league/clubs";
import type { LedgerTeam } from "./types";

export interface ProviderTeam {
  providerTeamId: string | null;
  name: string;
  shortName?: string | null;
  tla?: string | null;
}

export interface TeamIdentityRecord {
  competition: BigFiveCompetitionId;
  providerTeamId: string;
  slug: string;
  /** Latest observed display name. May change; the slug may not. */
  name: string;
  shortName: string | null;
  tla: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Every display name this provider id has been seen under. */
  observedNames: string[];
}

export type TeamIdentityRegistry = Record<string, TeamIdentityRecord>;

export function identityKey(competition: BigFiveCompetitionId, providerTeamId: string): string {
  return `${competition}::${providerTeamId}`;
}

/** Fold diacritics so "Alavés" and "Alaves" cannot become two clubs. */
function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Corporate/legal noise that carries no identity, stripped only at the token
 * level so "Real Sociedad" and "Real Madrid" stay distinct. Kept deliberately
 * small: over-stripping collides clubs, which is far worse than a long slug.
 */
const NOISE_TOKENS = new Set([
  "fc", "cf", "afc", "sc", "ssc", "ac", "as", "rc", "rcd", "cd", "sd", "ud",
  "sv", "tsv", "vfb", "vfl", "bsc", "fsv", "spvgg", "spvg", "tsg",
  "calcio", "club", "de", "the",
]);

/** Deterministic first-sight slug. Only used when a provider id is unknown. */
export function deriveTeamSlug(name: string): string {
  const base = foldDiacritics(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = base.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => !NOISE_TOKENS.has(t));
  // Never strip everything: "AC Milan" minus noise must not become "".
  const useful = kept.length ? kept : tokens;
  return useful.join("-") || "unknown-team";
}

function uniqueSlug(candidate: string, taken: Set<string>, providerTeamId: string): string {
  if (!taken.has(candidate)) return candidate;
  // Disambiguate with the provider id rather than a counter, so the result is
  // deterministic regardless of ingest order.
  const disambiguated = `${candidate}-${providerTeamId}`;
  return taken.has(disambiguated) ? `${disambiguated}-x` : disambiguated;
}

/**
 * Resolve a provider team into a stable ledger identity, registering it on
 * first sight. Returns the (possibly updated) registry — callers persist it.
 *
 * Pure: no I/O, so identity stability is directly testable.
 */
export function resolveLedgerTeam(
  registry: TeamIdentityRegistry,
  competition: BigFiveCompetitionId,
  team: ProviderTeam,
  observedAt: string
): { team: LedgerTeam; registry: TeamIdentityRegistry; created: boolean } {
  const providerTeamId = team.providerTeamId ?? null;
  const shortName = team.shortName ?? null;
  const tla = team.tla ?? null;

  // Without a provider id there is nothing stable to anchor to; fall back to a
  // deterministic name slug and do NOT pollute the registry with it.
  if (!providerTeamId) {
    const slug = preferredSlug(competition, team.name);
    return {
      team: { slug, providerTeamId: null, name: team.name, shortName, tla },
      registry,
      created: false,
    };
  }

  const key = identityKey(competition, providerTeamId);
  const existing = registry[key];
  if (existing) {
    const observedNames = existing.observedNames.includes(team.name)
      ? existing.observedNames
      : [...existing.observedNames, team.name];
    const next: TeamIdentityRegistry = {
      ...registry,
      [key]: {
        ...existing,
        // Display fields track the provider; the slug never moves.
        name: team.name,
        shortName: shortName ?? existing.shortName,
        tla: tla ?? existing.tla,
        lastSeenAt: observedAt > existing.lastSeenAt ? observedAt : existing.lastSeenAt,
        observedNames,
      },
    };
    return {
      team: { slug: existing.slug, providerTeamId, name: team.name, shortName, tla },
      registry: next,
      created: false,
    };
  }

  const taken = new Set(
    Object.values(registry)
      .filter((r) => r.competition === competition)
      .map((r) => r.slug)
  );
  const slug = uniqueSlug(preferredSlug(competition, team.name), taken, providerTeamId);
  const record: TeamIdentityRecord = {
    competition,
    providerTeamId,
    slug,
    name: team.name,
    shortName,
    tla,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    observedNames: [team.name],
  };
  return {
    team: { slug, providerTeamId, name: team.name, shortName, tla },
    registry: { ...registry, [key]: record },
    created: true,
  };
}

/**
 * Premier League defers to the curated club registry so ledger identity is
 * byte-identical to the identity already used by ratings, the frozen tape and
 * settlement. Other leagues have no curated list and use the derived slug.
 */
function preferredSlug(competition: BigFiveCompetitionId, name: string): string {
  if (competition === "premier-league") {
    const known = resolveClubSlug(name) ?? resolveClubSlug(stripClubSuffixes(name));
    if (known) return known;
  }
  return deriveTeamSlug(name);
}

function stripClubSuffixes(name: string): string {
  return name
    .replace(/\s+Football Club$/i, "")
    .replace(/\s+FC$/i, "")
    .replace(/\s+AFC$/i, "")
    .trim();
}

/**
 * Canonical, provider-independent match id.
 *
 * For the Premier League this is byte-identical to officialFixtureId(), which
 * is what lets a ledger match link to an existing frozen prediction snapshot
 * and settle it. Home/away ordering distinguishes the two legs of a double
 * round-robin, so the pair is unique within a season.
 */
export function canonicalMatchId(
  competition: BigFiveCompetitionId,
  season: string,
  homeSlug: string,
  awaySlug: string
): string {
  const prefix = getCompetition(competition).footballDataCode.toLowerCase();
  return `${prefix}-${season}-${homeSlug}-${awaySlug}`;
}
