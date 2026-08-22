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
import { brier3, rps3 } from "@/lib/evaluation/metrics";
import type { Outcome } from "@/lib/evaluation/types";
import { canonicalizeFixtureStatus } from "./ingest";
import { listLiveSnapshots } from "./ops/live-snapshot-reader";

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
  topPickCorrect: boolean;
  resultSource?: string;
  verificationId?: string;
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
  if (
    status === "POSTPONED" ||
    status === "CANCELLED" ||
    status === "SUSPENDED" ||
    status === "LIVE" ||
    status === "ABANDONED"
  ) {
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
  const top: Outcome =
    home >= draw && home >= away ? "home" : away >= draw ? "away" : "draw";
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
    topPickCorrect: top === actual,
    resultSource: fixture.resultSource ?? fixture.source,
  };
}

/**
 * Load settled rows, first-write-wins per snapshot key.
 *
 * A torn or truncated append (crash mid-write) must not take the whole ledger
 * — and therefore /live, /api/live and the ops tick — offline, so a corrupt
 * line is skipped and reported, matching every other JSONL reader in the repo.
 */
export function loadSettlements(): SettlementRecord[] {
  const file = storePath();
  if (!fs.existsSync(file)) return [];
  const out: SettlementRecord[] = [];
  const seen = new Set<string>();
  let corrupt = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: SettlementRecord;
    try {
      rec = JSON.parse(line) as SettlementRecord;
    } catch {
      corrupt += 1;
      continue;
    }
    if (!rec?.snapshotUniqueKey) {
      corrupt += 1;
      continue;
    }
    if (seen.has(rec.snapshotUniqueKey)) continue;
    seen.add(rec.snapshotUniqueKey);
    out.push(rec);
  }
  if (corrupt) {
    console.warn(`[settlement] skipped ${corrupt} unreadable line(s) in ${file}`);
  }
  return out;
}

function appendSettlement(rec: SettlementRecord): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
}

export function persistSettlement(rec: SettlementRecord): SettlementRecord {
  const existing = loadSettlements();
  const prior = existing.find((e) => e.snapshotUniqueKey === rec.snapshotUniqueKey);
  if (prior) return prior;
  appendSettlement(rec);
  return rec;
}

export function settleFixture(
  fixture: Fixture,
  settledAt = new Date().toISOString(),
  options: { evaluationClass?: EvaluationClass; verificationId?: string } = {}
): SettlementRecord[] {
  if (!canSettle(fixture)) return [];
  const snaps = listLiveSnapshots({
    fixtureId: fixture.id,
    season: fixture.season,
    evaluationClass: options.evaluationClass,
  });
  // Read the ledger ONCE per fixture. Settling a fixture writes one row per
  // frozen stage, so re-reading the whole file per row was quadratic in the
  // size of a ledger that only ever grows.
  const byKey = new Map(loadSettlements().map((e) => [e.snapshotUniqueKey, e]));
  const written: SettlementRecord[] = [];
  for (const snap of snaps) {
    const rec = settlementFromSnapshot(snap, fixture, settledAt);
    if (options.verificationId) rec.verificationId = options.verificationId;
    const prior = byKey.get(rec.snapshotUniqueKey);
    if (prior) {
      written.push(prior);
      continue;
    }
    appendSettlement(rec);
    byKey.set(rec.snapshotUniqueKey, rec);
    written.push(rec);
  }
  return written;
}

export function clearSettlementsForTests(): void {
  const file = storePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
