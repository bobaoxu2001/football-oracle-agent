import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import {
  assertForecastInputManifestIntegrity,
  assertForecastInputManifestReferences,
} from "@/lib/competitions/premier-league/provenance/manifest";
import type {
  ForecastInputManifest,
  ManifestReferenceSet,
} from "@/lib/competitions/premier-league/provenance/types";
import type { InputLineageSummary } from "./types";

type SnapshotWithInputManifest = PredictionSnapshot & {
  inputManifestId?: unknown;
  inputManifest?: unknown;
  inputManifestRecords?: unknown;
};

type CompactManifest = {
  manifestId?: unknown;
  manifestPayloadHash?: unknown;
  latestIncludedInputAt?: unknown;
  kickoffAtAsKnown?: unknown;
  fixtureRevisionId?: unknown;
  seasonMembershipSnapshotId?: unknown;
  modelBundleId?: unknown;
  modelBundleHash?: unknown;
  ratingStateHash?: unknown;
  applicationCommitSha?: unknown;
  inputLineageStatus?: unknown;
  validationStatus?: unknown;
};

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const APPLICATION_COMMIT = /^[a-f0-9]{40}$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptySummary(status: InputLineageSummary["status"]): InputLineageSummary {
  return {
    status,
    manifestId: null,
    manifestPayloadHash: null,
    latestIncludedInputAt: null,
    kickoffAtAsKnown: null,
    fixtureRevisionId: null,
    seasonMembershipSnapshotId: null,
    modelBundleId: null,
    modelBundleHash: null,
    ratingStateHash: null,
    applicationCommitSha: null,
  };
}

/**
 * Compact public projection of immutable forecast lineage.
 *
 * Absence of a manifest always means legacy lineage. Old source-state
 * timestamps are intentionally ignored here: partial timestamps cannot prove
 * that a complete PIT manifest existed. A present but incomplete, inconsistent
 * or unverified manifest is reported as invalid rather than silently falling
 * back to legacy.
 */
export function inputLineageSummary(
  snapshot: PredictionSnapshot
): InputLineageSummary {
  const snapshotWithManifest = snapshot as SnapshotWithInputManifest;
  const raw = snapshotWithManifest.inputManifest;
  const referencedManifestId = text(snapshotWithManifest.inputManifestId);
  if (raw === null || raw === undefined) {
    if (!referencedManifestId) return emptySummary("LEGACY_UNAVAILABLE");
    return { ...emptySummary("PIT_INVALID"), manifestId: referencedManifestId };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return emptySummary("PIT_INVALID");

  const manifest = raw as CompactManifest;
  const summary: InputLineageSummary = {
    status: "PIT_INVALID",
    manifestId: text(manifest.manifestId),
    manifestPayloadHash: text(manifest.manifestPayloadHash),
    latestIncludedInputAt: text(manifest.latestIncludedInputAt),
    kickoffAtAsKnown: text(manifest.kickoffAtAsKnown),
    fixtureRevisionId: text(manifest.fixtureRevisionId),
    seasonMembershipSnapshotId: text(manifest.seasonMembershipSnapshotId),
    modelBundleId: text(manifest.modelBundleId),
    modelBundleHash: text(manifest.modelBundleHash),
    ratingStateHash: text(manifest.ratingStateHash),
    applicationCommitSha: text(manifest.applicationCommitSha),
  };

  const required = [
    summary.manifestId,
    summary.manifestPayloadHash,
    summary.latestIncludedInputAt,
    summary.kickoffAtAsKnown,
    summary.fixtureRevisionId,
    summary.seasonMembershipSnapshotId,
    summary.modelBundleId,
    summary.modelBundleHash,
    summary.ratingStateHash,
    summary.applicationCommitSha,
  ];
  const latestInputMs = Date.parse(summary.latestIncludedInputAt ?? "");
  const cutoffMs = Date.parse(snapshot.asOf);
  const kickoffMs = Date.parse(summary.kickoffAtAsKnown ?? "");
  const frozenKickoffMs = Date.parse(snapshot.kickoff ?? "");
  const validationStatus =
    text(manifest.inputLineageStatus) ?? text(manifest.validationStatus);
  const hashesValid = [
    summary.manifestPayloadHash,
    summary.modelBundleHash,
    summary.ratingStateHash,
  ].every((value) => value !== null && SHA256.test(value));

  let fullIntegrityVerified = false;
  try {
    const fullManifest = raw as ForecastInputManifest;
    const references = snapshotWithManifest.inputManifestRecords as
      | ManifestReferenceSet
      | undefined;
    if (!references) throw new Error("missing immutable manifest references");
    assertForecastInputManifestIntegrity(fullManifest);
    assertForecastInputManifestReferences(fullManifest, references);
    fullIntegrityVerified = true;
  } catch {
    // Public classification is fail-closed. The compact fields remain visible
    // for diagnosis, but a self-declared status or well-shaped hash string can
    // never turn corrupt/missing evidence into PIT_VERIFIED.
  }

  const computedAt = text(snapshot.sourceState?.computedAt);
  const snapshotBindingValid =
    referencedManifestId !== null &&
    referencedManifestId === summary.manifestId &&
    text((manifest as ForecastInputManifest).fixtureId) === snapshot.fixtureId &&
    text((manifest as ForecastInputManifest).season) === snapshot.season &&
    text((manifest as ForecastInputManifest).modelVersion) === snapshot.modelVersion &&
    text((manifest as ForecastInputManifest).forecastStage) ===
      canonicalizePredictionStage(snapshot.predictionStage) &&
    text((manifest as ForecastInputManifest).cutoffAt) === snapshot.asOf &&
    snapshot.dataCutoff === snapshot.asOf &&
    computedAt !== null &&
    text((manifest as ForecastInputManifest).generatedAt) === computedAt;

  if (
    fullIntegrityVerified &&
    snapshotBindingValid &&
    required.every((value) => value !== null) &&
    validationStatus === "PIT_VERIFIED" &&
    hashesValid &&
    APPLICATION_COMMIT.test(summary.applicationCommitSha ?? "") &&
    Number.isFinite(latestInputMs) &&
    Number.isFinite(cutoffMs) &&
    latestInputMs <= cutoffMs &&
    Number.isFinite(kickoffMs) &&
    Number.isFinite(frozenKickoffMs) &&
    kickoffMs === frozenKickoffMs
  ) {
    summary.status = "PIT_VERIFIED";
  }

  return summary;
}
