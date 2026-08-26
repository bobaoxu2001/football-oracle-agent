/**
 * Canonical statistical-evidence policy for forward forecast evaluation.
 *
 * A forecast snapshot is an immutable point-in-time artifact. A fixture is the
 * independent realised sporting event. Multiple snapshots from one fixture are
 * therefore one cluster, never multiple independent samples.
 *
 * This module is deliberately pure: it does not read a store, mutate a ledger,
 * or alter forecast mathematics. Callers supply already-scoped production or
 * shadow observations and retain responsibility for track isolation.
 */

export const EVALUATION_MATURITY_POLICY = Object.freeze({
  provisionalMinUniqueFixtures: 20,
  evaluationReadyMinUniqueFixtures: 50,
});

export type EvaluationMaturity =
  | "EARLY_EVIDENCE"
  | "PROVISIONAL"
  | "EVALUATION_READY";

export interface EvaluationMaturityAssessment {
  status: EvaluationMaturity;
  independentUnit: "fixture";
  uniqueFixtureCount: number;
  provisionalReportingAllowed: boolean;
  formalEvaluationReady: boolean;
  thresholds: typeof EVALUATION_MATURITY_POLICY;
}

/**
 * Maturity is evidence volume only. EVALUATION_READY means that a first formal
 * comparison is permissible; it is not evidence of model quality or promotion.
 */
export function assessEvaluationMaturity(
  uniqueFixtureCount: number
): EvaluationMaturityAssessment {
  if (!Number.isInteger(uniqueFixtureCount) || uniqueFixtureCount < 0) {
    throw new Error("unique fixture count must be a non-negative integer");
  }

  const status: EvaluationMaturity =
    uniqueFixtureCount >= EVALUATION_MATURITY_POLICY.evaluationReadyMinUniqueFixtures
      ? "EVALUATION_READY"
      : uniqueFixtureCount >= EVALUATION_MATURITY_POLICY.provisionalMinUniqueFixtures
        ? "PROVISIONAL"
        : "EARLY_EVIDENCE";

  return {
    status,
    independentUnit: "fixture",
    uniqueFixtureCount,
    provisionalReportingAllowed: status !== "EARLY_EVIDENCE",
    formalEvaluationReady: status === "EVALUATION_READY",
    thresholds: EVALUATION_MATURITY_POLICY,
  };
}

