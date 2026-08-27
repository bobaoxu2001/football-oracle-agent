import assert from "node:assert/strict";
import {
  HISTORICAL_REPLAY_TRACK,
  canonicalPayloadHash,
  prepareHistoricalReplay,
  runHistoricalReplay,
  type HistoricalReplayRequest,
  type PitReplayInput,
} from "@/lib/evaluation/pit-replay";
import {
  listLiveSnapshots,
  liveSnapshotIdentity,
} from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function hashed(input: Omit<PitReplayInput, "contentHash">): PitReplayInput {
  return { ...input, contentHash: canonicalPayloadHash(input.payload) };
}

function changed(
  input: PitReplayInput,
  overrides: Partial<PitReplayInput>
): PitReplayInput {
  const next = { ...input, ...overrides };
  return { ...next, contentHash: canonicalPayloadHash(next.payload) };
}

const request: HistoricalReplayRequest = {
  fixtureId: "fixture-1",
  forecastStage: "T24H",
  cutoffAt: "2025-08-09T14:00:00.000Z",
  kickoffAtAsKnown: "2025-08-10T14:00:00.000Z",
  modelVersion: "pl-test-v1",
  featureVersion: "pl-feature-v1",
  codeVersion: "commit-abc",
  replayExecutedAt: "2026-08-27T00:00:00.000Z",
};

const ratingPayload = { home: 1600, away: 1500 };
const rating = hashed({
  inputId: "rating-home",
  kind: "rating_state",
  sourceId: "rating-event-tape",
  availableAt: "2025-08-08T20:00:00.000Z",
  classification: "VERIFIED_PIT",
  immutable: true,
  payload: ratingPayload,
});

const fixturePayload = {
  fixtureId: request.fixtureId,
  kickoffAt: request.kickoffAtAsKnown,
};
const fixture = hashed({
  inputId: "fixture-v1",
  kind: "fixture_metadata",
  sourceId: "fixture-snapshot-v1",
  availableAt: "2025-06-20T09:00:00.000Z",
  classification: "VERIFIED_PIT",
  immutable: true,
  subjectFixtureId: request.fixtureId,
  kickoffAtAsKnown: request.kickoffAtAsKnown,
  payload: fixturePayload,
});

const paramsPayload = {
  modelVersion: request.modelVersion,
  featureVersion: request.featureVersion,
  trainingCutoffAt: "2025-05-31T23:59:59.000Z",
  parameters: { homeAdvantage: 72, rho: -0.061 },
};
const params = hashed({
  inputId: "params-v1",
  kind: "model_parameters",
  sourceId: "model-bundle-v1",
  availableAt: "2025-05-31T23:59:59.000Z",
  classification: "RECONSTRUCTABLE_FROM_IMMUTABLE_RAW",
  immutable: true,
  bundleModelVersion: request.modelVersion,
  bundleFeatureVersion: request.featureVersion,
  trainingCutoffAt: "2025-05-31T23:59:59.000Z",
  payload: paramsPayload,
});

const required = ["fixture_metadata", "model_parameters", "rating_state"];
const predictor = (rows: readonly PitReplayInput[]) => {
  const state = rows.find((row) => row.kind === "rating_state")?.payload as {
    home: number;
    away: number;
  };
  const edge = Math.max(-0.15, Math.min(0.15, (state.home - state.away) / 1000));
  return { home: 0.4 + edge, draw: 0.25, away: 0.35 - edge };
};

function liveLedgerIdentities(): string[] {
  return listLiveSnapshots({
    season: PREMIER_LEAGUE_CURRENT_SEASON,
    evaluationClass: "LIVE_OOS",
  })
    .map(liveSnapshotIdentity)
    .sort();
}

test("valid replay is admitted", () => {
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, true);
  assert.equal(admission.track, HISTORICAL_REPLAY_TRACK);
  assert.deepEqual(admission.issues, []);
  assert.equal(admission.maxInputAvailableAt, rating.availableAt);
});

test("cutoff may equal an input availableAt", () => {
  const onCutoff = changed(rating, {
    inputId: "rating-on-cutoff",
    availableAt: request.cutoffAt,
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, onCutoff, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, true);
  assert.equal(admission.maxInputAvailableAt, request.cutoffAt);
});

test("future result is ignored and cannot change the forecast", () => {
  const future = changed(rating, {
    inputId: "future-result",
    kind: "completed_result",
    availableAt: "2025-08-10T16:00:00.000Z",
    payload: { homeGoals: 9, awayGoals: 0 },
  });
  const base = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
    predict: predictor,
  });
  const injected = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params, future],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.deepEqual(injected.probabilities, base.probabilities);
  assert.equal(injected.replayKey, base.replayKey);
});

