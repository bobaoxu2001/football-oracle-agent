/**
 * Settlement connects a finished, verified result to frozen snapshots.
 *
 * The original probabilities are never modified. Evaluation lives here.
 * Postponed / cancelled / suspended fixtures are not settled as wins/losses.
 */

import fs from "node:fs";
import path from "node:path";
import type { Fixture } from "@/lib/identity/types";
import type { EvaluationClass, PredictionSnapshot } from "@/lib/snapshots/types";
import { listSnapshots } from "@/lib/snapshots/store";
import { brier3, rps3 } from "@/lib/evaluation/metrics";
import type { Outcome } from "@/lib/evaluation/types";
import { canonicalizeFixtureStatus } from "./ingest";

export interface SettlementRecord {
  snapshotUniqueKey: string;
  fixtureId: string;
  season: string;
  modelVersion: string;
  predictionStage: string;
  evaluationClass: EvaluationClass | "UNKNOWN";
  settledAt: string;
  actualOutcome: Outcome;
  actualScore: { home: number; away: number };
  predicted: { home: number; draw: number; away: number };
  brier: number;
  rps: number;
  logLoss: number;
  resultSource?: string;
}

const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "data/processed/premier-league/settlements.jsonl"
);

function storePath(): string {
  return process.env.SETTLEMENT_STORE_PATH || DEFAULT_PATH;
}

export function canSettle(fixture: Fixture): boolean {
  const status = canonicalizeFixtureStatus(fixture.status);
  if (status === "POSTPONED" || status === "CANCELLED" || status === "SUSPENDED" || status === "LIVE") {
    return false;
  }
  return status === "FINISHED" && fixture.homeGoals !== null && fixture.awayGoals !== null;
}

function outcomeOf(hg: number, ag: number): Outcome {
  return hg > ag ? "home" : hg < ag ? "away" : "draw";
}

export function settlementFromSnapshot(
  snap: PredictionSnapshot,
  fixture: Fixture,
  settledAt = new Date().toISOString()
): SettlementRecord {
  if (!canSettle(fixture)) {
    throw new Error(`Fixture ${fixture.id} is not settleable (status=${fixture.status})`);
  }
  const hg = fixture.homeGoals as number;
  const ag = fixture.awayGoals as number;
  const actual = outcomeOf(hg, ag);
  const home = snap.homeProbability;
  const draw = snap.drawProbability;
  const away = snap.awayProbability;
  const pActual = actual === "home" ? home : actual === "draw" ? draw : away;
  return {
    snapshotUniqueKey: snap.provenance.uniqueKey,
    fixtureId: fixture.id,
    season: snap.season,
    modelVersion: snap.modelVersion,
    predictionStage: String(snap.predictionStage),
    evaluationClass: snap.evaluationClass ?? "UNKNOWN",
    settledAt,
    actualOutcome: actual,
    actualScore: { home: hg, away: ag },
    predicted: { home, draw, away },
    brier: brier3(home, draw, away, actual),
    rps: rps3(home, draw, away, actual),
    logLoss: -Math.log(Math.max(1e-12, pActual)),
    resultSource: fixture.resultSource ?? fixture.source,
  };
}

export function loadSettlements(): SettlementRecord[] {
  const file = storePath();
  if (!fs.existsSync(file)) return [];
  const out: SettlementRecord[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as SettlementRecord;
    if (seen.has(rec.snapshotUniqueKey)) continue;
    seen.add(rec.snapshotUniqueKey);
    out.push(rec);
  }
  return out;
}

export function persistSettlement(rec: SettlementRecord): SettlementRecord {
  const existing = loadSettlements();
  if (existing.some((e) => e.snapshotUniqueKey === rec.snapshotUniqueKey)) {
    return existing.find((e) => e.snapshotUniqueKey === rec.snapshotUniqueKey)!;
  }
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
  return rec;
}

export function settleFixture(fixture: Fixture, settledAt = new Date().toISOString()): SettlementRecord[] {
  if (!canSettle(fixture)) return [];
  const snaps = listSnapshots().filter((s) => s.fixtureId === fixture.id && s.season === fixture.season);
  const written: SettlementRecord[] = [];
  for (const snap of snaps) {
    written.push(persistSettlement(settlementFromSnapshot(snap, fixture, settledAt)));
  }
  return written;
}

export function clearSettlementsForTests(): void {
  const file = storePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
