/** Production snapshot adapter for the store-free sealed Premier League core. */

import { getClub } from "@/lib/competitions/premier-league/clubs";
import type { MatchContextSnapshot } from "@/lib/competitions/premier-league/context/types";
import { assertMatchContextIntegrity } from "@/lib/competitions/premier-league/context/snapshot";
import type { ResolvedProspectiveForecastInput } from "@/lib/competitions/premier-league/provenance/production";
import { canonicalJson } from "@/lib/competitions/premier-league/provenance/canonical";
import { createSnapshot, type PredictionSnapshot } from "@/lib/snapshots/store";
import { snapshotUniqueKey } from "@/lib/snapshots/types";
import type { PredictionStage } from "@/lib/snapshots/types";
import { predictPremierLeagueFromFrozenInputs } from "./sealed-premier-league";

export function snapshotPremierLeagueFromFrozenInputs(input: {
  resolved: ResolvedProspectiveForecastInput;
  contextSnapshot: MatchContextSnapshot;
}): PredictionSnapshot {
  const { manifest, references, sealedInput } = input.resolved;
  const context = input.contextSnapshot;
  assertMatchContextIntegrity(context);
  const forecastSnapshotKey = snapshotUniqueKey({
    competition: "premier-league",
    season: manifest.season,
    fixtureId: manifest.fixtureId,
    modelVersion: manifest.modelVersion,
    predictionStage: manifest.forecastStage as PredictionStage,
    asOf: manifest.cutoffAt,
  });
  if (
    context.forecastSnapshotKey !== forecastSnapshotKey ||
    context.fixtureId !== manifest.fixtureId ||
    context.season !== manifest.season ||
    context.homeSlug !== references.fixtureRevision.homeSlug ||
    context.awaySlug !== references.fixtureRevision.awaySlug ||
    context.kickoffAt !== manifest.kickoffAtAsKnown ||
    context.cutoffAt !== manifest.cutoffAt ||
    context.generatedAt !== manifest.generatedAt ||
    context.usedInForecastEvidenceIds.length !== 0
  ) {
    throw new Error("Match context does not bind to the exact PIT forecast manifest");
  }

  const result = predictPremierLeagueFromFrozenInputs(sealedInput);
  const artifact = result.artifact;
  const homeClub = getClub(references.fixtureRevision.homeSlug);
  const awayClub = getClub(references.fixtureRevision.awaySlug);
  const latestRatingEventAppliedAt = manifest.ratingEvents
    .map((event) => event.appliedAt)
    .sort()
    .at(-1) ?? null;
  const parameterPayload = references.modelBundle.parameterPayload;
  if (!parameterPayload || typeof parameterPayload !== "object" || Array.isArray(parameterPayload)) {
    throw new Error("PIT model bundle parameter payload must be an object");
  }

  return createSnapshot({
    fixtureId: manifest.fixtureId,
    competition: "premier-league",
    season: manifest.season,
    asOf: manifest.cutoffAt,
    kickoff: manifest.kickoffAtAsKnown,
    modelVersion: manifest.modelVersion,
    predictionStage: manifest.forecastStage as PredictionStage,
    evaluationClass: "LIVE_OOS",
    homeSlug: references.fixtureRevision.homeSlug,
    awaySlug: references.fixtureRevision.awaySlug,
    homeTeam: homeClub.name,
    awayTeam: awayClub.name,
    home: artifact.probabilities.home,
    draw: artifact.probabilities.draw,
    away: artifact.probabilities.away,
    homeExpectedGoals: artifact.expectedGoals.home,
    awayExpectedGoals: artifact.expectedGoals.away,
    scorelineDistribution: Object.fromEntries(
      artifact.scorelineGrid.map((cell) => [`${cell.a}–${cell.b}`, cell.p])
    ),
    modelParameters: JSON.parse(canonicalJson(parameterPayload)) as Record<string, unknown>,
    sourceState: {
      eloHome: artifact.elo.home,
      eloAway: artifact.elo.away,
      fixturesUsed: manifest.ratingEvents.length,
      ratingEventsUsed: manifest.ratingEvents.length,
      ratingEventIds: manifest.ratingEvents.map((event) => event.ratingEventId),
      latestRatingEventAppliedAt,
      ratingStateAsOf: references.ratingState.asOf,
      ratingStateId: references.ratingState.ratingStateId,
      ratingStateHash: references.ratingState.ratingStateHash,
      computedAt: manifest.generatedAt,
      origin: "scheduled",
      fixtureDataVersion: references.fixtureRevision.sourceObservation.sourceVersion,
      fixtureRevisionId: references.fixtureRevision.fixtureRevisionId,
      fixtureRetrievedAt: references.fixtureRevision.availableAt,
      kickoffCertaintyAtFreeze: references.fixtureRevision.kickoffCertainty,
      seasonMembershipSnapshotId:
        references.seasonMembership.seasonMembershipSnapshotId,
      modelBundleId: references.modelBundle.modelBundleId,
      modelBundleHash: references.modelBundle.modelBundleHash,
      sealedPredictorSchemaVersion: artifact.schemaVersion,
      frozenInputHash: artifact.frozenInputHash,
      replayHash: artifact.replayHash,
      contextSnapshotId: context.contextId,
      contextSchemaVersion: context.schemaVersion,
      contextSnapshotCutoffAt: context.cutoffAt,
      contextSnapshotGeneratedAt: context.generatedAt,
      contextTemporalRule: context.temporalRule,
      contextLineupStatus: context.lineup.overall,
      contextLineupAvailableAt:
        [context.lineup.home.availableAt, context.lineup.away.availableAt]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
      contextEvidenceCount: context.evidence.length,
      contextModelUsedEvidenceCount: 0,
      contextInformationalEvidenceCount: context.evidence.length,
      contextUsedInForecastEvidenceIds: [],
    },
    provenanceNotes:
      `Scheduled ${manifest.forecastStage} observation generated by the sealed predictor. ` +
      "Every football-semantic input is frozen in the referenced PIT manifest; market data is excluded.",
    inputManifestId: manifest.manifestId,
    inputManifest: manifest,
    inputManifestRecords: references,
  });
}
