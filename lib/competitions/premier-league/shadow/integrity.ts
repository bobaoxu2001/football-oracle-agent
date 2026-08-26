/**
 * Shadow collection integrity.
 *
 * These checks are the measurement contract, not a UI helper. A collection
 * that fails them is not evidence, regardless of how many rows it has.
 *
 * Frozen pair  = both models frozen at the same (fixture, stage, asOf), asOf < kickoff.
 * Settled pair = both models scored against the same result at that identity.
 * Paired evidence = settled pair that still resolves to its frozen snapshots
 *   and passes the unit-simplex / cutoff checks. Unsettled frozen pairs are
 *   NOT evidence.
 */

import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { loadSettlements, type SettlementRecord } from "../settlement";
import { listJobs } from "../ops/job-ledger";
import { TIMED_STAGES, type PredictionJob } from "../ops/types";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import {
  canonicalizePredictionStage,
  parseSnapshotUniqueKey,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import { pairSettlements } from "@/lib/evaluation/paired";
import { SHADOW_MODEL_VERSION } from "./track";

export type IntegrityIssueCode =
  | "shadow-without-baseline"
  | "cutoff-mismatch"
  | "duplicate-identity"
  | "multiple-cutoffs-for-stage"
  | "settled-missing-snapshot"
  | "probabilities-not-unit"
  | "identity-fields-diverge"
  | "evaluation-before-cutoff"
  | "post-cutoff-freeze"
  | "model-version-mutated"
  | "missed-shadow-freeze-window";

export interface IntegrityIssue {
  code: IntegrityIssueCode;
  message: string;
  fixtureId?: string;
  modelVersion?: string;
  predictionStage?: string;
}

export interface ShadowIntegrityReport {
  ok: boolean;
  issues: IntegrityIssue[];
  /** Both models frozen at the same fixture/stage/asOf, asOf strictly before kickoff. */
  frozenSnapshotPairs: number;
  /** Settlements that pair at the same cutoff and the same actual result. */
  settledSnapshotPairs: number;
  /** Settled forecast-snapshot pair rows resolving to immutable freezes. Not independent N. */
  resolvedPairedSettlementRows: number;
  unpairedBaseline: number;
  /** Shadow snapshots with no baseline at the same cutoff. */
  orphanShadowSnapshots: number;
  /** Shadow settlements with no baseline settlement at the same stage. */
  orphanShadowSettlements: number;
  cutoffMismatches: number;
  duplicateIdentities: number;
  multipleCutoffs: number;
  /**
   * Timed freeze windows that closed without a same-cutoff baseline+shadow pair.
   * Reported, never backfilled.
   */
  missedShadowFreezeWindows: number;
}

const UNIT_EPS = 1e-6;

function stageOf(s: PredictionSnapshot): string {
  return String(canonicalizePredictionStage(s.predictionStage));
}

function pairId(s: { fixtureId: string; predictionStage?: string; asOf: string }): string {
  return `${s.fixtureId}::${String(s.predictionStage)}::${s.asOf}`;
}

function sumsToOne(h: number, d: number, a: number): boolean {
  return Math.abs(h + d + a - 1) <= UNIT_EPS;
}

function kickoffOf(s: PredictionSnapshot): string | null {
  return s.kickoff ?? null;
}

export function auditShadowIntegrity(input: {
  snapshots?: PredictionSnapshot[];
  settlements?: SettlementRecord[];
  jobs?: PredictionJob[];
  now?: string;
  season?: string;
  baselineVersion?: string;
  shadowVersion?: string;
} = {}): ShadowIntegrityReport {
  const season = input.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const baselineVersion = input.baselineVersion ?? PRODUCTION_MODEL_VERSION;
  const shadowVersion = input.shadowVersion ?? SHADOW_MODEL_VERSION;
  const snapshots = (
    input.snapshots ??
    listLiveSnapshots({ season })
  ).filter((s) => !season || s.season === season);
  const settlements = (
    input.settlements ?? loadSettlements()
  ).filter((s) => !season || s.season === season);

  const issues: IntegrityIssue[] = [];

  const byIdentity = new Map<string, PredictionSnapshot[]>();
  for (const s of snapshots) {
    const id = s.provenance?.uniqueKey;
    if (!id) continue;
    const list = byIdentity.get(id) ?? [];
    list.push(s);
    byIdentity.set(id, list);
  }
  let duplicateIdentities = 0;
  for (const [id, rows] of byIdentity) {
    if (rows.length <= 1) continue;
    duplicateIdentities += 1;
    const first = rows[0];
    const disagree = rows.some(
      (r) =>
        r.homeProbability !== first.homeProbability ||
        r.drawProbability !== first.drawProbability ||
        r.awayProbability !== first.awayProbability ||
        r.modelVersion !== first.modelVersion
    );
    if (disagree) {
      issues.push({
        code: "duplicate-identity",
        message: `Duplicate uniqueKey ${id} with disagreeing frozen probabilities.`,
        fixtureId: first.fixtureId,
        modelVersion: first.modelVersion,
        predictionStage: stageOf(first),
      });
    }
  }

  for (const s of snapshots) {
    const parsed = parseSnapshotUniqueKey(s.provenance?.uniqueKey ?? "");
    if (parsed) {
      if (parsed.modelVersion !== s.modelVersion) {
        issues.push({
          code: "model-version-mutated",
          message: `Snapshot uniqueKey version ${parsed.modelVersion} disagrees with body ${s.modelVersion}.`,
          fixtureId: s.fixtureId,
          modelVersion: s.modelVersion,
        });
      }
      if (parsed.fixtureId !== s.fixtureId || parsed.asOf !== s.asOf) {
        issues.push({
          code: "identity-fields-diverge",
          message: `Snapshot uniqueKey fields do not match body for ${s.fixtureId}.`,
          fixtureId: s.fixtureId,
          modelVersion: s.modelVersion,
        });
      }
    }
    if (!sumsToOne(s.homeProbability, s.drawProbability, s.awayProbability)) {
      issues.push({
        code: "probabilities-not-unit",
        message: `Probabilities do not sum to 1 for ${s.fixtureId} ${s.modelVersion} (${s.homeProbability + s.drawProbability + s.awayProbability}).`,
        fixtureId: s.fixtureId,
        modelVersion: s.modelVersion,
        predictionStage: stageOf(s),
      });
    }
    const kickoff = kickoffOf(s);
    if (kickoff && Date.parse(s.asOf) >= Date.parse(kickoff)) {
      issues.push({
        code: "post-cutoff-freeze",
        message: `asOf ${s.asOf} is not strictly before kickoff ${kickoff}.`,
        fixtureId: s.fixtureId,
        modelVersion: s.modelVersion,
        predictionStage: stageOf(s),
      });
    }
    const computedAt = (s.sourceState as { computedAt?: string } | undefined)?.computedAt;
    if (computedAt && kickoff && Date.parse(computedAt) >= Date.parse(kickoff)) {
      issues.push({
        code: "post-cutoff-freeze",
        message: `computedAt ${computedAt} is not strictly before kickoff ${kickoff}.`,
        fixtureId: s.fixtureId,
        modelVersion: s.modelVersion,
        predictionStage: stageOf(s),
      });
    }
  }

  const baseline = snapshots.filter((s) => s.modelVersion === baselineVersion);
  const shadow = snapshots.filter((s) => s.modelVersion === shadowVersion);
  const baselineIds = new Set(baseline.map((s) => pairId({ fixtureId: s.fixtureId, predictionStage: stageOf(s), asOf: s.asOf })));

  let frozenSnapshotPairs = 0;
  let orphanShadow = 0;
  for (const s of shadow) {
    const id = pairId({ fixtureId: s.fixtureId, predictionStage: stageOf(s), asOf: s.asOf });
    if (baselineIds.has(id)) {
      const kickoff = kickoffOf(s);
      if (!kickoff || Date.parse(s.asOf) < Date.parse(kickoff)) frozenSnapshotPairs += 1;
    } else {
      orphanShadow += 1;
      issues.push({
        code: "shadow-without-baseline",
        message: `Shadow snapshot ${id} has no baseline at the same cutoff.`,
        fixtureId: s.fixtureId,
        modelVersion: s.modelVersion,
        predictionStage: stageOf(s),
      });
    }
  }

  const stageSeen = new Map<string, Set<string>>();
  for (const s of snapshots) {
    if (s.modelVersion !== baselineVersion && s.modelVersion !== shadowVersion) continue;
    const k = `${s.fixtureId}::${stageOf(s)}::${s.modelVersion}`;
    const set = stageSeen.get(k) ?? new Set();
    set.add(s.asOf);
    stageSeen.set(k, set);
  }
  let multipleCutoffs = 0;
  for (const [k, asOfs] of stageSeen) {
    if (asOfs.size <= 1) continue;
    multipleCutoffs += 1;
    const [fixtureId, predictionStage, modelVersion] = k.split("::");
    issues.push({
      code: "multiple-cutoffs-for-stage",
      message: `${modelVersion} has ${asOfs.size} asOf values for ${fixtureId} ${predictionStage}.`,
      fixtureId,
      modelVersion,
      predictionStage,
    });
  }

  const pairing = pairSettlements({
    settlements,
    baselineVersion,
    shadowVersion,
    season,
  });
  if (pairing.cutoffMismatch > 0) {
    issues.push({
      code: "cutoff-mismatch",
      message: `${pairing.cutoffMismatch} settled fixture-stage(s) have both models but disagree on freeze cutoff.`,
    });
  }

  const snapByKey = new Map<string, PredictionSnapshot>();
  for (const s of snapshots) {
    const k = s.provenance?.uniqueKey;
    if (k && !snapByKey.has(k)) snapByKey.set(k, s);
  }

  let resolvedPairedSettlementRows = 0;
  for (const p of pairing.pairs) {
    const bKey = settlements.find(
      (s) =>
        s.fixtureId === p.fixtureId &&
        String(s.predictionStage) === p.predictionStage &&
        s.modelVersion === baselineVersion &&
        parseSnapshotUniqueKey(s.snapshotUniqueKey)?.asOf === p.asOf
    )?.snapshotUniqueKey;
    const sKey = settlements.find(
      (s) =>
        s.fixtureId === p.fixtureId &&
        String(s.predictionStage) === p.predictionStage &&
        s.modelVersion === shadowVersion &&
        parseSnapshotUniqueKey(s.snapshotUniqueKey)?.asOf === p.asOf
    )?.snapshotUniqueKey;
    const bSnap = bKey ? snapByKey.get(bKey) : undefined;
    const sSnap = sKey ? snapByKey.get(sKey) : undefined;
    if (!bSnap || !sSnap) {
      issues.push({
        code: "settled-missing-snapshot",
        message: `Settled pair ${p.fixtureId} ${p.predictionStage} references a missing frozen snapshot.`,
        fixtureId: p.fixtureId,
        predictionStage: p.predictionStage,
      });
      continue;
    }
    if (Date.parse(p.settledAt) < Date.parse(p.asOf)) {
      issues.push({
        code: "evaluation-before-cutoff",
        message: `Settlement ${p.settledAt} predates freeze cutoff ${p.asOf}.`,
        fixtureId: p.fixtureId,
        predictionStage: p.predictionStage,
      });
      continue;
    }
    resolvedPairedSettlementRows += 1;
  }

  const pairIds = new Set<string>();
  for (const s of snapshots) {
    if (s.modelVersion !== shadowVersion) continue;
    pairIds.add(pairId({ fixtureId: s.fixtureId, predictionStage: stageOf(s), asOf: s.asOf }));
  }
  let missedShadowFreezeWindows = 0;
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const jobs: PredictionJob[] = input.jobs ?? (() => {
    try {
      return listJobs();
    } catch {
      return [];
    }
  })();
  const timed = new Set<string>(TIMED_STAGES);
  for (const job of jobs) {
    if (job.season && job.season !== season) continue;
    if (!timed.has(job.stage)) continue;
    if (job.status === "CANCELLED" || job.status === "BLOCKED") continue;
    const until = Date.parse(job.eligibleUntil);
    const kickoff = Date.parse(job.kickoffUtc);
    const windowClosed =
      (Number.isFinite(until) && nowMs >= until) || (Number.isFinite(kickoff) && nowMs >= kickoff);
    if (!windowClosed) continue;
    const shadowId = `${job.fixtureId}::${job.stage}::${job.plannedAsOf}`;
    if (pairIds.has(shadowId)) continue;
    missedShadowFreezeWindows += 1;
    issues.push({
      code: "missed-shadow-freeze-window",
      message:
        `MISSED_SHADOW_FREEZE_WINDOW: ${job.fixtureId} ${job.stage} closed at ${job.eligibleUntil} ` +
        `with no same-cutoff shadow pair. Not backfilled.`,
      fixtureId: job.fixtureId,
      predictionStage: job.stage,
    });
  }

  const failCodes = new Set<IntegrityIssueCode>([
    "shadow-without-baseline",
    "cutoff-mismatch",
    "duplicate-identity",
    "settled-missing-snapshot",
    "probabilities-not-unit",
    "identity-fields-diverge",
    "evaluation-before-cutoff",
    "post-cutoff-freeze",
    "model-version-mutated",
  ]);

  return {
    ok: issues.every((i) => !failCodes.has(i.code)),
    issues,
    frozenSnapshotPairs,
    settledSnapshotPairs: pairing.pairs.length,
    resolvedPairedSettlementRows,
    unpairedBaseline: pairing.baselineOnly,
    orphanShadowSnapshots: orphanShadow,
    orphanShadowSettlements: pairing.shadowOnly,
    cutoffMismatches: pairing.cutoffMismatch,
    missedShadowFreezeWindows,
    duplicateIdentities,
    multipleCutoffs,
  };
}