test("post-cutoff correction reusing an input ID is ignored before conflict analysis", () => {
  const futureCorrection = changed(rating, {
    availableAt: "2025-08-10T16:00:00.000Z",
    payload: { home: 9999, away: 1 },
  });
  const base = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  const injected = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, futureCorrection, params],
    requiredInputKinds: required,
  });
  assert.equal(base.admissible, true);
  assert.equal(injected.admissible, true);
  assert.equal(injected.replayKey, base.replayKey);
  assert.deepEqual(injected.excludedPostCutoffInputIds, [rating.inputId]);
});

test("future standings row is ignored", () => {
  const future = changed(rating, {
    inputId: "future-table",
    kind: "standings",
    availableAt: "2025-08-10T18:00:00.000Z",
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params, future],
    requiredInputKinds: required,
  });
  assert.deepEqual(admission.excludedPostCutoffInputIds, ["future-table"]);
});

test("future lineup is ignored", () => {
  const future = changed(rating, {
    inputId: "future-lineup",
    kind: "lineup",
    availableAt: "2025-08-10T13:00:00.000Z",
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params, future],
    requiredInputKinds: required,
  });
  assert.deepEqual(admission.excludedPostCutoffInputIds, ["future-lineup"]);
});

test("post-cutoff reschedule cannot replace kickoff-as-known", () => {
  const revisedKickoff = "2025-08-11T14:00:00.000Z";
  const revised = changed(fixture, {
    inputId: "fixture-v2",
    sourceId: "fixture-snapshot-v2",
    availableAt: "2025-08-09T18:00:00.000Z",
    kickoffAtAsKnown: revisedKickoff,
    payload: { fixtureId: request.fixtureId, kickoffAt: revisedKickoff },
  });
  const artifact = runHistoricalReplay({
    request,
    inputs: [fixture, revised, rating, params],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.equal(artifact.kickoffAtAsKnown, request.kickoffAtAsKnown);
  assert.ok(!artifact.sourceAvailableAt.some((row) => row.inputId === "fixture-v2"));
});

test("latest pre-cutoff fixture revision is authoritative", () => {
  const revisedKickoff = "2025-08-11T14:00:00.000Z";
  const revised = changed(fixture, {
    inputId: "fixture-v2",
    sourceId: "fixture-snapshot-v2",
    availableAt: "2025-08-08T21:00:00.000Z",
    kickoffAtAsKnown: revisedKickoff,
    payload: { fixtureId: request.fixtureId, kickoffAt: revisedKickoff },
  });
  const revisedRequest: HistoricalReplayRequest = {
    ...request,
    cutoffAt: "2025-08-10T14:00:00.000Z",
    kickoffAtAsKnown: revisedKickoff,
  };
  const admission = prepareHistoricalReplay({
    request: revisedRequest,
    inputs: [fixture, revised, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, true);
  assert.deepEqual(admission.excludedSupersededInputIds, ["fixture-v1"]);
  assert.equal(
    admission.includedInputs.find((row) => row.kind === "fixture_metadata")?.inputId,
    "fixture-v2"
  );
});

test("request kickoff must match latest pre-cutoff fixture revision", () => {
  const revisedKickoff = "2025-08-11T14:00:00.000Z";
  const revised = changed(fixture, {
    inputId: "fixture-v2",
    sourceId: "fixture-snapshot-v2",
    availableAt: "2025-08-08T21:00:00.000Z",
    kickoffAtAsKnown: revisedKickoff,
    payload: { fixtureId: request.fixtureId, kickoffAt: revisedKickoff },
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, revised, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "KICKOFF_AS_KNOWN_MISMATCH"));
});

test("same-time conflicting fixture revisions fail closed", () => {
  const otherKickoff = "2025-08-11T14:00:00.000Z";
  const conflict = changed(fixture, {
    inputId: "fixture-conflict",
    sourceId: "fixture-conflict-source",
    kickoffAtAsKnown: otherKickoff,
    payload: { fixtureId: request.fixtureId, kickoffAt: otherKickoff },
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, conflict, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "FIXTURE_METADATA_AMBIGUOUS_AT_CUTOFF")
  );
});

test("timed-stage cutoff must match the deterministic production window", () => {
  const bad = { ...request, cutoffAt: "2025-08-09T13:59:59.000Z" };
  const admission = prepareHistoricalReplay({
    request: bad,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "STAGE_CUTOFF_MISMATCH"));
});

test("replay forecast identity is deterministic and production ledger is unchanged", () => {
  const before = liveLedgerIdentities();
  const first = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
    predict: predictor,
  });
  const second = runHistoricalReplay({
    request: { ...request, replayExecutedAt: "2026-08-28T00:00:00.000Z" },
    inputs: [params, fixture, rating],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.equal(first.replayKey, second.replayKey);
  assert.equal(first.predictionDigest, second.predictionDigest);
  assert.deepEqual(first.probabilities, second.probabilities);
  assert.deepEqual(liveLedgerIdentities(), before);
});

test("replay artifact cannot claim the production track", () => {
  const artifact = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.equal(artifact.track, "HISTORICAL_REPLAY");
  assert.notEqual(artifact.track as string, "LIVE_OOS");
});

test("missing availableAt fails closed", () => {
  const unsafe = { ...rating, availableAt: null };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "INPUT_AVAILABLE_AT_MISSING_OR_INVALID")
  );
});

test("timezone-less timestamps fail closed", () => {
  const unsafe = { ...rating, availableAt: "2025-08-08T20:00:00" };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "INPUT_AVAILABLE_AT_MISSING_OR_INVALID")
  );
});

