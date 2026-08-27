/** Phase 4A4: deterministic prospective rating/result lineage gates. */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  assertVerifiedRatingStateLineage,
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
  compareRatingStates,
  ratingReplayMatchesExactly,
  recomputeProspectiveRatingState,
  selectPITVerifiedResults,
} from "@/lib/competitions/premier-league/provenance";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import type { RatingAppliedEvent } from "@/lib/competitions/premier-league/ops/types";

const SEASON = "2026-27";
const CUTOFF = "2026-08-20T12:00:00.000Z";
const AFTER = "2026-08-20T12:00:01.000Z";
const COMMIT = "d".repeat(40);
const FEATURE = "pl-sealed-predictor-v1+elo-pl-live-v0.2.0";
const FORMULA = "elo-pl-live-v0.2.0";
let passed = 0;

function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function source(type: string, id: string, availableAt: string, payload: unknown) {
  return buildSourceObservationReference({
    sourceType: type,
    sourceId: id,
    sourceVersion: "v1",
    observationId: `${type}:${id}:${availableAt}`,
    publishedAt: availableAt,
    availableAt,
    retrievedAt: availableAt,
    payload,
  });
}

function fixture(
  fixtureId: string,
  kickoffAt: string,
  availableAt: string,
  homeSlug = "arsenal",
  awaySlug = "chelsea",
  status = "FINISHED"
) {
  return buildFixtureRevision({
    season: SEASON,
    fixtureId,
    homeSlug,
    awaySlug,
    kickoffAt,
    status,
    venue: "home",
    sourceObservation: source("fixture", fixtureId, availableAt, {
      fixtureId,
      kickoffAt,
      status,
    }),
  });
}

function result(
  fixtureId: string,
  availableAt: string,
  homeScore: number,
  awayScore: number,
  sourceId: string,
  supersedesResultRevisionId?: string
) {
  return buildResultRevision({
    season: SEASON,
    fixtureId,
    status: "FINISHED",
    homeScore,
    awayScore,
    sourceObservation: source("result", sourceId, availableAt, {
      fixtureId,
      homeScore,
      awayScore,
    }),
    supersedesResultRevisionId,
  });
}

function verification(
  fixtureId: string,
  kickoffUtc: string,
  appliedAt: string,
  homeSlug: string,
  awaySlug: string,
  homeGoals: number,
  awayGoals: number
): RatingAppliedEvent {
  return {
    eventId: `rating-apply::${fixtureId}`,
    fixtureId,
    season: SEASON,
    kickoffUtc,
    homeSlug,
    awaySlug,
    homeGoals,
    awayGoals,
    preHome: 1500,
    preAway: 1500,
    postHome: 1501,
    postAway: 1499,
    formulaVersion: FORMULA,
    modelVersion: PRODUCTION_MODEL_VERSION,
    appliedAt,
  };
}

const membership = buildSeasonMembershipSnapshot({
  season: SEASON,
  teamSlugs: ["arsenal", "chelsea"],
  sourceObservations: [
    source("membership", SEASON, "2026-07-01T00:00:00.000Z", {
      clubs: ["arsenal", "chelsea"],
    }),
  ],
  verificationStatus: "VERIFIED",
  verifiedAt: "2026-07-01T00:00:00.000Z",
  verifiedAgainst: ["independent-membership-audit"],
  verificationArtifact: "phase4a4-membership-audit",
});

const f1 = fixture(
  "phase4a4-one",
  "2026-08-01T15:00:00.000Z",
  "2026-07-01T00:00:00.000Z"
);
const f2 = fixture(
  "phase4a4-two",
  "2026-08-05T15:00:00.000Z",
  "2026-07-01T00:00:00.000Z",
  "chelsea",
  "arsenal"
);
const target = fixture(
  "phase4a4-target",
  "2026-08-21T12:00:00.000Z",
  "2026-07-01T00:00:00.000Z",
  "arsenal",
  "chelsea",
  "SCHEDULED"
);

