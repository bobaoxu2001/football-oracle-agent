/**
 * Durable 2026-27 fixture + season store.
 *
 * Source history is appended (revisions JSONL). The current normalized
 * fixture state is the latest snapshot, never silently rewritten without
 * an audit row when a kickoff or status changes.
 */

import fs from "node:fs";
import path from "node:path";
import type { ClubSeason, CompetitionSeason, Fixture } from "@/lib/identity/types";
import {
  ingestOfficial202627,
  INDEPENDENT_MEMBERSHIP_SOURCES,
  type FixtureRevision,
  type IngestProvenance,
  type IngestResult,
} from "./ingest";
import { applyKickoffCertainty } from "./kickoff-certainty";

const ROOT = path.resolve(process.cwd(), "data/processed/premier-league");

export const SEASON_MANIFEST_PATH = path.join(ROOT, "season-2026-27.json");
export const LIVE_FIXTURES_PATH = path.join(ROOT, "fixtures-2026-27.json");
export const CLUB_SEASONS_PATH = path.join(ROOT, "club-seasons-2026-27.json");
export const REVISIONS_PATH = path.join(ROOT, "fixture-revisions.jsonl");
export const SOURCE_SNAPSHOT_DIR = path.join(ROOT, "source-snapshots");

export interface SeasonBundle {
  season: CompetitionSeason;
  clubSeasons: ClubSeason[];
  fixtures: Fixture[];
  provenance: IngestProvenance;
}

let _bundle: SeasonBundle | null = null;

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function loadSeasonBundle(): SeasonBundle | null {
  if (_bundle) return _bundle;
  const season = readJson<CompetitionSeason>(SEASON_MANIFEST_PATH);
  const fixturesDoc = readJson<{ fixtures: Fixture[]; provenance?: IngestProvenance }>(LIVE_FIXTURES_PATH);
  const clubSeasons = readJson<ClubSeason[]>(CLUB_SEASONS_PATH);
  if (!season || !fixturesDoc || !clubSeasons) return null;
  _bundle = {
    season,
    fixtures: fixturesDoc.fixtures.map(applyKickoffCertainty),
    clubSeasons,
    provenance: fixturesDoc.provenance ?? {
      source: season.source,
      sourceId: season.dataVersion,
      retrievedAt: season.retrievedAt,
      verificationStatus: season.verificationStatus,
      crossChecks: [],
    },
  };
  return _bundle;
}

export function resetSeasonBundleCache(): void {
  _bundle = null;
}

export function liveFixtures(): Fixture[] {
  return loadSeasonBundle()?.fixtures ?? [];
}

export function liveCompetitionSeason(): CompetitionSeason | null {
  return loadSeasonBundle()?.season ?? null;
}

export function liveClubSeasons(): ClubSeason[] {
  return loadSeasonBundle()?.clubSeasons ?? [];
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendRevisions(revisions: FixtureRevision[]): void {
  if (!revisions.length) return;
  fs.mkdirSync(path.dirname(REVISIONS_PATH), { recursive: true });
  const text = revisions.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(REVISIONS_PATH, text, "utf8");
}

export function persistIngest(result: IngestResult): void {
  writeJson(SEASON_MANIFEST_PATH, result.season);
  writeJson(LIVE_FIXTURES_PATH, {
    fixtures: result.fixtures,
    provenance: result.provenance,
    retrievedAt: result.provenance.retrievedAt,
    source: result.provenance.source,
  });
  writeJson(CLUB_SEASONS_PATH, result.clubSeasons);
  appendRevisions(result.revisions);
  fs.mkdirSync(SOURCE_SNAPSHOT_DIR, { recursive: true });
  const stamp = result.provenance.retrievedAt.replace(/[:.]/g, "-");
  writeJson(path.join(SOURCE_SNAPSHOT_DIR, `official-${stamp}.json`), {
    retrievedAt: result.provenance.retrievedAt,
    source: result.provenance.source,
    sourceId: result.provenance.sourceId,
    fixtureCount: result.fixtures.length,
    fixtures: result.fixtures.map((f) => ({
      id: f.id,
      sourceFixtureId: f.sourceFixtureId,
      homeSlug: f.homeSlug,
      awaySlug: f.awaySlug,
      kickoffUtc: f.kickoffUtc,
      status: f.status,
      matchday: f.matchday,
    })),
  });
  _bundle = {
    season: result.season,
    clubSeasons: result.clubSeasons,
    fixtures: result.fixtures,
    provenance: result.provenance,
  };
}

export function persistSeasonBundle(bundle: SeasonBundle): void {
  persistIngest({
    season: bundle.season,
    clubSeasons: bundle.clubSeasons,
    fixtures: bundle.fixtures,
    revisions: [],
    provenance: bundle.provenance,
  });
}

/** Load official CSV, upsert onto any existing store, persist. Idempotent. */
/** Persist kickoff certainty / scheduledDate without rewriting prediction snapshots. */
export function persistKickoffCertaintyEnrichment(): { confirmed: number; provisional: number; default: number; tbd: number } {
  const bundle = loadSeasonBundle();
  if (!bundle) throw new Error("No season bundle to enrich");
  bundle.fixtures = bundle.fixtures.map(applyKickoffCertainty);
  if (!bundle.season.verifiedAgainst) {
    bundle.season.verifiedAgainst = [...INDEPENDENT_MEMBERSHIP_SOURCES];
    bundle.season.verificationArtifact = "docs/PHASE2A_INDEPENDENT_AUDIT.md";
  }
  persistSeasonBundle(bundle);
  const counts = { confirmed: 0, provisional: 0, default: 0, tbd: 0 };
  for (const f of bundle.fixtures) {
    if (f.kickoffCertainty === "CONFIRMED") counts.confirmed += 1;
    else if (f.kickoffCertainty === "PROVISIONAL") counts.provisional += 1;
    else if (f.kickoffCertainty === "DEFAULT") counts.default += 1;
    else counts.tbd += 1;
  }
  return counts;
}

export function ingestAndPersist(retrievedAt?: string): IngestResult {
  const existing = loadSeasonBundle();
  const result = ingestOfficial202627({
    retrievedAt,
    existingFixtures: existing?.fixtures,
  });
  persistIngest(result);
  return result;
}

export function applyFixturePatch(fixtureId: string, patch: Partial<Fixture>, at = new Date().toISOString()): Fixture {
  const bundle = loadSeasonBundle();
  if (!bundle) throw new Error("No season bundle to patch");
  const idx = bundle.fixtures.findIndex((f) => f.id === fixtureId);
  if (idx < 0) throw new Error(`Unknown fixture ${fixtureId}`);
  const prev = bundle.fixtures[idx];
  const next: Fixture = { ...prev, ...patch, id: prev.id, homeSlug: prev.homeSlug, awaySlug: prev.awaySlug };
  const revisions: FixtureRevision[] = [];
  for (const [field, to] of Object.entries(patch)) {
    const from = (prev as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      revisions.push({ fixtureId, at, field, from, to });
    }
  }
  bundle.fixtures[idx] = next;
  persistSeasonBundle(bundle);
  appendRevisions(revisions);
  return next;
}
