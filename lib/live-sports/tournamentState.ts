/**
 * Tournament-state orchestrator + DETERMINISTIC elimination gating.
 *
 * Source-of-truth precedence (never the LLM/news):
 *   1. fresh MongoDB cache  → serve it (mode "cache")
 *   2. API-Football (if key) → fetch, normalize, persist (mode "live")
 *   3. stale MongoDB cache   → serve last known (mode "cache")
 *   4. key set but fetch failed & no cache → "unavailable" (never fabricate)
 *   5. no key & no cache     → "demo" (no eliminations, clearly labelled)
 *
 * Caching is aggressive (free-tier friendly). The gating helpers are pure and
 * unit-tested; they override model probabilities for eliminated teams.
 */

import { numberFromEnv } from "@/lib/config/env";
import { getMongoDb } from "@/lib/db/mongodb";
import { getTeam } from "@/lib/seed/world-cup-2026-groups";
import { apiFootballConfigured, fetchFixtures, fetchInjuries } from "./apiFootball";
import { footballDataConfigured, fetchFixturesFD } from "./footballData";
import type {
  LiveFixture,
  LiveInjury,
  TeamState,
  TournamentStateSnapshot,
  TournamentStateView,
} from "./types";

const STATE_COLLECTION = "team_state";
const FIXTURES_COLLECTION = "live_fixtures";
const INJURIES_COLLECTION = "live_injuries";
const SNAPSHOT_ID = "current";

// TTLs (ms). Fixtures/standings refresh faster than injuries.
// Validated: a NaN TTL would make every freshness check false, so nothing
// would ever be served from cache and the rate-limited provider would be hit
// on every request — the exact opposite of what these knobs are for.
const FIXTURES_TTL_MS = numberFromEnv("LIVE_FIXTURES_TTL_MS", 2 * 60 * 60 * 1000); // 2h
const INJURIES_TTL_MS = numberFromEnv("LIVE_INJURIES_TTL_MS", 8 * 60 * 60 * 1000); // 8h

// ---- Pure classification ----------------------------------------------------

const KNOCKOUT_RE = /round of|knockout|quarter|semi|final|1\/8|1\/4|1\/2/i;
const FINISHED = new Set(["FT", "AET", "PEN"]);

/**
 * Classify each team from finished fixtures. CONSERVATIVE by design: a team is
 * only marked "eliminated" on direct evidence — losing a finished KNOCKOUT
 * fixture. (Group-stage elimination depends on best-third maths, so we never
 * infer it here — better "unknown" than a false elimination.)
 */
export function classifyTeams(fixtures: LiveFixture[]): TeamState[] {
  const status = new Map<string, TeamState>();
  const setStatus = (slug: string | null, s: TeamState["status"], detail?: string) => {
    if (!slug) return;
    const prev = status.get(slug);
    // eliminated is sticky and wins over active/qualified/unknown
    if (prev?.status === "eliminated") return;
    status.set(slug, { slug, name: getTeam(slug).name, status: s, detail });
  };

  for (const f of fixtures) {
    const isKnockout = KNOCKOUT_RE.test(f.round);
    const finished = FINISHED.has(f.status);
    if (f.homeSlug) setStatus(f.homeSlug, "active");
    if (f.awaySlug) setStatus(f.awaySlug, "active");
    if (!finished || !isKnockout) continue;

    // Determine the loser of a finished knockout tie.
    let loser: string | null = null;
    let winner: string | null = null;
    if (f.homeWinner === true || f.awayWinner === false) {
      winner = f.homeSlug;
      loser = f.awaySlug;
    } else if (f.awayWinner === true || f.homeWinner === false) {
      winner = f.awaySlug;
      loser = f.homeSlug;
    } else if (typeof f.goalsHome === "number" && typeof f.goalsAway === "number") {
      if (f.goalsHome > f.goalsAway) {
        winner = f.homeSlug;
        loser = f.awaySlug;
      } else if (f.goalsAway > f.goalsHome) {
        winner = f.awaySlug;
        loser = f.homeSlug;
      }
    }
    if (loser) setStatus(loser, "eliminated", `Lost ${f.round}`);
    if (winner) setStatus(winner, "qualified", `Advanced past ${f.round}`);
  }
  return [...status.values()];
}

