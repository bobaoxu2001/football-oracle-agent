/**
 * Immutable season-simulation snapshots.
 *
 * A historical simulation must not later silently incorporate newer results.
 */

import fs from "node:fs";
import path from "node:path";
import type { LeagueSimulationResult } from "./simulate";
import { simulateLeagueSeason } from "./simulate";
import { remainingPremierLeagueFixtures } from "./season";
import { ratingsAsOf } from "./ratings";
import { seasonDataVersion } from "./data-gate";
import { PRODUCTION_MODEL_VERSION } from "./model-tracks";

export interface SeasonSimSnapshot extends LeagueSimulationResult {
  uniqueKey: string;
}

const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "data/processed/premier-league/season-simulations.jsonl"
);

function storePath(): string {
  return process.env.SEASON_SIM_STORE_PATH || DEFAULT_PATH;
}

export function simulationKey(s: {
  simulationAsOf: string;
  modelVersion: string;
  seasonDataVersion: string;
  completedFixturesIncluded: number;
}): string {
  return [s.modelVersion, s.seasonDataVersion, s.simulationAsOf, String(s.completedFixturesIncluded)].join("::");
}

export function persistSeasonSimulation(sim: LeagueSimulationResult): SeasonSimSnapshot {
  const uniqueKey = simulationKey(sim);
  const file = storePath();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const prev = JSON.parse(line) as SeasonSimSnapshot;
      if (prev.uniqueKey === uniqueKey) return prev;
    }
  }
  const snap: SeasonSimSnapshot = { ...sim, uniqueKey };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(snap)}\n`, "utf8");
  return snap;
}

export function runAndPersistCurrentSeasonSimulation(options: {
  asOf?: string;
  sims?: number;
} = {}): SeasonSimSnapshot {
  const asOf = options.asOf ?? new Date().toISOString();
  const field = remainingPremierLeagueFixtures();
  const ratings = ratingsAsOf(asOf.slice(0, 10)).ratings;
  const sim = simulateLeagueSeason({
    ratings,
    played: field.played,
    remaining: field.remaining,
    clubSlugs: field.clubSlugs,
    sims: options.sims ?? 4000,
    simulationAsOf: asOf,
    seasonDataVersion: seasonDataVersion(),
  });
  if (sim.modelVersion !== PRODUCTION_MODEL_VERSION) {
    // Production track is required for the live 2026-27 board.
  }
  return persistSeasonSimulation(sim);
}

export function loadSeasonSimulations(): SeasonSimSnapshot[] {
  const file = storePath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SeasonSimSnapshot);
}
