/** Phase 4A.2: fixture-level statistical-independence regression gates. */

import assert from "node:assert/strict";
import {
  EVALUATION_MATURITY_POLICY,
  assessEvaluationMaturity,
  fixtureClusterBootstrap,
  isValidPreKickEvidence,
  publishFixtureClusterBootstrap,
  selectLatestValidPreKickByFixture,
  selectLatestValidPreKickByFixtureStage,
  type FixtureMetricObservation,
  type PreKickEvidenceObservation,
} from "@/lib/evaluation/evidence-integrity";

let passed = 0;

function check(name: string, test: () => void): void {
  test();
  passed += 1;
  console.log(`✓ ${name}`);
}

check("maturity constants are centralized at 20 and 50 unique fixtures", () => {
  assert.equal(EVALUATION_MATURITY_POLICY.provisionalMinUniqueFixtures, 20);
  assert.equal(EVALUATION_MATURITY_POLICY.evaluationReadyMinUniqueFixtures, 50);
});

for (const [n, expected] of [
  [19, "EARLY_EVIDENCE"],
  [20, "PROVISIONAL"],
  [49, "PROVISIONAL"],
  [50, "EVALUATION_READY"],
] as const) {
  check(`${n} unique fixtures -> ${expected}`, () => {
    const maturity = assessEvaluationMaturity(n);
    assert.equal(maturity.status, expected);
    assert.equal(maturity.uniqueFixtureCount, n);
    assert.equal(maturity.independentUnit, "fixture");
  });
}

const kickoff = "2026-09-20T15:00:00.000Z";
const observations: PreKickEvidenceObservation[] = [
  {
    fixtureId: "fixture-a",
    predictionStage: "T7D",
    snapshotUniqueKey: "a-t7d-early",
    cutoffAt: "2026-09-13T14:00:00.000Z",
    generatedAt: "2026-09-13T14:01:00.000Z",
    kickoffAt: kickoff,
    kickoffAtFreeze: kickoff,
  },
  {
    fixtureId: "fixture-a",
    predictionStage: "T7D",
    snapshotUniqueKey: "a-t7d-latest",
    cutoffAt: "2026-09-13T15:00:00.000Z",
    generatedAt: "2026-09-13T15:01:00.000Z",
    kickoffAt: kickoff,
    kickoffAtFreeze: kickoff,
  },
  {
    fixtureId: "fixture-a",
    predictionStage: "T24H",
    snapshotUniqueKey: "a-t24h",
    cutoffAt: "2026-09-19T15:00:00.000Z",
    generatedAt: "2026-09-19T15:01:00.000Z",
    kickoffAt: kickoff,
    kickoffAtFreeze: kickoff,
  },
  {
    fixtureId: "fixture-a",
    predictionStage: "FINAL_PREKICK",
    snapshotUniqueKey: "a-post-kick-invalid",
    cutoffAt: "2026-09-20T15:01:00.000Z",
    generatedAt: "2026-09-20T15:02:00.000Z",
    kickoffAt: kickoff,
    kickoffAtFreeze: kickoff,
  },
  {
    fixtureId: "fixture-a",
    predictionStage: "T60M",
    snapshotUniqueKey: "a-obsolete-kickoff",
    cutoffAt: "2026-09-20T14:00:00.000Z",
    generatedAt: "2026-09-20T14:01:00.000Z",
    kickoffAt: kickoff,
    kickoffAtFreeze: "2026-09-20T16:00:00.000Z",
  },
  {
    fixtureId: "fixture-b",
    predictionStage: "EARLY",
    snapshotUniqueKey: "b-early",
    cutoffAt: "2026-09-01T00:00:00.000Z",
    generatedAt: "2026-09-01T00:01:00.000Z",
    kickoffAt: "2026-09-21T19:00:00.000Z",
    kickoffAtFreeze: "2026-09-21T19:00:00.000Z",
  },
];

