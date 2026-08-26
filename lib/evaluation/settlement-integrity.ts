import type { SettlementRecord } from "@/lib/competitions/premier-league/settlement";
import { brier3, rps3 } from "@/lib/evaluation/metrics";
import type { Outcome } from "@/lib/evaluation/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";

export type SettlementSnapshotConsistencyIssue =
  | "SNAPSHOT_KEY_MISMATCH"
  | "FIXTURE_MISMATCH"
  | "SEASON_MISMATCH"
  | "MODEL_VERSION_MISMATCH"
  | "EVALUATION_CLASS_MISMATCH"
  | "PREDICTION_STAGE_MISMATCH"
  | "PREDICTED_PROBABILITY_MISMATCH"
  | "ACTUAL_SCORE_INVALID"
  | "ACTUAL_OUTCOME_SCORE_MISMATCH"
  | "BRIER_MISMATCH"
  | "RPS_MISMATCH"
  | "LOG_LOSS_MISMATCH"
  | "TOP_PICK_MISMATCH";

const PROBABILITY_EPSILON = 1e-12;

function differs(actual: number, expected: number): boolean {
  return !Number.isFinite(actual) || Math.abs(actual - expected) > PROBABILITY_EPSILON;
}

function scoreOutcome(home: number, away: number): Outcome {
  return home > away ? "home" : home < away ? "away" : "draw";
}

/**
 * A resolving settlement is usable evidence only when it describes the exact
 * immutable forecast it claims to score. Operations/events are not inferred.
 */
export function validateSettlementSnapshotConsistency(
  settlement: SettlementRecord,
  snapshot: PredictionSnapshot
): { consistent: boolean; issues: SettlementSnapshotConsistencyIssue[] } {
  const issues: SettlementSnapshotConsistencyIssue[] = [];
  if (settlement.snapshotUniqueKey !== snapshot.provenance.uniqueKey) {
    issues.push("SNAPSHOT_KEY_MISMATCH");
  }
  if (settlement.fixtureId !== snapshot.fixtureId) issues.push("FIXTURE_MISMATCH");
  if (settlement.season !== snapshot.season) issues.push("SEASON_MISMATCH");
  if (settlement.modelVersion !== snapshot.modelVersion) {
    issues.push("MODEL_VERSION_MISMATCH");
  }
  if (settlement.evaluationClass !== snapshot.evaluationClass) {
    issues.push("EVALUATION_CLASS_MISMATCH");
  }
  if (
    canonicalizePredictionStage(settlement.predictionStage) !==
    canonicalizePredictionStage(snapshot.predictionStage)
  ) {
    issues.push("PREDICTION_STAGE_MISMATCH");
  }
  if (
    differs(settlement.predicted.home, snapshot.homeProbability) ||
    differs(settlement.predicted.draw, snapshot.drawProbability) ||
    differs(settlement.predicted.away, snapshot.awayProbability)
  ) {
    issues.push("PREDICTED_PROBABILITY_MISMATCH");
  }

  const scoreIsValid =
    Number.isInteger(settlement.actualScore.home) &&
    settlement.actualScore.home >= 0 &&
    Number.isInteger(settlement.actualScore.away) &&
    settlement.actualScore.away >= 0;
  if (!scoreIsValid) {
    issues.push("ACTUAL_SCORE_INVALID");
  } else {
    const expectedOutcome = scoreOutcome(
      settlement.actualScore.home,
      settlement.actualScore.away
    );
    if (settlement.actualOutcome !== expectedOutcome) {
      issues.push("ACTUAL_OUTCOME_SCORE_MISMATCH");
    }
  }

  const actual = settlement.actualOutcome;
  const home = snapshot.homeProbability;
  const draw = snapshot.drawProbability;
  const away = snapshot.awayProbability;
  const expectedBrier = brier3(home, draw, away, actual);
  const expectedRps = rps3(home, draw, away, actual);
  const pActual = actual === "home" ? home : actual === "draw" ? draw : away;
  const expectedLogLoss = -Math.log(Math.max(1e-12, pActual));
  const top: Outcome =
    home >= draw && home >= away ? "home" : away >= draw ? "away" : "draw";
  if (differs(settlement.brier, expectedBrier)) issues.push("BRIER_MISMATCH");
  if (differs(settlement.rps, expectedRps)) issues.push("RPS_MISMATCH");
  if (differs(settlement.logLoss, expectedLogLoss)) issues.push("LOG_LOSS_MISMATCH");
  if (settlement.topPickCorrect !== (top === actual)) {
    issues.push("TOP_PICK_MISMATCH");
  }
  return { consistent: issues.length === 0, issues };
}
