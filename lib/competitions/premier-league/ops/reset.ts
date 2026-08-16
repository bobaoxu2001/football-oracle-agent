import { unlinkIfExists } from "./jsonl";
import {
  operationalLiveOosPath,
  predictionJobPath,
  ratingEventPath,
  ratingStateSnapshotPath,
  resultObservationPath,
  resultVerificationPath,
  scheduleRevisionPath,
  settlementCorrectionPath,
  sourceObservationPath,
  tickStatePath,
} from "./paths";
import { resetJobCache } from "./job-ledger";
import { resetRatingEventCache } from "./rating-events";
import { resetSeasonBundleCache } from "../fixture-store";
import { clearSettlementsForTests } from "../settlement";
import { clearSnapshotsForTests } from "@/lib/snapshots/store";

export function clearLiveOpsForTests(): void {
  resetJobCache();
  resetRatingEventCache();
  resetSeasonBundleCache();
  unlinkIfExists(predictionJobPath());
  unlinkIfExists(sourceObservationPath());
  unlinkIfExists(scheduleRevisionPath());
  unlinkIfExists(resultObservationPath());
  unlinkIfExists(resultVerificationPath());
  unlinkIfExists(ratingEventPath());
  unlinkIfExists(ratingStateSnapshotPath());
  unlinkIfExists(settlementCorrectionPath());
  unlinkIfExists(operationalLiveOosPath());
  unlinkIfExists(tickStatePath());
  try {
    clearSettlementsForTests();
  } catch {
    /* path may be unset */
  }
  try {
    clearSnapshotsForTests();
  } catch {
    /* canonical tape guard */
  }
}