check("post-kick and obsolete-kickoff observations fail closed", () => {
  assert.equal(isValidPreKickEvidence(observations[3]), false);
  assert.equal(isValidPreKickEvidence(observations[4]), false);
});

check("latest valid pre-kick selection contributes one observation per fixture", () => {
  const selected = selectLatestValidPreKickByFixture(observations);
  assert.deepEqual(
    selected.map((row) => row.snapshotUniqueKey),
    ["a-t24h", "b-early"]
  );
});

check("duplicate rolling-stage rows contribute one stage observation per fixture", () => {
  const selected = selectLatestValidPreKickByFixtureStage(observations);
  assert.deepEqual(
    selected.map((row) => row.snapshotUniqueKey),
    ["a-t24h", "a-t7d-latest", "b-early"]
  );
  assert.equal(selected.filter((row) => row.fixtureId === "fixture-a" && row.predictionStage === "T7D").length, 1);
});

const correlated38: FixtureMetricObservation[] = [];
for (let fixture = 0; fixture < 10; fixture++) {
  const stagesForFixture = fixture < 8 ? 4 : 3;
  for (let stage = 0; stage < stagesForFixture; stage++) {
    correlated38.push({
      fixtureId: `fixture-${String(fixture).padStart(2, "0")}`,
      observationId: `stage-${stage}`,
      values: { brier: fixture / 10, rps: fixture / 20, logLoss: fixture / 5 },
    });
  }
}

check("38 snapshot rows across 10 fixtures retain independent N=10", () => {
  assert.equal(correlated38.length, 38);
  const result = fixtureClusterBootstrap(correlated38, {
    metricKeys: ["brier", "rps", "logLoss"],
    bootstrapReplicates: 200,
    seed: 7,
  });
  assert.equal(result.observationCount, 38);
  assert.equal(result.uniqueFixtureCount, 10);
  assert.equal(result.maturity.status, "EARLY_EVIDENCE");
  assert.equal(result.intervalStatus, "WITHHELD_INSUFFICIENT_FIXTURES");
  assert.equal(result.intervals, null);
  assert.equal(result.bootstrapReplicates, 0);
});

check("24 paired shadow rows across 6 fixtures remain EARLY_EVIDENCE", () => {
  const pairedRows: FixtureMetricObservation[] = Array.from({ length: 24 }, (_, index) => ({
    fixtureId: `shadow-fixture-${Math.floor(index / 4)}`,
    observationId: `paired-stage-${index % 4}`,
    values: {
      deltaBrier: (index % 4) / 100,
      deltaRps: (index % 3) / 100,
      deltaLogLoss: (index % 5) / 100,
    },
  }));
  const result = fixtureClusterBootstrap(pairedRows, {
    metricKeys: ["deltaBrier", "deltaRps", "deltaLogLoss"],
    bootstrapReplicates: 200,
    seed: 13,
  });
  assert.equal(result.observationCount, 24);
  assert.equal(result.uniqueFixtureCount, 6);
  assert.equal(result.maturity.status, "EARLY_EVIDENCE");
  assert.equal(result.intervals, null);
});

check("50 correlated rows from one fixture never reach a fixture threshold", () => {
  const result = fixtureClusterBootstrap(
    Array.from({ length: 50 }, (_, index) => ({
      fixtureId: "one-fixture",
      observationId: `rolling-${index}`,
      values: { brier: index / 100 },
    })),
    { metricKeys: ["brier"], bootstrapReplicates: 200, seed: 17 }
  );
  assert.equal(result.uniqueFixtureCount, 1);
  assert.equal(result.maturity.status, "EARLY_EVIDENCE");
  assert.equal(result.intervals, null);
});