const r1 = result(f1.fixtureId, "2026-08-01T18:00:00.000Z", 2, 0, "feed-a");
const r1Correction = result(
  f1.fixtureId,
  "2026-08-02T09:00:00.000Z",
  2,
  1,
  "feed-a",
  r1.resultRevisionId
);
const correctionBefore = buildResultCorrection({
  fixtureId: f1.fixtureId,
  previousResultRevisionId: r1.resultRevisionId,
  correctedResultRevisionId: r1Correction.resultRevisionId,
  detectedAt: "2026-08-02T09:00:00.000Z",
  availableAt: "2026-08-02T09:00:00.000Z",
});
const r1After = result(
  f1.fixtureId,
  AFTER,
  3,
  1,
  "feed-a",
  r1Correction.resultRevisionId
);
const correctionAfter = buildResultCorrection({
  fixtureId: f1.fixtureId,
  previousResultRevisionId: r1Correction.resultRevisionId,
  correctedResultRevisionId: r1After.resultRevisionId,
  detectedAt: AFTER,
  availableAt: AFTER,
});
const r2a = result(f2.fixtureId, "2026-08-05T18:00:00.000Z", 0, 0, "feed-a");
const r2b = result(f2.fixtureId, "2026-08-05T18:01:00.000Z", 0, 0, "feed-b");
const futureResult = result(target.fixtureId, AFTER, 1, 0, "feed-a");

const verificationEvents = [
  verification(
    f2.fixtureId,
    f2.kickoffAt,
    "2026-08-05T18:02:00.000Z",
    f2.homeSlug,
    f2.awaySlug,
    0,
    0
  ),
  verification(
    f1.fixtureId,
    f1.kickoffAt,
    "2026-08-01T18:01:00.000Z",
    f1.homeSlug,
    f1.awaySlug,
    2,
    0
  ),
  verification(
    target.fixtureId,
    target.kickoffAt,
    AFTER,
    target.homeSlug,
    target.awaySlug,
    1,
    0
  ),
];
const allResults = [r2b, futureResult, r1After, r1, r2a, r1Correction];
const allFixtures = [target, f2, f1];
const allCorrections = [correctionAfter, correctionBefore];

const legacyEvent = buildRatingEventReference({
  ratingEventId: "rating-apply::legacy",
  fixtureId: f1.fixtureId,
  fixtureKickoff: f1.kickoffAt,
  appliedAt: "2026-08-01T18:01:00.000Z",
  payload: { historical: true },
  resultRevisionId: null,
});
const legacyState = buildFrozenRatingState({
  season: SEASON,
  asOf: "2026-08-06T00:00:00.000Z",
  availableAt: "2026-08-06T00:00:00.000Z",
  modelVersion: PRODUCTION_MODEL_VERSION,
  formulaVersion: FORMULA,
  seasonMembershipSnapshotId: membership.seasonMembershipSnapshotId,
  ratingEvents: [legacyEvent],
  state: {
    season: SEASON,
    clubSlugs: membership.teamSlugs,
    ratings: { arsenal: 1500, chelsea: 1500 },
    matchesPlayedSeason: { arsenal: 0, chelsea: 0 },
  },
});
const legacyBytes = canonicalJson(legacyState);

const selected = selectPITVerifiedResults({
  season: SEASON,
  cutoffAt: CUTOFF,
  modelVersion: PRODUCTION_MODEL_VERSION,
  formulaVersion: FORMULA,
  resultRevisions: allResults,
  correctionLinks: allCorrections,
  fixtureRevisions: allFixtures,
  verificationEvents,
});
const recomputed = recomputeProspectiveRatingState({
  computedAt: CUTOFF,
  membership,
  modelVersion: PRODUCTION_MODEL_VERSION,
  formulaVersion: FORMULA,
  featureCodeVersion: FEATURE,
  codeCommitSha: COMMIT,
  resultRevisions: allResults,
  correctionLinks: allCorrections,
  fixtureRevisions: allFixtures,
  verificationEvents,
});

