/**
 * Fixture-level baseline-vs-shadow comparison read model.
 *
 * Reads FROZEN snapshots where they exist. For a fixture that has not yet been
 * frozen at any stage, it computes a preview at the current instant — clearly
 * marked `frozen: false` — so the comparison view is useful before matchday
 * without ever presenting a live computation as a frozen prediction.
 */

import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { loadSettlements, type SettlementRecord } from "../settlement";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { PRODUCTION_MODEL_VERSION } from "../model-tracks";
import { getClub } from "../clubs";
import {
  validateProductionForecastSnapshot,
  type ForecastSnapshotRole,
  type ProductionFreshnessStage,
} from "../ops/production-freshness";
import { predictPremierLeagueMatch } from "@/lib/prediction-engine/league-engine";
import {
  effectiveSnapshotGeneratedAt,
  effectiveSnapshotLatestIncludedInputAt,
  type PredictionSnapshot,
} from "@/lib/snapshots/types";
import type { CanonicalMatch } from "@/lib/match-ledger/types";
import { validateSettlementSnapshotConsistency } from "@/lib/evaluation/settlement-integrity";
import { predictPremierLeagueShadow } from "./model";
import { explainShadowPrediction, type ShadowExplanation } from "./explain";
import { SHADOW_MODEL_VERSION, productionModelVersion } from "./track";

export interface SideView {
  modelVersion: string;
  home: number;
  draw: number;
  away: number;
  asOf: string;
  predictionStage: string | null;
  /** True when these came from an immutable pre-kickoff snapshot. */
  frozen: boolean;
  settlement: {
    brier: number;
    rps: number;
    logLoss: number;
    topPickCorrect: boolean;
  } | null;
}

export interface CurrentSeasonEvidenceView {
  teamSlug: string;
  teamName: string;
  matchesPlayed: number;
  currentSeasonWeight: number;
  goalsFor: number;
  expectedGoalsFor: number;
  goalsAgainst: number;
  expectedGoalsAgainst: number;
  attackMultiplier: number;
  defenceMultiplier: number;
  /** Most recent admissible result, as a short label. */
  latest: string | null;
}

export interface FixtureComparison {
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  homeName: string;
  awayName: string;
  kickoffUtc: string | null;
  season: string;
  servingVersion: string;
  baseline: SideView;
  shadow: SideView;
  /** shadow − baseline, in percentage points. */
  delta: { homePp: number; drawPp: number; awayPp: number };
  evidence: { home: CurrentSeasonEvidenceView; away: CurrentSeasonEvidenceView };
  explanation: ShadowExplanation;
  /** True when both sides came from frozen snapshots at the same cutoff. */
  pairedAndFrozen: boolean;
  note: string;
}

interface ValidComparisonSnapshot {
  snapshot: PredictionSnapshot;
  stage: ProductionFreshnessStage;
  cutoffMs: number;
  generatedMs: number;
}

interface FrozenComparisonPair {
  baseline: PredictionSnapshot;
  shadow: PredictionSnapshot;
  stage: ProductionFreshnessStage;
}

function validComparisonSnapshots(input: {
  snapshots: PredictionSnapshot[];
  modelVersion: string;
  modelRole: ForecastSnapshotRole;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc: string | null;
  season: string;
  evaluatedAt: string;
}): ValidComparisonSnapshot[] {
  if (!input.kickoffUtc) return [];
  const valid: ValidComparisonSnapshot[] = [];
  for (const snapshot of input.snapshots) {
    if (
      snapshot.competition !== "premier-league" ||
      snapshot.season !== input.season ||
      snapshot.fixtureId !== input.fixtureId ||
      snapshot.homeSlug !== input.homeSlug ||
      snapshot.awaySlug !== input.awaySlug ||
      snapshot.modelVersion !== input.modelVersion ||
      snapshot.evaluationClass !== "LIVE_OOS"
    ) {
      continue;
    }
    const result = validateProductionForecastSnapshot({
      snapshot: {
        snapshotId: snapshot.provenance.uniqueKey,
        fixtureId: snapshot.fixtureId,
        modelRole: input.modelRole,
        modelVersion: snapshot.modelVersion,
        evaluationClass: snapshot.evaluationClass ?? null,
        predictionStage: String(snapshot.predictionStage),
        kickoffUtc: snapshot.kickoff,
        cutoffAt: snapshot.asOf,
        generatedAt: effectiveSnapshotGeneratedAt(snapshot),
        latestIncludedInputAt: effectiveSnapshotLatestIncludedInputAt(snapshot),
      },
      expectedKickoffUtc: input.kickoffUtc,
      evaluatedAt: input.evaluatedAt,
    });
    if (!result.valid) continue;
    valid.push({
      snapshot,
      stage: result.valid.stage,
      cutoffMs: result.valid.cutoffMs,
      generatedMs: result.valid.generatedMs,
    });
  }
  return valid;
}