function snapshotFromTeams(
  teams: TeamState[],
  opts: { mode: TournamentStateSnapshot["mode"]; source: string; confidence: number; ttlMs: number }
): TournamentStateSnapshot {
  const now = Date.now();
  const eliminated = teams.filter((t) => t.status === "eliminated").map((t) => t.slug);
  return {
    mode: opts.mode,
    source: opts.source,
    fetchedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + opts.ttlMs).toISOString(),
    confidence: opts.confidence,
    teams,
    eliminatedSlugs: eliminated,
    eliminatedCount: eliminated.length,
  };
}

export function demoSnapshot(): TournamentStateSnapshot {
  return {
    mode: "demo",
    source: "demo",
    fetchedAt: null,
    expiresAt: null,
    confidence: 0,
    teams: [],
    eliminatedSlugs: [],
    eliminatedCount: 0,
  };
}

/**
 * Whether ANY live tournament-state provider is configured.
 * Priority when both are set: API-Football (richer: injuries), else
 * football-data.org (fixtures/results — all that elimination gating needs).
 */
export function liveProviderConfigured(): boolean {
  return apiFootballConfigured() || footballDataConfigured();
}

function liveProviderName(): string {
  if (apiFootballConfigured()) return "API-Football";
  if (footballDataConfigured()) return "football-data.org";
  return "none";
}

export function unavailableSnapshot(): TournamentStateSnapshot {
  return {
    mode: "unavailable",
    source: "Live API (unreachable)",
    fetchedAt: null,
    expiresAt: null,
    confidence: 0,
    teams: [],
    eliminatedSlugs: [],
    eliminatedCount: 0,
  };
}

/**
 * Pure decision of which snapshot to serve, given inputs. Encodes the precedence
 * above so it can be unit-tested without a DB or network.
 */
export function decideSnapshot(opts: {
  cache: TournamentStateSnapshot | null;
  cacheFresh: boolean;
  live: TournamentStateSnapshot | null;
  apiConfigured: boolean;
}): TournamentStateSnapshot {
  const { cache, cacheFresh, live, apiConfigured } = opts;
  if (cache && cacheFresh) return { ...cache, mode: "cache", source: "MongoDB cache" };
  if (apiConfigured && live) return live;
  if (cache) return { ...cache, mode: "cache", source: "MongoDB cache" }; // stale fallback
  if (apiConfigured) return unavailableSnapshot(); // key set, fetch failed, no cache
  return demoSnapshot(); // no key, no cache
}

// ---- Pure gating (overrides model probabilities) ----------------------------

export function eliminatedSet(state: TournamentStateSnapshot): Set<string> {
  return new Set(state.eliminatedSlugs);
}

export function isEliminated(slug: string, state: TournamentStateSnapshot): boolean {
  return state.eliminatedSlugs.includes(slug);
}

/**
 * Remove eliminated teams from a champion-candidate list (their champion
 * probability is effectively 0). Deterministic — never overridden by the LLM.
 */
export function gateChampionOdds<T extends { slug: string }>(
  champions: T[],
  state: TournamentStateSnapshot
): { champions: T[]; removed: string[] } {
  const elim = eliminatedSet(state);
  if (elim.size === 0) return { champions, removed: [] };
  const removed: string[] = [];
  const kept = champions.filter((c) => {
    if (elim.has(c.slug)) {
      removed.push(c.slug);
      return false;
    }
    return true;
  });
  return { champions: kept, removed };
}

/** Deterministic answer when a user asks if an eliminated team can still win. */
export function eliminationNotice(
  slug: string,
  state: TournamentStateSnapshot,
  lang: string
): string | null {
  if (!isEliminated(slug, state)) return null;
  const name = getTeam(slug).name;
  const t = state.teams.find((x) => x.slug === slug);
  const reason = t?.detail ? ` (${t.detail})` : "";
  if (lang === "zh-CN") {
    return `不行 —— 根据最新的赛事状态，${name} 已经被淘汰${reason}，无法再夺冠。`;
  }
  return `No — ${name} has already been eliminated based on the latest tournament state${reason}, so it can no longer win the tournament.`;
}

export function toView(state: TournamentStateSnapshot): TournamentStateView {
  return {
    mode: state.mode,
    source: state.source,
    fetchedAt: state.fetchedAt,
    eliminatedCount: state.eliminatedCount,
    confidence: state.confidence,
  };
}