check("K1 old rating state remains byte-identical", () => {
  assert.equal(canonicalJson(legacyState), legacyBytes);
});
check("K2 legacy null resultRevisionId is not patched", () => {
  assert.equal(legacyState.ratingEvents[0].resultRevisionId, null);
  assert.equal(legacyState.ratingResultLineageStatus, undefined);
});
check("K3 new state contains exact complete result lineage", () => {
  assert.equal(recomputed.ratingState.ratingResultLineageStatus, "VERIFIED");
  assert.equal(recomputed.ratingState.ratingEvents.length, 2);
  assert.deepEqual(
    recomputed.ratingState.orderedResultRevisionIds,
    recomputed.ratingState.ratingEvents.map((event) => event.resultRevisionId)
  );
  assert.ok(recomputed.ratingState.ratingStateContentHash);
});
check("K4 future result revision is excluded", () => {
  assert.ok(!recomputed.ratingState.orderedResultRevisionIds?.includes(futureResult.resultRevisionId));
});
check("K5 post-cutoff correction is excluded", () => {
  assert.ok(!recomputed.ratingState.orderedResultRevisionIds?.includes(r1After.resultRevisionId));
});
check("K6 pre-cutoff correction is selected deterministically", () => {
  assert.equal(selected[0].resultRevision.resultRevisionId, r1Correction.resultRevisionId);
});
check("K7 duplicate equivalent results apply once", () => {
  assert.equal(selected.filter((row) => row.fixtureRevision.fixtureId === f2.fixtureId).length, 1);
  assert.equal(selected[1].resultRevision.resultRevisionId, r2b.resultRevisionId);
});
check("K8 result order is kickoff then fixture identity", () => {
  assert.deepEqual(
    recomputed.selectedResults.map((row) => row.fixtureRevision.fixtureId),
    [f1.fixtureId, f2.fixtureId]
  );
});

const recomputedAgain = recomputeProspectiveRatingState({
  computedAt: CUTOFF,
  membership,
  modelVersion: PRODUCTION_MODEL_VERSION,
  formulaVersion: FORMULA,
  featureCodeVersion: FEATURE,
  codeCommitSha: COMMIT,
  resultRevisions: [...allResults].reverse(),
  correctionLinks: [...allCorrections].reverse(),
  fixtureRevisions: [...allFixtures].reverse(),
  verificationEvents: [...verificationEvents].reverse(),
});
check("K9 identical revisions generate identical semantic state hash", () => {
  assert.equal(recomputedAgain.ratingState.ratingStateHash, recomputed.ratingState.ratingStateHash);
});
check("K10 full state recomputation is deterministic", () => {
  assert.equal(recomputedAgain.ratingState.ratingStateId, recomputed.ratingState.ratingStateId);
  assert.equal(canonicalJson(recomputedAgain), canonicalJson(recomputed));
});

const model = buildImmutableModelBundle({
  modelId: "football-oracle-premier-league-production",
  modelVersion: PRODUCTION_MODEL_VERSION,
  trainingCutoff: "2025-05-31T23:59:59.999Z",
  parameterPayload: { modelVersion: PRODUCTION_MODEL_VERSION, kFactor: 20 },
  featureSchemaVersion: "pl-features-v0.2.0",
  featureCodeVersion: FEATURE,
  createdAt: "2026-07-01T00:00:00.000Z",
  availableAt: "2026-07-01T00:00:00.000Z",
  codeCommitSha: COMMIT,
});