function latestValidPair(input: {
  snapshots: PredictionSnapshot[];
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc: string | null;
  season: string;
  evaluatedAt: string;
}): FrozenComparisonPair | null {
  const shared = {
    snapshots: input.snapshots,
    fixtureId: input.fixtureId,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    kickoffUtc: input.kickoffUtc,
    season: input.season,
    evaluatedAt: input.evaluatedAt,
  };
  const baseline = validComparisonSnapshots({
    ...shared,
    modelVersion: PRODUCTION_MODEL_VERSION,
    modelRole: "production",
  });
  const shadowByPair = new Map(
    validComparisonSnapshots({
      ...shared,
      modelVersion: SHADOW_MODEL_VERSION,
      modelRole: "shadow",
    }).map((row) => [`${row.stage}\u0000${row.snapshot.asOf}`, row] as const)
  );
  const pairs = baseline
    .map((row) => {
      const shadow = shadowByPair.get(`${row.stage}\u0000${row.snapshot.asOf}`);
      return shadow ? { baseline: row, shadow } : null;
    })
    .filter(
      (pair): pair is { baseline: ValidComparisonSnapshot; shadow: ValidComparisonSnapshot } =>
        pair !== null
    )
    .sort(
      (a, b) =>
        a.baseline.cutoffMs - b.baseline.cutoffMs ||
        Math.max(a.baseline.generatedMs, a.shadow.generatedMs) -
          Math.max(b.baseline.generatedMs, b.shadow.generatedMs) ||
        a.baseline.snapshot.provenance.uniqueKey.localeCompare(
          b.baseline.snapshot.provenance.uniqueKey
        )
    );
  const latest = pairs.at(-1);
  return latest
    ? {
        baseline: latest.baseline.snapshot,
        shadow: latest.shadow.snapshot,
        stage: latest.baseline.stage,
      }
    : null;
}

function settlementFor(
  settlements: SettlementRecord[],
  snapshot: PredictionSnapshot | null
): SideView["settlement"] {
  if (!snapshot) return null;
  const row = settlements.find((s) => s.snapshotUniqueKey === snapshot.provenance.uniqueKey);
  if (!row) return null;
  if (!validateSettlementSnapshotConsistency(row, snapshot).consistent) return null;
  return {
    brier: row.brier,
    rps: row.rps,
    logLoss: row.logLoss,
    topPickCorrect: row.topPickCorrect,
  };
}

function evidenceView(
  teamSlug: string,
  strength: ReturnType<typeof predictPremierLeagueShadow>["features"]["homeStrength"],
  matchIds: string[],
  ledger: CanonicalMatch[]
): CurrentSeasonEvidenceView {
  const last = matchIds.length ? ledger.find((m) => m.canonicalMatchId === matchIds[matchIds.length - 1]) : null;
  let latest: string | null = null;
  if (last && last.fullTimeHomeGoals !== null && last.fullTimeAwayGoals !== null) {
    const isHome = last.home.slug === teamSlug;
    const opponent = isHome ? last.away.slug : last.home.slug;
    const gf = isHome ? last.fullTimeHomeGoals : last.fullTimeAwayGoals;
    const ga = isHome ? last.fullTimeAwayGoals : last.fullTimeHomeGoals;
    latest = `${getClub(opponent).shortName} ${gf}–${ga}${isHome ? " (H)" : " (A)"}`;
  }
  return {
    teamSlug,
    teamName: getClub(teamSlug).name,
    matchesPlayed: strength.matchesPlayed,
    currentSeasonWeight: strength.currentSeasonWeight,
    goalsFor: strength.goalsFor,
    expectedGoalsFor: strength.expectedGoalsFor,
    goalsAgainst: strength.goalsAgainst,
    expectedGoalsAgainst: strength.expectedGoalsAgainst,
    attackMultiplier: strength.attackMultiplier,
    defenceMultiplier: strength.defenceMultiplier,
    latest,
  };
}