test("equivalent explicit offsets normalize and inputs sort by instant", () => {
  const earlier = changed(rating, {
    inputId: "rating-earlier",
    sourceId: "rating-event-earlier",
    availableAt: "2025-08-08T21:00:00+02:00",
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, earlier, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, true);
  assert.deepEqual(
    admission.includedInputs
      .filter((row) => row.kind === "rating_state")
      .map((row) => row.inputId),
    ["rating-earlier", "rating-home"]
  );
  assert.equal(
    admission.includedInputs.find((row) => row.inputId === "rating-earlier")?.availableAt,
    "2025-08-08T19:00:00.000Z"
  );
});

test("current-state input fails closed", () => {
  const unsafe = { ...rating, classification: "NOT_PIT_SAFE" as const };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "INPUT_NOT_PIT_SAFE"));
});

test("mutable input fails closed", () => {
  const unsafe = { ...rating, immutable: false };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "INPUT_NOT_IMMUTABLE"));
});

test("missing content hash fails closed", () => {
  const unsafe = { ...rating, contentHash: null };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "INPUT_CONTENT_HASH_MISSING"));
});

test("changed payload with stale declared hash fails closed", () => {
  const unsafe = { ...rating, payload: { home: 1700, away: 1500 } };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, unsafe, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "INPUT_CONTENT_HASH_MISMATCH"));
});

test("missing material input kind fails closed", () => {
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.kind === "rating_state"));
});

test("fixture and model bundle are mandatory even if caller omits them", () => {
  const admission = prepareHistoricalReplay({
    request,
    inputs: [rating],
    requiredInputKinds: ["rating_state"],
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.kind === "fixture_metadata"));
  assert.ok(admission.issues.some((issue) => issue.kind === "model_parameters"));
});

test("model bundle must bind the requested model and feature versions", () => {
  const unsafe = {
    ...params,
    bundleModelVersion: "other-model",
    bundleFeatureVersion: "other-feature",
  };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, unsafe],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "MODEL_BUNDLE_MODEL_VERSION_MISMATCH")
  );
  assert.ok(
    admission.issues.some((issue) => issue.code === "MODEL_BUNDLE_FEATURE_VERSION_MISMATCH")
  );
});

test("fixture and model sidecars must match the hashed payload consumed by predictor", () => {
  const badFixture = changed(fixture, {
    payload: { fixtureId: "another-fixture", kickoffAt: "2030-01-01T00:00:00.000Z" },
  });
  const badFixtureAdmission = prepareHistoricalReplay({
    request,
    inputs: [badFixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(badFixtureAdmission.admissible, false);
  assert.ok(
    badFixtureAdmission.issues.some(
      (issue) => issue.code === "FIXTURE_METADATA_PAYLOAD_MISMATCH"
    )
  );

  const badParams = changed(params, {
    payload: { ...paramsPayload, trainingCutoffAt: "2030-01-01T00:00:00.000Z" },
  });
  const badModelAdmission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, badParams],
    requiredInputKinds: required,
  });
  assert.equal(badModelAdmission.admissible, false);
  assert.ok(
    badModelAdmission.issues.some((issue) => issue.code === "MODEL_BUNDLE_PAYLOAD_MISMATCH")
  );
});

test("future-trained model parameters fail closed", () => {
  const unsafe = { ...params, trainingCutoffAt: request.cutoffAt };
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, unsafe],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "MODEL_BUNDLE_TRAINING_NOT_BEFORE_CUTOFF")
  );
});

test("multiple model bundles at cutoff fail closed", () => {
  const second = changed(params, {
    inputId: "params-v2",
    sourceId: "model-bundle-v2",
    payload: { ...paramsPayload, parameters: { homeAdvantage: 75, rho: -0.05 } },
  });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params, second],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "MODEL_BUNDLE_AMBIGUOUS_AT_CUTOFF")
  );
});

test("cutoff at kickoff fails closed", () => {
  const bad = { ...request, cutoffAt: request.kickoffAtAsKnown };
  const admission = prepareHistoricalReplay({
    request: bad,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "CUTOFF_NOT_BEFORE_KICKOFF"));
});