check("K11 manifest cannot be verified with incomplete rating lineage", () => {
  assert.throws(
    () =>
      buildForecastInputManifest({
        fixtureId: target.fixtureId,
        season: SEASON,
        forecastStage: "T24H",
        cutoffAt: CUTOFF,
        generatedAt: "2026-08-20T12:00:01.000Z",
        kickoffAtAsKnown: target.kickoffAt,
        applicationCommitSha: COMMIT,
        fixtureRevision: target,
        seasonMembership: membership,
        ratingState: legacyState,
        modelBundle: model,
      }),
    /incompatible|incomplete/
  );
});
check("K12 incompatible rating state cannot enter a production manifest", () => {
  const incompatibleModel = buildImmutableModelBundle({
    modelId: model.modelId,
    modelVersion: model.modelVersion,
    trainingCutoff: model.trainingCutoff,
    parameterPayload: model.parameterPayload,
    featureSchemaVersion: model.featureSchemaVersion,
    featureCodeVersion: `${FEATURE}-different`,
    createdAt: model.createdAt,
    availableAt: model.availableAt,
    codeCommitSha: model.codeCommitSha,
  });
  assert.throws(
    () =>
      buildForecastInputManifest({
        fixtureId: target.fixtureId,
        season: SEASON,
        forecastStage: "T24H",
        cutoffAt: CUTOFF,
        generatedAt: "2026-08-20T12:00:01.000Z",
        kickoffAtAsKnown: target.kickoffAt,
        applicationCommitSha: COMMIT,
        fixtureRevision: target,
        seasonMembership: membership,
        ratingState: recomputed.ratingState,
        modelBundle: incompatibleModel,
        ratingResultRevisions: recomputed.selectedResults.map((row) => row.resultRevision),
        ratingFixtureRevisions: recomputed.selectedResults.map((row) => row.fixtureRevision),
      }),
    /incompatible/
  );
});
check("K13 recomputation has no mutable current-result dependency", () => {
  const sourceText = fs.readFileSync(
    "lib/competitions/premier-league/provenance/rating-lineage.ts",
    "utf8"
  );
  assert.doesNotMatch(sourceText, /result-feed|live-ratings|fixture-store/);
});
check("K14 exact result and fixture records traverse and validate", () => {
  assert.doesNotThrow(() =>
    assertVerifiedRatingStateLineage({
      ratingState: recomputed.ratingState,
      resultRevisions: recomputed.selectedResults.map((row) => row.resultRevision),
      fixtureRevisions: recomputed.selectedResults.map((row) => row.fixtureRevision),
      seasonMembership: membership,
      cutoffAt: CUTOFF,
    })
  );
});
check("K15 semantic replay equality metrics are exact", () => {
  const comparison = compareRatingStates(
    recomputed.ratingState.state,
    recomputedAgain.ratingState.state
  );
  assert.equal(comparison.maxAbsoluteRatingDifference, 0);
  assert.equal(comparison.meanAbsoluteRatingDifference, 0);
  assert.equal(comparison.differingTeamCount, 0);
  assert.equal(comparison.recomputedStateHash, comparison.productionStateHash);
});

