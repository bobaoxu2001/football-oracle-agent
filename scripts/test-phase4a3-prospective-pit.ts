/** Phase 4A.3: adversarial prospective PIT and sealed-replay regression gates. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "football-oracle-prospective-pit-"));
const PROVENANCE_DIR = path.join(TEMP, "provenance");
const SNAPSHOT_PATH = path.join(TEMP, "snapshots.jsonl");
const COMMIT_SHA = "c".repeat(40);

process.env.PL_PROVENANCE_DIR = PROVENANCE_DIR;
process.env.SNAPSHOT_STORE_PATH = SNAPSHOT_PATH;
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TEMP, "live-oos-archive.jsonl");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TEMP, "live-oos-operational.jsonl");
process.env.APPLICATION_COMMIT_SHA = COMMIT_SHA;
delete process.env.MONGODB_URI;

import {
  buildFixtureRevision,
  buildForecastInputManifest,
  buildFrozenRatingState,
  buildImmutableModelBundle,
  buildRatingEventReference,
  buildResultCorrection,
  buildResultRevision,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
  canonicalJson,
  canonicalSha256,
  latestFixtureRevisionAtOrBefore,
  type ForecastInputManifest,
  type ManifestReferenceSet,
} from "@/lib/competitions/premier-league/provenance";
import {
  insertProvenanceRecords,
  provenanceFilePaths,
} from "@/lib/competitions/premier-league/provenance/durable";
import {
  replayForecastInputManifest,
  resolveProspectiveForecastInput,
} from "@/lib/competitions/premier-league/provenance/production";
import { provenanceManifestPath } from "@/lib/competitions/premier-league/ops/paths";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { assembleMatchContext } from "@/lib/competitions/premier-league/context/snapshot";
import { inputLineageSummary } from "@/lib/match-forecast/input-lineage";
import { predictPremierLeagueFromFrozenInputs } from "@/lib/prediction-engine/sealed-premier-league";
import { snapshotPremierLeagueFromFrozenInputs } from "@/lib/prediction-engine/sealed-snapshot";
import {
  clearSnapshotsForTests,
  createSnapshot,
  listSnapshots,
  snapshotUniqueKey,
} from "@/lib/snapshots/store";
import type { PredictionSnapshot } from "@/lib/snapshots/types";

const SEASON = "2026-27";
const FIXTURE_ID = "phase4a3-prospective-arsenal-chelsea";
const PRIOR_FIXTURE_ID = "phase4a3-prior-arsenal-chelsea";
const CUTOFF = "2026-09-09T15:00:00.000Z";
const GENERATED = "2026-09-09T15:00:30.000Z";
const KICKOFF_AS_KNOWN = "2026-09-10T15:00:00.000Z";
const AFTER_CUTOFF = "2026-09-09T15:00:01.000Z";

let passed = 0;

function check(name: string, test: () => void): void {
  test();
  passed += 1;
  console.log(`✓ ${name}`);
}

function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function source(input: {
  type: string;
  id: string;
  observation: string;
  availableAt: string;
  payload: unknown;
}) {
  return buildSourceObservationReference({
    sourceType: input.type,
    sourceId: input.id,
    sourceVersion: "test-v1",
    observationId: input.observation,
    publishedAt: input.availableAt,
    availableAt: input.availableAt,
    retrievedAt: input.availableAt,
    payload: input.payload,
  });
}

const membershipSource = source({
  type: "season-membership",
  id: "membership-feed",
  observation: "membership:2026-27:v1",
  availableAt: "2026-08-01T09:00:00.000Z",
  payload: { teams: ["arsenal", "chelsea"] },
});
const membership = buildSeasonMembershipSnapshot({
  season: SEASON,
  teamSlugs: ["chelsea", "arsenal"],
  sourceObservations: [membershipSource],
});

const futureMembershipSource = source({
  type: "season-membership",
  id: "membership-feed",
  observation: "membership:2026-27:v2",
  availableAt: AFTER_CUTOFF,
  payload: { teams: ["arsenal", "chelsea", "liverpool"] },
});
const futureMembership = buildSeasonMembershipSnapshot({
  season: SEASON,
  teamSlugs: ["liverpool", "chelsea", "arsenal"],
  sourceObservations: [futureMembershipSource],
});

const fixtureSource = source({
  type: "fixture",
  id: "fixture-feed",
  observation: `${FIXTURE_ID}:v1`,
  availableAt: "2026-08-20T10:00:00.000Z",
  payload: { fixtureId: FIXTURE_ID, kickoffAt: KICKOFF_AS_KNOWN },
});
const fixtureRevision = buildFixtureRevision({
  season: SEASON,
  fixtureId: FIXTURE_ID,
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  kickoffAt: KICKOFF_AS_KNOWN,
  status: "SCHEDULED",
  venue: "home",
  sourceObservation: fixtureSource,
});

const rescheduledKickoff = "2026-09-10T18:00:00.000Z";
const rescheduleSource = source({
  type: "fixture",
  id: "fixture-feed",
  observation: `${FIXTURE_ID}:v2`,
  availableAt: AFTER_CUTOFF,
  payload: { fixtureId: FIXTURE_ID, kickoffAt: rescheduledKickoff },
});
const rescheduledFixture = buildFixtureRevision({
  season: SEASON,
  fixtureId: FIXTURE_ID,
  homeSlug: "arsenal",
  awaySlug: "chelsea",
  kickoffAt: rescheduledKickoff,
  status: "SCHEDULED",
  venue: "home",
  sourceObservation: rescheduleSource,
  supersedesFixtureRevisionId: fixtureRevision.fixtureRevisionId,
});

const resultSource = source({
  type: "result",
  id: "result-feed",
  observation: `${PRIOR_FIXTURE_ID}:v1`,
  availableAt: "2026-09-05T18:00:00.000Z",
  payload: { fixtureId: PRIOR_FIXTURE_ID, homeScore: 2, awayScore: 0 },
});
const resultRevision = buildResultRevision({
  season: SEASON,
  fixtureId: PRIOR_FIXTURE_ID,
  status: "FINISHED",
  homeScore: 2,
  awayScore: 0,
  sourceObservation: resultSource,
});

const correctedResultSource = source({
  type: "result",
  id: "result-feed",
  observation: `${PRIOR_FIXTURE_ID}:v2`,
  availableAt: AFTER_CUTOFF,
  payload: { fixtureId: PRIOR_FIXTURE_ID, homeScore: 2, awayScore: 1 },
});
const correctedResult = buildResultRevision({
  season: SEASON,
  fixtureId: PRIOR_FIXTURE_ID,
  status: "FINISHED",
  homeScore: 2,
  awayScore: 1,
  sourceObservation: correctedResultSource,
  supersedesResultRevisionId: resultRevision.resultRevisionId,
});
const resultCorrection = buildResultCorrection({
  fixtureId: PRIOR_FIXTURE_ID,
  previousResultRevisionId: resultRevision.resultRevisionId,
  correctedResultRevisionId: correctedResult.resultRevisionId,
  detectedAt: AFTER_CUTOFF,
  availableAt: AFTER_CUTOFF,
});

const ratingEvent = buildRatingEventReference({
  ratingEventId: `${PRIOR_FIXTURE_ID}:rating:v1`,
  fixtureId: PRIOR_FIXTURE_ID,
  fixtureKickoff: "2026-09-05T15:00:00.000Z",
  appliedAt: "2026-09-05T18:01:00.000Z",
  availableAt: "2026-09-05T18:01:00.000Z",
  payload: { resultRevisionId: resultRevision.resultRevisionId, delta: 12 },
  resultRevisionId: resultRevision.resultRevisionId,
});
const futureRatingEvent = buildRatingEventReference({
  ratingEventId: `${PRIOR_FIXTURE_ID}:rating:v2`,
  fixtureId: PRIOR_FIXTURE_ID,
  fixtureKickoff: "2026-09-09T12:00:00.000Z",
  appliedAt: AFTER_CUTOFF,
  availableAt: AFTER_CUTOFF,
  payload: { resultRevisionId: correctedResult.resultRevisionId, delta: 4 },
  resultRevisionId: correctedResult.resultRevisionId,
});

const ratingState = buildFrozenRatingState({
  season: SEASON,
  asOf: CUTOFF,
  availableAt: "2026-09-05T18:01:00.000Z",
  modelVersion: PRODUCTION_MODEL_VERSION,
  formulaVersion: "elo-v1",
  seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
  ratingEvents: [ratingEvent],
  state: {
    season: SEASON,
    clubSlugs: ["chelsea", "arsenal"],
    ratings: { arsenal: 1612, chelsea: 1548 },
    matchesPlayedSeason: { arsenal: 3, chelsea: 3 },
  },
});

const modelParameters = {
  competition: "premier-league",
  modelVersion: PRODUCTION_MODEL_VERSION,
  homeAdvantage: 72,
  dcRho: -0.061,
  drawBias: 1,
  goalScale: 350,
  baseGoals: 1.35,
  awayHomeShare: 0,
  kFactor: 20,
  fittedAt: "2026-08-15",
  trainingWindow: { from: "2018-08-01", to: "2025-05-31" },
  notes: "Phase 4A.3 deterministic prospective PIT test bundle.",
};

function makeModelBundle(
  parameters: typeof modelParameters = modelParameters,
  commitSha = COMMIT_SHA
) {
  return buildImmutableModelBundle({
    modelId: "football-oracle-premier-league-production",
    modelVersion: PRODUCTION_MODEL_VERSION,
    trainingCutoff: "2025-05-31T23:59:59.999Z",
    parameterPayload: parameters,
    featureSchemaVersion: "pl-features-v0.2.0",
    featureCodeVersion: "pl-sealed-predictor-v1+elo-v1",
    createdAt: "2026-08-15T00:00:00.000Z",
    availableAt: "2026-08-15T00:00:00.000Z",
    codeCommitSha: commitSha,
  });
}

const modelBundle = makeModelBundle();
const baseReferences: ManifestReferenceSet = {
  fixtureRevision,
  seasonMembership: membership,
  ratingState,
  modelBundle,
};

function manifestFrom(
  references: ManifestReferenceSet,
  sourceObservations: Parameters<typeof buildForecastInputManifest>[0]["sourceObservations"] = []
): ForecastInputManifest {
  return buildForecastInputManifest({
    fixtureId: references.fixtureRevision.fixtureId,
    season: references.fixtureRevision.season,
    forecastStage: "T24H",
    cutoffAt: CUTOFF,
    generatedAt: GENERATED,
    kickoffAtAsKnown: references.fixtureRevision.kickoffAt,
    applicationCommitSha: COMMIT_SHA,
    ...references,
    sourceObservations,
  });
}

function main(): void {
  clearSnapshotsForTests();
  let resolved!: ReturnType<typeof resolveProspectiveForecastInput>;
  let productionSnapshot!: PredictionSnapshot;
  let replayHash!: string;

  check("Q1 future result cannot enter a forecast manifest", () => {
    assert.throws(
      () => manifestFrom(baseReferences, [correctedResult.sourceObservation]),
      /after forecast cutoffAt/
    );
  });

  check("Q2 future fixture revision cannot replace the cutoff-qualified revision", () => {
    const selected = latestFixtureRevisionAtOrBefore(
      [rescheduledFixture, fixtureRevision],
      FIXTURE_ID,
      CUTOFF
    );
    assert.equal(selected?.fixtureRevisionId, fixtureRevision.fixtureRevisionId);
    assert.throws(
      () =>
        manifestFrom({
          ...baseReferences,
          fixtureRevision: rescheduledFixture,
        }),
      /after forecast cutoffAt/
    );
  });

  check("Q3 future rating event is rejected before rating-state freeze", () => {
    assert.throws(
      () =>
        buildFrozenRatingState({
          season: SEASON,
          asOf: CUTOFF,
          availableAt: CUTOFF,
          modelVersion: PRODUCTION_MODEL_VERSION,
          formulaVersion: "elo-v1",
          seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
          ratingEvents: [ratingEvent, futureRatingEvent],
          state: ratingState.state,
        }),
      /after rating state asOf/
    );
  });

  check("Q4 future season membership cannot enter a forecast manifest", () => {
    const stateBoundToFutureMembership = buildFrozenRatingState({
      season: SEASON,
      asOf: CUTOFF,
      availableAt: "2026-09-05T18:01:00.000Z",
      modelVersion: PRODUCTION_MODEL_VERSION,
      formulaVersion: "elo-v1",
      seasonMembershipSnapshotId: futureMembership.seasonMembershipSnapshotId,
      ratingEvents: [ratingEvent],
      state: {
        season: SEASON,
        clubSlugs: ["arsenal", "chelsea", "liverpool"],
        ratings: { arsenal: 1612, chelsea: 1548, liverpool: 1580 },
        matchesPlayedSeason: { arsenal: 3, chelsea: 3, liverpool: 3 },
      },
    });
    assert.throws(
      () =>
        manifestFrom({
          ...baseReferences,
          seasonMembership: futureMembership,
          ratingState: stateBoundToFutureMembership,
        }),
      /after forecast cutoffAt/
    );
  });

  check("Q5 a source lacking availableAt fails closed", () => {
    assert.throws(
      () =>
        buildSourceObservationReference({
          sourceType: "result",
          sourceId: "missing-availability",
          observationId: "missing-availability:v1",
          availableAt: undefined as never,
          payload: { score: "1-0" },
        }),
      /timestamp/
    );
  });

  check("Q6 duplicate retry creates neither duplicate manifest nor snapshot", () => {
    const inserted = insertProvenanceRecords([
      fixtureRevision,
      membership,
      resultRevision,
      ratingState,
      modelBundle,
    ]);
    assert.equal(inserted.inserted.length, 5);

    resolved = resolveProspectiveForecastInput({
      fixtureId: FIXTURE_ID,
      stage: "T24H",
      cutoffAt: CUTOFF,
      generatedAt: GENERATED,
    });
    const forecastSnapshotKey = snapshotUniqueKey({
      competition: "premier-league",
      season: SEASON,
      fixtureId: FIXTURE_ID,
      modelVersion: PRODUCTION_MODEL_VERSION,
      predictionStage: "T24H",
      asOf: CUTOFF,
    });
    const context = assembleMatchContext({
      season: SEASON,
      fixtureId: FIXTURE_ID,
      homeSlug: "arsenal",
      awaySlug: "chelsea",
      kickoffAt: KICKOFF_AS_KNOWN,
      cutoffAt: CUTOFF,
      generatedAt: resolved.manifest.generatedAt,
      forecastSnapshotKey,
      evidence: [],
    }).snapshot;
    productionSnapshot = snapshotPremierLeagueFromFrozenInputs({
      resolved,
      contextSnapshot: context,
    });

    const retryResolved = resolveProspectiveForecastInput({
      fixtureId: FIXTURE_ID,
      stage: "T24H",
      cutoffAt: CUTOFF,
      generatedAt: GENERATED,
    });
    const retrySnapshot = snapshotPremierLeagueFromFrozenInputs({
      resolved: retryResolved,
      contextSnapshot: context,
    });

    assert.equal(retryResolved.manifest.manifestId, resolved.manifest.manifestId);
    assert.equal(retrySnapshot.provenance.uniqueKey, productionSnapshot.provenance.uniqueKey);
    assert.equal(lines(provenanceManifestPath()).length, 1);
    assert.equal(lines(SNAPSHOT_PATH).length, 1);
    assert.equal(listSnapshots().length, 1);
    assert.equal(productionSnapshot.inputManifestId, resolved.manifest.manifestId);
  });

  check("Q7 a later reschedule leaves the old manifest byte-for-byte unchanged", () => {
    const manifestBefore = fs.readFileSync(provenanceManifestPath(), "utf8");
    const frozenBefore = canonicalJson(resolved.manifest);
    insertProvenanceRecords([rescheduledFixture]);
    const retry = resolveProspectiveForecastInput({
      fixtureId: FIXTURE_ID,
      stage: "T24H",
      cutoffAt: CUTOFF,
      generatedAt: GENERATED,
    });
    assert.equal(retry.references.fixtureRevision.fixtureRevisionId, fixtureRevision.fixtureRevisionId);
    assert.equal(canonicalJson(retry.manifest), frozenBefore);
    assert.equal(fs.readFileSync(provenanceManifestPath(), "utf8"), manifestBefore);
    assert.equal(retry.manifest.kickoffAtAsKnown, KICKOFF_AS_KNOWN);
  });

  check("Q8 a later result correction is append-only and cannot alter the old manifest", () => {
    const manifestBefore = fs.readFileSync(provenanceManifestPath(), "utf8");
    const inserted = insertProvenanceRecords([correctedResult, resultCorrection]);
    assert.equal(inserted.inserted.length, 2);
    assert.equal(correctedResult.sourceObservation.sourceId, resultRevision.sourceObservation.sourceId);
    assert.notEqual(correctedResult.sourceObservation.payloadHash, resultRevision.sourceObservation.payloadHash);
    assert.equal(fs.readFileSync(provenanceManifestPath(), "utf8"), manifestBefore);
    assert.equal(
      resolved.manifest.ratingEvents[0]?.resultRevisionId,
      resultRevision.resultRevisionId
    );
  });

  check("Q9 the same manifest produces identical probabilities and replay hashes", () => {
    const first = replayForecastInputManifest(resolved.manifest, resolved.references);
    const second = replayForecastInputManifest(resolved.manifest, resolved.references);
    assert.deepEqual(first.result.prediction, second.result.prediction);
    assert.deepEqual(first.result.artifact.probabilities, second.result.artifact.probabilities);
    assert.deepEqual(first.result.artifact.scorelineGrid, second.result.artifact.scorelineGrid);
    assert.equal(first.replayHash, second.replayHash);
    replayHash = first.replayHash;
  });

  check("Q10 mutable current stores and environment cannot alter sealed replay", () => {
    const futureRatingState = buildFrozenRatingState({
      season: SEASON,
      asOf: "2026-09-09T16:00:00.000Z",
      availableAt: "2026-09-09T16:00:00.000Z",
      modelVersion: PRODUCTION_MODEL_VERSION,
      formulaVersion: "elo-v1",
      seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
      ratingEvents: [ratingEvent, futureRatingEvent],
      state: {
        season: SEASON,
        clubSlugs: ["arsenal", "chelsea"],
        ratings: { arsenal: 1300, chelsea: 1800 },
        matchesPlayedSeason: { arsenal: 4, chelsea: 4 },
      },
    });
    insertProvenanceRecords([futureMembership, futureRatingState]);

    const originalDir = process.env.PL_PROVENANCE_DIR;
    const originalCommit = process.env.APPLICATION_COMMIT_SHA;
    try {
      process.env.PL_PROVENANCE_DIR = path.join(TEMP, "empty-current-state");
      process.env.APPLICATION_COMMIT_SHA = "d".repeat(40);
      process.env.MONGODB_URI = "mongodb://127.0.0.1:1/must-not-be-read";
      const replay = replayForecastInputManifest(resolved.manifest, resolved.references);
      const direct = predictPremierLeagueFromFrozenInputs(resolved.sealedInput);
      assert.equal(replay.replayHash, replayHash);
      assert.equal(direct.artifact.replayHash, replayHash);
      assert.equal(replay.result.artifact.ratingState.ratingStateId, ratingState.ratingStateId);
    } finally {
      process.env.PL_PROVENANCE_DIR = originalDir!;
      process.env.APPLICATION_COMMIT_SHA = originalCommit!;
      delete process.env.MONGODB_URI;
    }
  });

  check("Q11 scheduled production cannot commit without a complete manifest", () => {
    const before = lines(SNAPSHOT_PATH).length;
    assert.throws(
      () =>
        createSnapshot({
          fixtureId: `${FIXTURE_ID}-orphan`,
          competition: "premier-league",
          season: SEASON,
          asOf: CUTOFF,
          kickoff: KICKOFF_AS_KNOWN,
          modelVersion: PRODUCTION_MODEL_VERSION,
          predictionStage: "T24H",
          evaluationClass: "LIVE_OOS",
          homeSlug: "arsenal",
          awaySlug: "chelsea",
          home: 0.5,
          draw: 0.25,
          away: 0.25,
          homeExpectedGoals: 1.5,
          awayExpectedGoals: 1,
          scorelineDistribution: { "1–0": 1 },
          sourceState: { origin: "scheduled", computedAt: GENERATED },
        }),
      /without its complete PIT input manifest/
    );
    assert.equal(lines(SNAPSHOT_PATH).length, before);
    assert.equal(listSnapshots().some((row) => row.fixtureId.endsWith("-orphan")), false);
  });

  check("Q12 replay is isolated and writes nothing to the production track", () => {
    const before = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    const replay = replayForecastInputManifest(resolved.manifest, resolved.references);
    assert.equal(replay.track, "HISTORICAL_REPLAY");
    assert.equal(replay.manifestId, resolved.manifest.manifestId);
    assert.equal(fs.readFileSync(SNAPSHOT_PATH, "utf8"), before);
  });

  check("Q13 legacy snapshots remain explicitly legacy with no fabricated lineage", () => {
    const legacy = createSnapshot({
      fixtureId: `${FIXTURE_ID}-legacy`,
      competition: "premier-league",
      season: SEASON,
      asOf: "2026-09-01T12:00:00.000Z",
      kickoff: KICKOFF_AS_KNOWN,
      modelVersion: PRODUCTION_MODEL_VERSION,
      predictionStage: "EARLY",
      evaluationClass: "LIVE_OOS",
      homeSlug: "arsenal",
      awaySlug: "chelsea",
      home: 0.5,
      draw: 0.25,
      away: 0.25,
      homeExpectedGoals: 1.5,
      awayExpectedGoals: 1,
      scorelineDistribution: { "1–0": 1 },
      sourceState: {
        origin: "manual",
        computedAt: "2026-09-01T12:00:00.000Z",
        latestRatingEventAppliedAt: "2026-08-30T18:00:00.000Z",
      },
    });
    const summary = inputLineageSummary(legacy);
    assert.equal(summary.status, "LEGACY_UNAVAILABLE");
    assert.equal(summary.manifestId, null);
    assert.equal(summary.latestIncludedInputAt, null);
    assert.equal(legacy.inputManifest, undefined);
  });

  check("Q14 availableAt equality at cutoff is intentionally accepted", () => {
    const equalitySource = source({
      type: "feature-input",
      id: "cutoff-boundary",
      observation: "cutoff-boundary:v1",
      availableAt: CUTOFF,
      payload: { admittedAtBoundary: true },
    });
    const equalityManifest = manifestFrom(baseReferences, [equalitySource]);
    assert.equal(equalityManifest.latestIncludedInputAt, CUTOFF);
    assert.equal(equalityManifest.cutoffAt, CUTOFF);
    assert.equal(equalityManifest.inputLineageStatus, "PIT_VERIFIED");
  });

  check("Q15 payload, bundle, rating, manifest and replay hashes are deterministic", () => {
    const sourceA = source({
      type: "determinism",
      id: "canonical-payload",
      observation: "canonical-payload:v1",
      availableAt: "2026-08-01T00:00:00.000Z",
      payload: { b: 2, a: 1 },
    });
    const sourceB = source({
      type: "determinism",
      id: "canonical-payload",
      observation: "canonical-payload:v1",
      availableAt: "2026-08-01T00:00:00.000Z",
      payload: { a: 1, b: 2 },
    });
    assert.equal(sourceA.payloadHash, sourceB.payloadHash);
    assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));

    const bundleAgain = makeModelBundle({
      notes: modelParameters.notes,
      trainingWindow: { to: "2025-05-31", from: "2018-08-01" },
      fittedAt: modelParameters.fittedAt,
      kFactor: modelParameters.kFactor,
      awayHomeShare: modelParameters.awayHomeShare,
      baseGoals: modelParameters.baseGoals,
      goalScale: modelParameters.goalScale,
      drawBias: modelParameters.drawBias,
      dcRho: modelParameters.dcRho,
      homeAdvantage: modelParameters.homeAdvantage,
      modelVersion: modelParameters.modelVersion,
      competition: modelParameters.competition,
    });
    assert.equal(bundleAgain.modelBundleHash, modelBundle.modelBundleHash);
    assert.equal(bundleAgain.modelBundleId, modelBundle.modelBundleId);

    const ratingAgain = buildFrozenRatingState({
      season: SEASON,
      asOf: CUTOFF,
      availableAt: "2026-09-05T18:01:00.000Z",
      modelVersion: PRODUCTION_MODEL_VERSION,
      formulaVersion: "elo-v1",
      seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
      ratingEvents: [ratingEvent],
      state: {
        season: SEASON,
        clubSlugs: ["arsenal", "chelsea"],
        ratings: { chelsea: 1548, arsenal: 1612 },
        matchesPlayedSeason: { chelsea: 3, arsenal: 3 },
      },
    });
    assert.equal(ratingAgain.ratingStateHash, ratingState.ratingStateHash);
    assert.equal(ratingAgain.ratingStateId, ratingState.ratingStateId);

    const manifestAgain = manifestFrom(baseReferences);
    assert.equal(manifestAgain.manifestPayloadHash, resolved.manifest.manifestPayloadHash);
    assert.equal(manifestAgain.manifestId, resolved.manifest.manifestId);
    assert.equal(
      replayForecastInputManifest(manifestAgain, baseReferences).replayHash,
      replayHash
    );

    const changedBundle = makeModelBundle({ ...modelParameters, homeAdvantage: 73 });
    assert.notEqual(changedBundle.modelBundleId, modelBundle.modelBundleId);
    const redeployedBundle = makeModelBundle(modelParameters, "e".repeat(40));
    assert.notEqual(redeployedBundle.modelBundleId, modelBundle.modelBundleId);
  });

  check("same-timestamp post-result rating state wins deterministically", () => {
    const tiedAt = "2026-09-08T18:00:00.000Z";
    const sameTickEvent = buildRatingEventReference({
      ratingEventId: "phase4a3-same-tick-rating",
      fixtureId: "phase4a3-same-tick-result",
      fixtureKickoff: "2026-09-08T15:00:00.000Z",
      appliedAt: tiedAt,
      availableAt: tiedAt,
      payload: { homeScore: 3, awayScore: 0, delta: 9 },
    });
    const beforeUpdate = buildFrozenRatingState({
      season: SEASON,
      asOf: tiedAt,
      availableAt: tiedAt,
      modelVersion: PRODUCTION_MODEL_VERSION,
      formulaVersion: "elo-v1",
      seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
      ratingEvents: [ratingEvent],
      state: ratingState.state,
    });
    const afterUpdate = buildFrozenRatingState({
      season: SEASON,
      asOf: tiedAt,
      availableAt: tiedAt,
      modelVersion: PRODUCTION_MODEL_VERSION,
      formulaVersion: "elo-v1",
      seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
      ratingEvents: [ratingEvent, sameTickEvent],
      state: {
        season: SEASON,
        clubSlugs: ["arsenal", "chelsea"],
        ratings: { arsenal: 1621, chelsea: 1539 },
        matchesPlayedSeason: { arsenal: 4, chelsea: 4 },
      },
    });
    insertProvenanceRecords([beforeUpdate, afterUpdate]);
    const tiedResolution = resolveProspectiveForecastInput({
      fixtureId: FIXTURE_ID,
      stage: "T2H",
      cutoffAt: CUTOFF,
      generatedAt: GENERATED,
    });
    assert.equal(
      tiedResolution.references.ratingState.ratingStateId,
      afterUpdate.ratingStateId
    );
    assert.equal(tiedResolution.references.ratingState.ratingEvents.length, 2);
    const predicted = predictPremierLeagueFromFrozenInputs(tiedResolution.sealedInput);
    assert.equal(predicted.artifact.elo.home, 1621);
    assert.equal(predicted.artifact.elo.away, 1539);
  });

  check("sealed predictor source/import boundary contains no mutable-state access", () => {
    const sealedPath = path.resolve(
      process.cwd(),
      "lib/prediction-engine/sealed-premier-league.ts"
    );
    const sourceText = fs.readFileSync(sealedPath, "utf8");
    const importTargets = [...sourceText.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    assert.equal(
      importTargets.some((target) =>
        /(?:^|\/)(?:store|db|database|mongodb|fixture-store|live-ratings|model-tracks)(?:\/|$|\.)/i.test(
          target
        )
      ),
      false
    );
    const executable = sourceText
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\bDate\.now\s*\(/,
      /\bprocess\.env\b/,
      /\bdatabase\b/i,
      /\bmongodb\b/i,
      /\bstore\b/i,
    ]) {
      assert.equal(forbidden.test(executable), false, String(forbidden));
    }
  });

  const counts = Object.fromEntries(
    Object.entries(provenanceFilePaths()).map(([kind, file]) => [kind, lines(file).length])
  );
  console.log(`\nPhase 4A.3 prospective PIT: ${passed} passed, 0 failed.`);
  console.log(`Isolated evidence rows: ${JSON.stringify(counts)}`);
}

try {
  main();
} finally {
  delete process.env.MONGODB_URI;
  fs.rmSync(TEMP, { recursive: true, force: true });
}