test("runtime-invalid stage fails closed", () => {
  const bad = {
    ...request,
    forecastStage: "LATEST" as HistoricalReplayRequest["forecastStage"],
  };
  const admission = prepareHistoricalReplay({
    request: bad,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(admission.issues.some((issue) => issue.code === "FORECAST_STAGE_INVALID"));
});

test("replay execution cannot precede its historical cutoff", () => {
  const bad = { ...request, replayExecutedAt: "2025-08-09T13:59:59.000Z" };
  const admission = prepareHistoricalReplay({
    request: bad,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "REPLAY_EXECUTED_BEFORE_CUTOFF")
  );
});

test("replay execution remains distinct from historical cutoff", () => {
  const artifact = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.equal(artifact.cutoffAt, request.cutoffAt);
  assert.equal(artifact.replayExecutedAt, request.replayExecutedAt);
  assert.ok(Date.parse(artifact.replayExecutedAt) > Date.parse(artifact.kickoffAtAsKnown));
});

test("source lineage is sorted, complete and content-bound", () => {
  const artifact = runHistoricalReplay({
    request,
    inputs: [rating, params, fixture],
    requiredInputKinds: required,
    predict: predictor,
  });
  assert.deepEqual(artifact.sourceIds, [
    "fixture-snapshot-v1",
    "model-bundle-v1",
    "rating-event-tape",
  ]);
  assert.equal(artifact.sourceAvailableAt.length, 3);
  assert.equal(artifact.inputLineage.length, 3);
  assert.ok(artifact.inputLineage.every((row) => row.payloadDigest.startsWith("sha256:")));
  assert.ok(artifact.inputLineage.every((row) => row.contentHash === row.payloadDigest));
  assert.equal(
    artifact.inputLineage.find((row) => row.kind === "fixture_metadata")?.subjectFixtureId,
    request.fixtureId
  );
  assert.equal(
    artifact.inputLineage.find((row) => row.kind === "model_parameters")?.trainingCutoffAt,
    params.trainingCutoffAt
  );
  assert.equal(artifact.maxInputAvailableAt, rating.availableAt);
});

test("replay identity binds kind and re-hashed payload", () => {
  const base = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
  });
  const alteredPayload = changed(rating, { payload: { home: 1700, away: 1500 } });
  const changedAdmission = prepareHistoricalReplay({
    request,
    inputs: [fixture, alteredPayload, params],
    requiredInputKinds: required,
  });
  assert.notEqual(changedAdmission.replayKey, base.replayKey);

  const alteredKind = { ...rating, kind: "rating_state_v2" };
  const kindChanged = prepareHistoricalReplay({
    request,
    inputs: [fixture, alteredKind, params],
    requiredInputKinds: ["rating_state_v2"],
  });
  assert.notEqual(kindChanged.replayKey, base.replayKey);
});

test("conflicting duplicate input identity fails closed", () => {
  const conflict = changed(rating, { payload: { home: 9999, away: 1 } });
  const admission = prepareHistoricalReplay({
    request,
    inputs: [fixture, rating, conflict, params],
    requiredInputKinds: required,
  });
  assert.equal(admission.admissible, false);
  assert.ok(
    admission.issues.some((issue) => issue.code === "DUPLICATE_INPUT_ID_CONFLICT")
  );
});

test("predictor cannot mutate admitted nested payloads", () => {
  assert.throws(() =>
    runHistoricalReplay({
      request,
      inputs: [fixture, rating, params],
      requiredInputKinds: required,
      predict: (rows) => {
        const payload = rows.find((row) => row.kind === "rating_state")?.payload as {
          home: number;
        };
        payload.home = 9999;
        return { home: 0.5, draw: 0.25, away: 0.25 };
      },
    })
  );
  assert.equal(ratingPayload.home, 1600);
});

test("artifact and probabilities remain immutable after hashing", () => {
  const supplied = { home: 0.5, draw: 0.25, away: 0.25 };
  const artifact = runHistoricalReplay({
    request,
    inputs: [fixture, rating, params],
    requiredInputKinds: required,
    predict: () => supplied,
  });
  supplied.home = 0;
  assert.equal(artifact.probabilities.home, 0.5);
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.probabilities), true);
  assert.throws(() => {
    artifact.probabilities.home = 0.1;
  });
  assert.equal(artifact.probabilities.home, 0.5);
});

test("invalid probabilities are rejected", () => {
  assert.throws(
    () =>
      runHistoricalReplay({
        request,
        inputs: [fixture, rating, params],
        requiredInputKinds: required,
        predict: () => ({ home: 0.9, draw: 0.5, away: -0.4 }),
      }),
    /probabilities/
  );
});

console.log(`\n${passed} passed, 0 failed`);