check("equal-fixture aggregation prevents stage-rich fixtures from dominating", () => {
  const uneven: FixtureMetricObservation[] = [
    ...["a", "b", "c", "d"].map((observationId) => ({
      fixtureId: "stage-rich",
      observationId,
      values: { deltaBrier: 1 },
    })),
    { fixtureId: "stage-thin", observationId: "a", values: { deltaBrier: -1 } },
  ];
  const result = fixtureClusterBootstrap(uneven, {
    metricKeys: ["deltaBrier"],
    bootstrapReplicates: 200,
    seed: 11,
  });
  assert.equal(result.uniqueFixtureCount, 2);
  assert.equal(result.observationCount, 5);
  assert.equal(result.pointEstimates.deltaBrier, 0);
});

const twentyFixtures: FixtureMetricObservation[] = Array.from({ length: 20 }, (_, i) => ({
  fixtureId: `fixture-${String(i).padStart(2, "0")}`,
  observationId: "selected",
  values: {
    brier: i / 20,
    rps: (20 - i) / 40,
    logLoss: 0.5 + i / 50,
  },
}));

const bootstrapOptions = {
  metricKeys: ["logLoss", "brier", "rps"],
  bootstrapReplicates: 500,
  seed: 20260826,
} as const;

check("public reporting gate redacts point estimates at N=19", () => {
  const internal = fixtureClusterBootstrap(
    twentyFixtures.slice(0, 19),
    bootstrapOptions
  );
  assert.equal(internal.uniqueFixtureCount, 19);
  assert.equal(internal.maturity.status, "EARLY_EVIDENCE");
  assert.ok(Object.values(internal.pointEstimates).every((value) => value !== null));

  const published = publishFixtureClusterBootstrap(internal, false);
  assert.deepEqual(Object.keys(published.pointEstimates).sort(), [
    "brier",
    "logLoss",
    "rps",
  ]);
  assert.ok(Object.values(published.pointEstimates).every((value) => value === null));
  assert.equal(published.intervalStatus, "WITHHELD_REPORTING_GATE");
  assert.equal(published.intervals, null);
  assert.equal(published.bootstrapReplicates, 0);
});

check("public reporting gate redacts estimates and intervals at N=20", () => {
  const internal = fixtureClusterBootstrap(twentyFixtures, bootstrapOptions);
  assert.equal(internal.uniqueFixtureCount, 20);
  assert.equal(internal.maturity.status, "PROVISIONAL");
  assert.ok(internal.intervals);

  const published = publishFixtureClusterBootstrap(internal, false);
  assert.ok(Object.values(published.pointEstimates).every((value) => value === null));
  assert.equal(published.intervalStatus, "WITHHELD_REPORTING_GATE");
  assert.equal(
    published.intervalReason,
    "Headline estimates and intervals are withheld by the public reporting gate."
  );
  assert.equal(published.intervals, null);
  assert.equal(published.bootstrapReplicates, 0);
});

check("20 fixture clusters unlock a provisional fixture-cluster interval", () => {
  const result = fixtureClusterBootstrap(twentyFixtures, bootstrapOptions);
  assert.equal(result.uniqueFixtureCount, 20);
  assert.equal(result.maturity.status, "PROVISIONAL");
  assert.equal(result.intervalStatus, "AVAILABLE");
  assert.equal(result.bootstrapReplicates, 500);
  assert.ok(result.intervals);
  for (const interval of Object.values(result.intervals)) {
    assert.ok(interval.lo <= interval.estimate);
    assert.ok(interval.estimate <= interval.hi);
  }
});

check("fixture-cluster bootstrap is deterministic at a fixed seed", () => {
  const first = fixtureClusterBootstrap(twentyFixtures, bootstrapOptions);
  const second = fixtureClusterBootstrap(twentyFixtures, bootstrapOptions);
  assert.deepEqual(second, first);
});

check("fixture-cluster bootstrap is invariant to input row order", () => {
  const ordered = fixtureClusterBootstrap(twentyFixtures, bootstrapOptions);
  const reversed = fixtureClusterBootstrap([...twentyFixtures].reverse(), bootstrapOptions);
  assert.deepEqual(reversed, ordered);
});

console.log(`\nPhase 4A.2 evidence integrity: ${passed} passed, 0 failed.`);