export function compareFixture(input: {
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc: string | null;
  ledgerMatches: CanonicalMatch[];
  season?: string;
  now?: string;
}): FixtureComparison {
  const season = input.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const now = input.now ?? new Date().toISOString();

  let snapshots: PredictionSnapshot[] = [];
  try {
    snapshots = listLiveSnapshots({ fixtureId: input.fixtureId, season });
  } catch {
    snapshots = [];
  }
  const settlements = loadSettlements().filter((s) => s.fixtureId === input.fixtureId);

  const frozenPair = latestValidPair({
    snapshots,
    fixtureId: input.fixtureId,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    kickoffUtc: input.kickoffUtc,
    season,
    evaluatedAt: now,
  });
  const baselineSnap = frozenPair?.baseline ?? null;
  const shadowSnap = frozenPair?.shadow ?? null;

  // Both sides must be read at the SAME cutoff. When both are frozen we use the
  // shared asOf; otherwise we preview both at `now`, so a delta is never taken
  // across two different information sets.
  const bothFrozen = Boolean(frozenPair);
  const cutoff = bothFrozen ? baselineSnap!.asOf : now;

  const shadowPrediction = predictPremierLeagueShadow({
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    asOf: cutoff,
    season,
    fixtureId: input.fixtureId,
    ledgerMatches: input.ledgerMatches,
  });

  const baselineView: SideView = bothFrozen
    ? {
        modelVersion: PRODUCTION_MODEL_VERSION,
        home: baselineSnap!.homeProbability,
        draw: baselineSnap!.drawProbability,
        away: baselineSnap!.awayProbability,
        asOf: baselineSnap!.asOf,
        predictionStage: frozenPair!.stage,
        frozen: true,
        settlement: settlementFor(settlements, baselineSnap),
      }
    : (() => {
        const live = predictPremierLeagueMatch(input.homeSlug, input.awaySlug, {
          asOf: cutoff,
          fixtureId: input.fixtureId,
        });
        return {
          modelVersion: PRODUCTION_MODEL_VERSION,
          home: live.teamAWinProbability,
          draw: live.drawProbability,
          away: live.teamBWinProbability,
          asOf: cutoff,
          predictionStage: null,
          frozen: false,
          settlement: null,
        };
      })();

  const shadowView: SideView = bothFrozen
    ? {
        modelVersion: SHADOW_MODEL_VERSION,
        home: shadowSnap!.homeProbability,
        draw: shadowSnap!.drawProbability,
        away: shadowSnap!.awayProbability,
        asOf: shadowSnap!.asOf,
        predictionStage: frozenPair!.stage,
        frozen: true,
        settlement: settlementFor(settlements, shadowSnap),
      }
    : {
        modelVersion: SHADOW_MODEL_VERSION,
        home: shadowPrediction.home,
        draw: shadowPrediction.draw,
        away: shadowPrediction.away,
        asOf: cutoff,
        predictionStage: null,
        frozen: false,
        settlement: null,
      };

  return {
    fixtureId: input.fixtureId,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    homeName: getClub(input.homeSlug).name,
    awayName: getClub(input.awaySlug).name,
    kickoffUtc: input.kickoffUtc,
    season,
    servingVersion: productionModelVersion(),
    baseline: baselineView,
    shadow: shadowView,
    delta: {
      homePp: (shadowView.home - baselineView.home) * 100,
      drawPp: (shadowView.draw - baselineView.draw) * 100,
      awayPp: (shadowView.away - baselineView.away) * 100,
    },
    evidence: {
      home: evidenceView(
        input.homeSlug,
        shadowPrediction.features.homeStrength,
        shadowPrediction.features.homeMatchIds,
        input.ledgerMatches
      ),
      away: evidenceView(
        input.awaySlug,
        shadowPrediction.features.awayStrength,
        shadowPrediction.features.awayMatchIds,
        input.ledgerMatches
      ),
    },
    explanation: explainShadowPrediction(shadowPrediction),
    pairedAndFrozen: bothFrozen,
    note: bothFrozen
      ? "Both models frozen before kickoff at the same cutoff."
      : "Preview computed at the current instant — not a frozen pre-kickoff prediction. Both sides use the same cutoff so the delta remains like-for-like.",
  };
}