// ---- MongoDB cache + orchestration -----------------------------------------

const __gs = globalThis as unknown as { __wcoaState?: TournamentStateSnapshot | null };

async function readCache(): Promise<TournamentStateSnapshot | null> {
  const db = await getMongoDb();
  if (!db) return __gs.__wcoaState ?? null; // in-memory fallback when no Mongo
  try {
    const doc = await db
      .collection<TournamentStateSnapshot & { _id: string }>(STATE_COLLECTION)
      .findOne({ _id: SNAPSHOT_ID });
    if (!doc) return null;
    const { _id, ...snap } = doc;
    void _id;
    return snap;
  } catch {
    return __gs.__wcoaState ?? null;
  }
}

/**
 * Read-only accessor for cached live fixtures (football-data.org), for the
 * Schedule page. NEVER calls the API — it only returns what a prior refresh
 * already stored in MongoDB, so it's safe to call on every page load.
 */
export async function getCachedFixtures(): Promise<{ fixtures: LiveFixture[]; fetchedAt: string | null }> {
  const db = await getMongoDb();
  if (!db) return { fixtures: [], fetchedAt: null };
  try {
    const doc = await db
      .collection<{ _id: string; fixtures?: LiveFixture[]; fetchedAt?: string }>(FIXTURES_COLLECTION)
      .findOne({ _id: SNAPSHOT_ID });
    return { fixtures: doc?.fixtures ?? [], fetchedAt: doc?.fetchedAt ?? null };
  } catch {
    return { fixtures: [], fetchedAt: null };
  }
}

async function writeCache(
  snap: TournamentStateSnapshot,
  fixtures: LiveFixture[],
  injuries: LiveInjury[]
): Promise<void> {
  __gs.__wcoaState = snap;
  const db = await getMongoDb();
  if (!db) return;
  const col = (name: string) => db.collection<{ _id: string } & Record<string, unknown>>(name);
  try {
    await col(STATE_COLLECTION).replaceOne({ _id: SNAPSHOT_ID }, { ...snap }, { upsert: true });
    if (fixtures.length) {
      await col(FIXTURES_COLLECTION).replaceOne(
        { _id: SNAPSHOT_ID },
        { fixtures, fetchedAt: snap.fetchedAt },
        { upsert: true }
      );
    }
    if (injuries.length) {
      await col(INJURIES_COLLECTION).replaceOne(
        { _id: SNAPSHOT_ID },
        { injuries, fetchedAt: snap.fetchedAt },
        { upsert: true }
      );
    }
  } catch (err) {
    console.warn("[tournament-state] cache write failed:", (err as Error)?.message);
  }
}

function isFresh(snap: TournamentStateSnapshot | null): boolean {
  if (!snap?.expiresAt) return false;
  return Date.parse(snap.expiresAt) > Date.now();
}

/**
 * Get the current tournament state (cached, fail-soft). Safe to call on every
 * request — only hits the API when the cache is stale and a key is configured.
 */
export async function getTournamentState(): Promise<TournamentStateSnapshot> {
  const cache = await readCache();
  const cacheFresh = isFresh(cache);
  if (cache && cacheFresh) return decideSnapshot({ cache, cacheFresh, live: null, apiConfigured: liveProviderConfigured() });

  let live: TournamentStateSnapshot | null = null;
  let fixtures: LiveFixture[] = [];
  let injuries: LiveInjury[] = [];
  if (liveProviderConfigured()) {
    // Provider seam: API-Football preferred (has injuries), else football-data.org
    // (fixtures/results only — injuries stay news-context).
    const useApiFootball = apiFootballConfigured();
    const fx = useApiFootball ? await fetchFixtures() : await fetchFixturesFD();
    if (fx) {
      fixtures = fx;
      injuries = useApiFootball ? (await fetchInjuries()) ?? [] : [];
      const teams = classifyTeams(fx);
      live = snapshotFromTeams(teams, {
        mode: "live",
        source: liveProviderName(),
        confidence: 0.9,
        ttlMs: Math.min(FIXTURES_TTL_MS, INJURIES_TTL_MS),
      });
    }
  }

  const chosen = decideSnapshot({ cache, cacheFresh, live, apiConfigured: liveProviderConfigured() });
  if (live && chosen.mode === "live") await writeCache(live, fixtures, injuries);
  return chosen;
}
