import type { MatchForecast } from "./types";
import { assertForecastInvariants } from "./derive";

/**
 * Scenario boundary for the Premier League product.
 *
 * The champion currently has no audited player-level transformation, so every
 * player/tactical override fails closed. Keeping this as a typed deterministic
 * service makes that refusal testable and gives a future challenger one narrow
 * integration point without granting the Agent authority over probabilities.
 */
export interface MatchScenarioOverride {
  type: string;
  playerId?: string;
}

export type MatchScenarioBoundaryErrorCode =
  | "INVALID_OVERRIDE"
  | "INVALID_BASELINE"
  | "FORECAST_MISMATCH"
  | "MATCH_MISMATCH";

export class MatchScenarioBoundaryError extends Error {
  constructor(
    public readonly code: MatchScenarioBoundaryErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface UnsupportedMatchScenarioResult {
  supported: false;
  status: "UNSUPPORTED_SCENARIO";
  baselineForecastId: string;
  scenario: MatchScenarioOverride;
  modelVersion: string;
  modelRole: "production";
  isHypothetical: true;
  recordClass: "SCENARIO";
  evaluationClass: null;
  persisted: false;
  reason: string;
}

export type MatchScenarioResult = UnsupportedMatchScenarioResult;

const TYPE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,79}$/;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

/**
 * Accept only the two inert descriptor fields the refusal response can echo.
 * In particular, arbitrary probability-like keys never cross this boundary.
 */
export function parseMatchScenarioOverride(value: unknown): MatchScenarioOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "type" && key !== "playerId")) return null;
  if (typeof raw.type !== "string" || !TYPE_PATTERN.test(raw.type)) return null;
  if (!Object.prototype.hasOwnProperty.call(raw, "playerId")) return { type: raw.type };
  if (typeof raw.playerId !== "string" || !PLAYER_ID_PATTERN.test(raw.playerId)) return null;
  return { type: raw.type, playerId: raw.playerId };
}

function failBaseline(): never {
  throw new MatchScenarioBoundaryError(
    "INVALID_BASELINE",
    "Scenario baseline must be one internally consistent immutable production forecast."
  );
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertScenarioBaseline(baseline: MatchForecast, expectedMatchId: string): void {
  try {
    if (!baseline || typeof baseline !== "object") failBaseline();
    if (
      baseline.matchId !== expectedMatchId ||
      baseline.competition !== "premier-league" ||
      baseline.modelRole !== "production" ||
      baseline.provenance.modelRole !== "production" ||
      baseline.provenance.evaluationClass !== "LIVE_OOS" ||
      baseline.season !== baseline.provenance.season ||
      baseline.modelVersion !== baseline.provenance.modelVersion ||
      baseline.generatedAt !== baseline.provenance.generatedAt ||
      baseline.cutoffAt !== baseline.provenance.cutoffAt ||
      typeof baseline.provenance.immutableForecastId !== "string" ||
      !baseline.provenance.immutableForecastId.trim()
    ) {
      failBaseline();
    }

    const cutoff = Date.parse(baseline.cutoffAt);
    const generated = Date.parse(baseline.generatedAt);
    const kickoff = Date.parse(baseline.kickoffUtc);
    if (
      !Number.isFinite(cutoff) ||
      !Number.isFinite(generated) ||
      !Number.isFinite(kickoff) ||
      cutoff >= kickoff ||
      generated < cutoff ||
      generated >= kickoff
    ) {
      failBaseline();
    }

    const probabilities: unknown[] = [
      ...Object.values(baseline.result),
      ...Object.values(baseline.totals),
      ...Object.values(baseline.btts),
      ...Object.values(baseline.doubleChance),
      ...Object.values(baseline.drawNoBet),
      ...Object.values(baseline.teamTotals.home),
      ...Object.values(baseline.teamTotals.away),
      ...baseline.scoreMatrix.flat(),
      ...baseline.exactScores.map((score) => score.probability),
      ...baseline.topScores.map((score) => score.probability),
    ];
    if (!probabilities.every(validProbability)) failBaseline();
    if (
      !Object.values(baseline.expectedGoals).every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
      )
    ) {
      failBaseline();
    }
    assertForecastInvariants(baseline);
  } catch (error) {
    if (error instanceof MatchScenarioBoundaryError) throw error;
    failBaseline();
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function runMatchScenario(input: {
  baseline: MatchForecast;
  matchId: string;
  forecastId: string;
  override: MatchScenarioOverride;
}): MatchScenarioResult {
  const baseline = input.baseline;
  assertScenarioBaseline(baseline, input.matchId);
  if (input.forecastId !== baseline.provenance.immutableForecastId) {
    throw new MatchScenarioBoundaryError(
      "FORECAST_MISMATCH",
      "Scenario baseline must equal the selected immutable production forecast."
    );
  }

  const override = parseMatchScenarioOverride(input.override);
  if (!override) {
    throw new MatchScenarioBoundaryError(
      "INVALID_OVERRIDE",
      "Scenario override must contain only a bounded type and optional playerId."
    );
  }

  return deepFreeze({
    supported: false,
    status: "UNSUPPORTED_SCENARIO",
    baselineForecastId: baseline.provenance.immutableForecastId,
    scenario: override,
    modelVersion: baseline.modelVersion,
    modelRole: "production",
    isHypothetical: true,
    recordClass: "SCENARIO",
    evaluationClass: null,
    persisted: false,
    reason:
      "No audited deterministic Premier League player-impact or tactical parameter exists for this override. The production forecast is unchanged and no scenario probability was created.",
  });
}