/** Minimal store-independent shape needed to select headline evidence. */
export interface PreKickEvidenceObservation {
  fixtureId: string;
  predictionStage: string;
  snapshotUniqueKey: string;
  /** Information cutoff carried by the immutable forecast. */
  cutoffAt: string;
  /** Current/final kickoff of the realised fixture. */
  kickoffAt: string;
  /** Actual generation time, when recorded. */
  generatedAt?: string | null;
  /** Kickoff identity frozen into the snapshot, when recorded. */
  kickoffAtFreeze?: string | null;
  /** An upstream current-kickoff check may explicitly invalidate the row. */
  validForCurrentKickoff?: boolean;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A headline observation must be strictly pre-kick and belong to the fixture's
 * current kickoff identity. A generated-at timestamp, when present, must also
 * be pre-kick. Malformed timestamps fail closed.
 */
export function isValidPreKickEvidence(row: PreKickEvidenceObservation): boolean {
  const cutoff = timestamp(row.cutoffAt);
  const kickoff = timestamp(row.kickoffAt);
  if (cutoff === null || kickoff === null || cutoff >= kickoff) return false;
  if (row.validForCurrentKickoff === false) return false;

  if (row.generatedAt !== undefined && row.generatedAt !== null) {
    const generated = timestamp(row.generatedAt);
    if (generated === null || generated >= kickoff) return false;
  }

  if (row.kickoffAtFreeze !== undefined && row.kickoffAtFreeze !== null) {
    const frozenKickoff = timestamp(row.kickoffAtFreeze);
    if (frozenKickoff === null || frozenKickoff !== kickoff) return false;
  }

  return true;
}

/** True when candidate wins the deterministic "latest valid" ordering. */
function laterThan<T extends PreKickEvidenceObservation>(candidate: T, current: T): boolean {
  const candidateCutoff = timestamp(candidate.cutoffAt) as number;
  const currentCutoff = timestamp(current.cutoffAt) as number;
  if (candidateCutoff !== currentCutoff) return candidateCutoff > currentCutoff;

  const candidateGenerated = timestamp(candidate.generatedAt) ?? candidateCutoff;
  const currentGenerated = timestamp(current.generatedAt) ?? currentCutoff;
  if (candidateGenerated !== currentGenerated) return candidateGenerated > currentGenerated;

  return candidate.snapshotUniqueKey.localeCompare(current.snapshotUniqueKey) > 0;
}

function selectLatestByKey<T extends PreKickEvidenceObservation>(
  observations: readonly T[],
  keyOf: (row: T) => string
): T[] {
  const selected = new Map<string, T>();
  for (const row of observations) {
    if (!isValidPreKickEvidence(row)) continue;
    const key = keyOf(row);
    const current = selected.get(key);
    if (!current || laterThan(row, current)) selected.set(key, row);
  }
  return [...selected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
}

/** One latest valid production-style observation per independent fixture. */
export function selectLatestValidPreKickByFixture<
  T extends PreKickEvidenceObservation,
>(observations: readonly T[]): T[] {
  return selectLatestByKey(observations, (row) => row.fixtureId);
}

/**
 * One latest valid observation per fixture and canonical stage. Additional
 * rolling-stage snapshots remain trajectory rows but cannot inflate stage N.
 */
export function selectLatestValidPreKickByFixtureStage<
  T extends PreKickEvidenceObservation,
>(observations: readonly T[]): T[] {
  return selectLatestByKey(
    observations,
    (row) => `${row.fixtureId}\u0000${row.predictionStage}`
  );
}

export interface FixtureMetricObservation {
  fixtureId: string;
  /** Stable identity used to make within-cluster summation order deterministic. */
  observationId: string;
  values: Readonly<Record<string, number>>;
}

export interface MetricInterval {
  estimate: number;
  lo: number;
  hi: number;
}

export type IntervalStatus =
  | "AVAILABLE"
  | "WITHHELD_INSUFFICIENT_FIXTURES"
  | "WITHHELD_REPORTING_GATE";

export interface FixtureClusterBootstrapResult {
  method: "fixture-cluster-percentile-bootstrap-equal-fixture-v1";
  independentUnit: "fixture";
  uniqueFixtureCount: number;
  observationCount: number;
  clusterSizes: Record<string, number>;
  maturity: EvaluationMaturityAssessment;
  pointEstimates: Record<string, number | null>;
  confidenceLevel: number;
  intervalStatus: IntervalStatus;
  intervalReason: string | null;
  intervals: Record<string, MetricInterval> | null;
  bootstrapReplicates: number;
  seed: number;
}

export type PublishedFixtureClusterBootstrapResult = Omit<
  FixtureClusterBootstrapResult,
  "pointEstimates"
> & {
  /** Metric keys remain stable; values are null when reporting is withheld. */
  pointEstimates: Record<string, number | null>;
};

/** Keep internal descriptive estimates without leaking withheld public scores. */
export function publishFixtureClusterBootstrap(
  result: FixtureClusterBootstrapResult,
  reportingAllowed: boolean
): PublishedFixtureClusterBootstrapResult {
  if (reportingAllowed) return { ...result };
  return {
    ...result,
    pointEstimates: Object.fromEntries(
      Object.keys(result.pointEstimates).map((key) => [key, null])
    ),
    intervalStatus: "WITHHELD_REPORTING_GATE",
    intervalReason: "Headline estimates and intervals are withheld by the public reporting gate.",
    intervals: null,
    bootstrapReplicates: 0,
  };
}

export interface FixtureClusterBootstrapOptions {
  metricKeys: readonly string[];
  bootstrapReplicates?: number;
  seed?: number;
  confidenceLevel?: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(sorted: readonly number[], q: number): number {
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - index) + sorted[hi] * (index - lo);
}

/** Small deterministic PRNG kept local so evaluation does not depend on model code. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function validatedMetricKeys(metricKeys: readonly string[]): string[] {
  const keys = [...metricKeys];
  if (!keys.length || keys.some((key) => !key.trim())) {
    throw new Error("at least one non-empty metric key is required");
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error("metric keys must be unique");
  }
  return keys.sort();
}

/**
 * Fixture-cluster bootstrap for mean proper scores or paired score deltas.
 *
 * The point estimator first averages rows within each fixture, then averages
 * fixture means. Consequently every fixture has total weight one regardless of
 * how many stages were frozen. Bootstrap draws resample whole fixtures with
 * replacement and keep all metric deltas paired by using the same draw indices.
 *
 * Intervals are deliberately withheld below 20 independent fixture clusters.
 * Descriptive point estimates remain available and must be labelled as such by
 * callers. Values should be per-row proper scores or paired candidate-baseline
 * deltas; probability or prediction mathematics does not belong in this layer.
 */
export function fixtureClusterBootstrap(
  observations: readonly FixtureMetricObservation[],
  options: FixtureClusterBootstrapOptions
): FixtureClusterBootstrapResult {
  const metricKeys = validatedMetricKeys(options.metricKeys);
  const bootstrapReplicates = options.bootstrapReplicates ?? 20_000;
  const seed = options.seed ?? 20260826;
  const confidenceLevel = options.confidenceLevel ?? 0.95;

  if (!Number.isInteger(bootstrapReplicates) || bootstrapReplicates <= 0) {
    throw new Error("bootstrap replicate count must be a positive integer");
  }
  if (!Number.isInteger(seed)) throw new Error("bootstrap seed must be an integer");
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidence level must be between 0 and 1");
  }

  const clusters = new Map<string, FixtureMetricObservation[]>();
  const identities = new Set<string>();
  for (const row of observations) {
    if (!row.fixtureId || !row.observationId) {
      throw new Error("fixture metric observations require fixtureId and observationId");
    }
    const identity = `${row.fixtureId}\u0000${row.observationId}`;
    if (identities.has(identity)) {
      throw new Error(`duplicate fixture metric observation: ${row.fixtureId}/${row.observationId}`);
    }
    identities.add(identity);
    for (const key of metricKeys) {
      const value = row.values[key];
      if (!Number.isFinite(value)) {
        throw new Error(`metric ${key} must be finite for ${row.fixtureId}/${row.observationId}`);
      }
    }
    const cluster = clusters.get(row.fixtureId) ?? [];
    cluster.push(row);
    clusters.set(row.fixtureId, cluster);
  }

  const fixtureIds = [...clusters.keys()].sort();
  const clusterSizes: Record<string, number> = {};
  const fixtureMeans: Record<string, number[]> = Object.fromEntries(
    metricKeys.map((key) => [key, []])
  );
  for (const fixtureId of fixtureIds) {
    const rows = [...(clusters.get(fixtureId) ?? [])].sort((a, b) =>
      a.observationId.localeCompare(b.observationId)
    );
    clusterSizes[fixtureId] = rows.length;
    for (const key of metricKeys) {
      fixtureMeans[key].push(mean(rows.map((row) => row.values[key])));
    }
  }

  const uniqueFixtureCount = fixtureIds.length;
  const maturity = assessEvaluationMaturity(uniqueFixtureCount);
  const pointEstimates: Record<string, number | null> = Object.fromEntries(
    metricKeys.map((key) => [
      key,
      uniqueFixtureCount ? mean(fixtureMeans[key]) : null,
    ])
  );
  const enoughForInterval =
    uniqueFixtureCount >= EVALUATION_MATURITY_POLICY.provisionalMinUniqueFixtures;

  if (!enoughForInterval) {
    return {
      method: "fixture-cluster-percentile-bootstrap-equal-fixture-v1",
      independentUnit: "fixture",
      uniqueFixtureCount,
      observationCount: observations.length,
      clusterSizes,
      maturity,
      pointEstimates,
      confidenceLevel,
      intervalStatus: "WITHHELD_INSUFFICIENT_FIXTURES",
      intervalReason:
        `Intervals require at least ${EVALUATION_MATURITY_POLICY.provisionalMinUniqueFixtures} ` +
        `unique fixtures; observed ${uniqueFixtureCount}.`,
      intervals: null,
      bootstrapReplicates: 0,
      seed,
    };
  }

  const rng = mulberry32(seed);
  const samples: Record<string, number[]> = Object.fromEntries(
    metricKeys.map((key) => [key, []])
  );
  for (let replicate = 0; replicate < bootstrapReplicates; replicate++) {
    const sums: Record<string, number> = Object.fromEntries(
      metricKeys.map((key) => [key, 0])
    );
    for (let draw = 0; draw < uniqueFixtureCount; draw++) {
      const index = Math.floor(rng() * uniqueFixtureCount);
      for (const key of metricKeys) sums[key] += fixtureMeans[key][index];
    }
    for (const key of metricKeys) samples[key].push(sums[key] / uniqueFixtureCount);
  }

  const alpha = 1 - confidenceLevel;
  const intervals: Record<string, MetricInterval> = {};
  for (const key of metricKeys) {
    const sorted = samples[key].sort((a, b) => a - b);
    intervals[key] = {
      estimate: pointEstimates[key] as number,
      lo: quantile(sorted, alpha / 2),
      hi: quantile(sorted, 1 - alpha / 2),
    };
  }

  return {
    method: "fixture-cluster-percentile-bootstrap-equal-fixture-v1",
    independentUnit: "fixture",
    uniqueFixtureCount,
    observationCount: observations.length,
    clusterSizes,
    maturity,
    pointEstimates,
    confidenceLevel,
    intervalStatus: "AVAILABLE",
    intervalReason: null,
    intervals,
    bootstrapReplicates,
    seed,
  };
}