const manifest = buildForecastInputManifest({
  fixtureId: target.fixtureId,
  season: SEASON,
  forecastStage: "T24H",
  cutoffAt: CUTOFF,
  generatedAt: "2026-08-20T12:00:01.000Z",
  kickoffAtAsKnown: target.kickoffAt,
  applicationCommitSha: COMMIT,
  fixtureRevision: target,
  seasonMembership: membership,
  ratingState: recomputed.ratingState,
  modelBundle: model,
  ratingResultRevisions: recomputed.selectedResults.map((row) => row.resultRevision),
  ratingFixtureRevisions: recomputed.selectedResults.map((row) => row.fixtureRevision),
});
check("K16 complete manifest exposes machine-auditable result IDs", () => {
  assert.equal(manifest.ratingResultLineageStatus, "VERIFIED");
  assert.deepEqual(
    manifest.ratingResultRevisionIds,
    recomputed.ratingState.orderedResultRevisionIds
  );
  assert.equal(manifest.inputLineageStatus, "PIT_VERIFIED");
});
check("K17 unresolved terminal score conflict fails closed", () => {
  const conflicting = result(
    f1.fixtureId,
    "2026-08-03T09:00:00.000Z",
    4,
    1,
    "feed-conflict"
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [...allResults, conflicting],
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /Conflicting PIT result revisions/
  );
});
check("K18 incompatible correction link fails closed", () => {
  const incompatible = buildResultCorrection({
    fixtureId: f2.fixtureId,
    previousResultRevisionId: r2a.resultRevisionId,
    correctedResultRevisionId: r2b.resultRevisionId,
    detectedAt: "2026-08-05T18:01:00.000Z",
    availableAt: "2026-08-05T18:01:00.000Z",
  });
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: allResults,
        correctionLinks: [...allCorrections, incompatible],
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /incompatible result lineage/
  );
});
check("K19 new event availability records computation time, never a backdate", () => {
  for (const event of recomputed.ratingState.ratingEvents) {
    assert.equal(event.appliedAt, CUTOFF);
    assert.equal(event.availableAt, CUTOFF);
    assert.ok(Date.parse(event.resultAvailableAt!) <= Date.parse(event.availableAt));
  }
});
check("K20 score-changing revision without correction link fails closed", () => {
  const unlinked = result(
    f1.fixtureId,
    "2026-08-03T10:00:00.000Z",
    5,
    1,
    "feed-a",
    r1Correction.resultRevisionId
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [...allResults, unlinked],
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /correction lineage is incomplete/
  );
});
check("K21 incompatible verification version fails closed", () => {
  const incompatibleEvent = { ...verificationEvents[0], formulaVersion: "wrong-formula" };
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: allResults,
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents: [incompatibleEvent, ...verificationEvents.slice(1)],
      }),
    /Incompatible rating verification event/
  );
});

check("K22 sub-tolerance semantic hash drift still fails exact equality", () => {
  const drifted = {
    ...recomputed.ratingState.state,
    ratings: {
      ...recomputed.ratingState.state.ratings,
      arsenal: recomputed.ratingState.state.ratings.arsenal + 5e-10,
    },
  };
  const comparison = compareRatingStates(
    recomputed.ratingState.state,
    drifted
  );
  assert.equal(comparison.differingTeamCount, 0);
  assert.notEqual(comparison.recomputedStateHash, comparison.productionStateHash);
  assert.equal(ratingReplayMatchesExactly(comparison), false);
});

check("K23 eligible supersession with a missing predecessor fails closed", () => {
  const missing = result(
    f1.fixtureId,
    "2026-08-03T11:00:00.000Z",
    2,
    1,
    "feed-missing",
    "pl-result-revision:missing"
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [...allResults, missing],
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /supersedes a missing result revision/
  );
});

check("K24 eligible supersession cannot cross fixture lineage", () => {
  const incompatible = result(
    f1.fixtureId,
    "2026-08-03T12:00:00.000Z",
    2,
    1,
    "feed-incompatible",
    r2a.resultRevisionId
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [...allResults, incompatible],
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /incompatible supersession lineage/
  );
});

check("K25 eligible supersession cannot point to a later revision", () => {
  const later = result(
    f1.fixtureId,
    "2026-08-04T12:00:00.000Z",
    2,
    1,
    "feed-temporal"
  );
  const earlier = result(
    f1.fixtureId,
    "2026-08-03T12:00:00.000Z",
    2,
    1,
    "feed-temporal",
    later.resultRevisionId
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [...allResults, later, earlier],
        correctionLinks: allCorrections,
        fixtureRevisions: allFixtures,
        verificationEvents,
      }),
    /supersedes a temporally later revision/
  );
});

check("K26 prospective rating event identity binds verificationEventId", () => {
  const changed = recomputeProspectiveRatingState({
    computedAt: CUTOFF,
    membership,
    modelVersion: PRODUCTION_MODEL_VERSION,
    formulaVersion: FORMULA,
    featureCodeVersion: FEATURE,
    codeCommitSha: COMMIT,
    resultRevisions: allResults,
    correctionLinks: allCorrections,
    fixtureRevisions: allFixtures,
    verificationEvents: verificationEvents.map((event, index) =>
      index === 0 ? { ...event, eventId: `${event.eventId}:replacement` } : event
    ),
  });
  assert.notEqual(
    changed.ratingState.ratingEvents[1].ratingEventId,
    recomputed.ratingState.ratingEvents[1].ratingEventId
  );
});

check("K27 a forged final rating payload cannot be VERIFIED", () => {
  const forged = buildFrozenRatingState({
    season: recomputed.ratingState.season,
    asOf: recomputed.ratingState.asOf,
    availableAt: recomputed.ratingState.availableAt,
    modelVersion: recomputed.ratingState.modelVersion,
    formulaVersion: recomputed.ratingState.formulaVersion,
    seasonMembershipSnapshotId:
      recomputed.ratingState.seasonMembershipSnapshotId,
    ratingEvents: recomputed.ratingState.ratingEvents,
    state: {
      ...recomputed.ratingState.state,
      ratings: {
        ...recomputed.ratingState.state.ratings,
        arsenal: recomputed.ratingState.state.ratings.arsenal + 1,
      },
    },
    ratingResultLineageStatus: "VERIFIED",
    featureCodeVersion: FEATURE,
    codeCommitSha: COMMIT,
  });
  assert.throws(
    () =>
      assertVerifiedRatingStateLineage({
        ratingState: forged,
        resultRevisions: recomputed.selectedResults.map(
          (row) => row.resultRevision
        ),
        fixtureRevisions: recomputed.selectedResults.map(
          (row) => row.fixtureRevision
        ),
        seasonMembership: membership,
        cutoffAt: CUTOFF,
      }),
    /final state does not match/
  );
});

check("K28 manifest application SHA must equal the model bundle SHA", () => {
  assert.throws(
    () =>
      buildForecastInputManifest({
        fixtureId: target.fixtureId,
        season: SEASON,
        forecastStage: "T24H",
        cutoffAt: CUTOFF,
        generatedAt: "2026-08-20T12:00:01.000Z",
        kickoffAtAsKnown: target.kickoffAt,
        applicationCommitSha: "e".repeat(40),
        fixtureRevision: target,
        seasonMembership: membership,
        ratingState: recomputed.ratingState,
        modelBundle: model,
        ratingResultRevisions: recomputed.selectedResults.map(
          (row) => row.resultRevision
        ),
        ratingFixtureRevisions: recomputed.selectedResults.map(
          (row) => row.fixtureRevision
        ),
      }),
    /application commit does not match/
  );
});

check("K29 selected result must anchor the exact verified score", () => {
  const scoreFixture = fixture(
    "phase4a4-score-anchor",
    "2026-08-10T15:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
  // 3-1 and 2-0 share outcome and goal difference, so an Elo-only equality
  // check cannot detect this provenance substitution.
  const unrelatedSameElo = result(
    scoreFixture.fixtureId,
    "2026-08-10T18:00:00.000Z",
    3,
    1,
    "feed-unrelated"
  );
  assert.throws(
    () =>
      selectPITVerifiedResults({
        season: SEASON,
        cutoffAt: CUTOFF,
        modelVersion: PRODUCTION_MODEL_VERSION,
        formulaVersion: FORMULA,
        resultRevisions: [unrelatedSameElo],
        correctionLinks: [],
        fixtureRevisions: [scoreFixture],
        verificationEvents: [
          verification(
            scoreFixture.fixtureId,
            scoreFixture.kickoffAt,
            "2026-08-10T18:01:00.000Z",
            scoreFixture.homeSlug,
            scoreFixture.awaySlug,
            2,
            0
          ),
        ],
      }),
    /do not anchor the verified score/
  );
});

console.log(`\nPhase 4A4 rating lineage: ${passed} passed, 0 failed.`);
