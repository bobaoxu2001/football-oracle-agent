/**
 * Premier League match prediction — the Phase 1 canonical league path.
 *
 * Elo (walk-forward, as-of kickoff) + true home advantage + goal-expectation
 * mapping + Dixon-Coles τ. No availability, no tactical overlays, no V2
 * ensemble, no news nudge. Those features are excluded until they can be
 * timestamped historically.
 */

import type { MatchPrediction, ModelFactor } from "@/lib/types";
import { matchProb, scorelineGrid } from "./elo";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { ratingsAsOf } from "@/lib/competitions/premier-league/ratings";
import {
  liveRatingEventsAsOf,
  liveRatingsAsOf,
} from "@/lib/competitions/premier-league/ops/live-ratings";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { completedPremierLeagueFixtures } from "@/lib/competitions/premier-league/data";
import { auditPrediction } from "@/lib/model-auditor/audit";
import { createSnapshot, type PredictionSnapshot } from "@/lib/snapshots/store";
import type { EvaluationClass, PredictionStage } from "@/lib/snapshots/types";
import { evaluationClassFor, stageFromTiming } from "@/lib/competitions/premier-league/stages";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { SEASON_INIT_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import { liveCompetitionSeason } from "@/lib/competitions/premier-league/fixture-store";
import type { SnapshotOrigin } from "@/lib/competitions/premier-league/ops/types";
import type { KickoffCertainty } from "@/lib/identity/types";
import type { MatchContextSnapshot } from "@/lib/competitions/premier-league/context/types";
import { assertMatchContextIntegrity } from "@/lib/competitions/premier-league/context/snapshot";
import { snapshotUniqueKey } from "@/lib/snapshots/types";

export interface LeaguePredictOptions {
  asOf?: string;
  kickoff?: string;
  fixtureId?: string;
  season?: string;
  predictionStage?: PredictionStage;
  evaluationClass?: EvaluationClass;
  origin?: SnapshotOrigin;
  computedAt?: string;
  fixtureDataVersion?: string | null;
  kickoffCertaintyAtFreeze?: KickoffCertainty | null;
  fixtureRetrievedAt?: string | null;
  /**
   * Immutable audit-only context reference. The current champion does not
   * consume contextual evidence in its probability math; any claim that it
   * did therefore fails closed below.
   */
  contextSnapshot?: MatchContextSnapshot;
  /** Test/back-compat: skip live rating events and use date-strict historical ratings. */
  ratingsMode?: "live" | "historical";
}

function confidenceFrom(topProb: number) {
  const score = Math.round(topProb * 100);
  const level =
    score >= 62 ? "Very High" : score >= 50 ? "High" : score >= 40 ? "Moderate" : "Low";
  return { level, score } as const;
}

function upsetFrom(winA: number, winB: number) {
  const dog = Math.min(winA, winB);
  if (dog >= 0.3) return "High" as const;
  if (dog >= 0.2) return "Elevated" as const;
  return "Low" as const;
}

export function predictPremierLeagueMatch(
  homeSlug: string,
  awaySlug: string,
  options: LeaguePredictOptions = {}
): MatchPrediction {
  const params = loadProductionParams();
  const home = getClub(homeSlug);
  const away = getClub(awaySlug);
  const asOf = options.asOf ?? options.kickoff ?? new Date().toISOString();
  const asOfDate = asOf.slice(0, 10);
  const state =
    options.ratingsMode === "historical"
      ? ratingsAsOf(asOfDate)
      : liveRatingsAsOf(asOf);
  const eloH = state.ratings[homeSlug] ?? 1500;
  const eloA = state.ratings[awaySlug] ?? 1500;
  const goalOpts = { rho: params.dcRho, awayHomeShare: params.awayHomeShare };
  const p = matchProb(eloH, eloA, params.homeAdvantage, goalOpts);
  const grid = scorelineGrid(eloH, eloA, params.homeAdvantage, goalOpts)
    .slice()
    .sort((a, b) => b.p - a.p);
  const top = grid[0];
  const topProb = Math.max(p.winA, p.draw, p.winB);
  const conf = confidenceFrom(topProb);

  const factors: ModelFactor[] = [
    {
      label: "Elo strength",
      detail: `${home.name} ${Math.round(eloH)} vs ${away.name} ${Math.round(eloA)} (as-of ${asOf}, walk-forward only).`,
      weight: Math.abs(eloH - eloA) >= 80 ? "high" : "medium",
    },
    {
      label: "True home advantage",
      detail: `${home.name} receive +${params.homeAdvantage} Elo as the home side. Not a World Cup host-nation bonus.`,
      weight: "medium",
    },
    {
      label: "Goal expectation (Dixon-Coles)",
      detail: `Model projects ${p.expectedGoalsA.toFixed(2)} expected goals for ${home.name} and ${p.expectedGoalsB.toFixed(2)} for ${away.name}. λ is mapped from Elo, not shot-based xG. ρ = ${params.dcRho}.`,
      weight: "medium",
    },
    {
      label: "Model version",
      detail: `${params.modelVersion} · training window ${params.trainingWindow.from} → ${params.trainingWindow.to} · fitted ${params.fittedAt}.`,
      weight: "low",
    },
    {
      label: "Inputs in use",
      detail:
        "League-strength baseline, home advantage, season-transition priors and Dixon-Coles score model. Not used: market odds, injuries, lineups, transfers, or shot-based xG.",
      weight: "low",
    },
  ];

  const favName = p.winA >= p.winB ? home.name : away.name;
  const favProb = Math.max(p.winA, p.winB);
  const prediction: MatchPrediction = {
    matchId: options.fixtureId ?? `${homeSlug}-vs-${awaySlug}`,
    teamA: homeSlug,
    teamB: awaySlug,
    teamAWinProbability: p.winA,
    drawProbability: p.draw,
    teamBWinProbability: p.winB,
    expectedGoalsA: p.expectedGoalsA,
    expectedGoalsB: p.expectedGoalsB,
    expectedScore: `${p.expectedGoalsA.toFixed(1)} – ${p.expectedGoalsB.toFixed(1)}`,
    mostLikelyScoreline: `${top.a}–${top.b}`,
    confidenceLevel: conf.level,
    confidenceScore: conf.score,
    upsetRisk: upsetFrom(p.winA, p.winB),
    eloA: eloH,
    eloB: eloA,
    eloBreakdown: {
      a: {
        base: eloH,
        squadStabilityAdjustment: 0,
        verifiedNewsAdjustment: 0,
        adjusted: eloH,
      },
      b: {
        base: eloA,
        squadStabilityAdjustment: 0,
        verifiedNewsAdjustment: 0,
        adjusted: eloA,
      },
    },
    topScorelines: grid.slice(0, 6).map((g) => ({ score: `${g.a}–${g.b}`, prob: g.p })),
    factors,
    modelSummary:
      favProb >= 0.45
        ? `${favName} favoured at ${(favProb * 100).toFixed(0)}% — ${conf.level.toLowerCase()} model confidence.`
        : `Even Premier League matchup — ${favName} ${((favProb) * 100).toFixed(0)}%, draw ${(p.draw * 100).toFixed(0)}%.`,
    fullReport: `${home.name} (home) vs ${away.name}. Closed-form Dixon-Coles 1X2 from walk-forward Elo. Model ${params.modelVersion}. Probability estimate, not a guaranteed outcome.`,
    modelVersion: params.modelVersion,
    asOf,
    competition: "premier-league",
  };

  const audit = auditPrediction(prediction);
  if (audit.status === "fail") {
    prediction.factors.push({
      label: "Auditor",
      detail: `Auditor flagged: ${audit.issues.map((i) => i.message).join(" ")}`,
      weight: "low",
    });
  }
  return prediction;
}

export function snapshotPremierLeagueMatch(
  homeSlug: string,
  awaySlug: string,
  options: LeaguePredictOptions = {}
): PredictionSnapshot {
  const pred = predictPremierLeagueMatch(homeSlug, awaySlug, options);
  const params = loadProductionParams();
  const homeClub = getClub(homeSlug);
  const awayClub = getClub(awaySlug);
  const asOf = pred.asOf ?? options.asOf ?? new Date().toISOString();
  const kickoff = options.kickoff ?? null;
  const stage = options.predictionStage ?? stageFromTiming(asOf, kickoff);
  const evaluationClass = evaluationClassFor({
    asOf,
    kickoffUtc: kickoff,
    intended: options.evaluationClass,
  });
  const ratingEvents =
    options.ratingsMode === "historical" ? [] : liveRatingEventsAsOf(asOf);
  const latestRatingEventAppliedAt = ratingEvents
    .map((event) => event.appliedAt)
    .sort()
    .at(-1) ?? null;
  const season = options.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const context = options.contextSnapshot;
  if (context) {
    assertMatchContextIntegrity(context);
    const expectedForecastKey = snapshotUniqueKey({
      competition: "premier-league",
      season,
      fixtureId: pred.matchId,
      modelVersion: params.modelVersion,
      predictionStage: stage,
      asOf,
    });
    if (
      context.fixtureId !== pred.matchId ||
      context.season !== season ||
      context.homeSlug !== homeSlug ||
      context.awaySlug !== awaySlug ||
      context.cutoffAt !== asOf ||
      context.kickoffAt !== kickoff ||
      context.forecastSnapshotKey !== expectedForecastKey
    ) {
      throw new Error("Match context does not reference this exact forecast snapshot.");
    }
    if (context.usedInForecastEvidenceIds.length > 0) {
      throw new Error(
        `${params.modelVersion} cannot claim contextual evidence was used in forecast math.`
      );
    }
  }
  return createSnapshot({
    fixtureId: pred.matchId,
    competition: "premier-league",
    season,
    asOf,
    kickoff,
    modelVersion: params.modelVersion,
    predictionStage: stage,
    evaluationClass,
    homeSlug,
    awaySlug,
    homeTeam: homeClub.name,
    awayTeam: awayClub.name,
    home: pred.teamAWinProbability,
    draw: pred.drawProbability,
    away: pred.teamBWinProbability,
    homeExpectedGoals: pred.expectedGoalsA,
    awayExpectedGoals: pred.expectedGoalsB,
    // Freeze the complete normalized 9×9 Dixon-Coles distribution. Older
    // immutable rows stored only the top six; the Match Forecast service can
    // reconstruct those from their frozen lambdas + rho without rewriting
    // history. Every new snapshot carries the canonical probability artifact.
    scorelineDistribution: Object.fromEntries(
      scorelineGrid(pred.eloA, pred.eloB, params.homeAdvantage, {
        rho: params.dcRho,
        awayHomeShare: params.awayHomeShare,
      }).map((s) => [`${s.a}–${s.b}`, s.p])
    ),
    modelParameters: {
      homeAdvantage: params.homeAdvantage,
      dcRho: params.dcRho,
      kFactor: params.kFactor,
      fittedAt: params.fittedAt,
      trainingWindow: params.trainingWindow,
    },
    sourceState: {
      eloHome: pred.eloA,
      eloAway: pred.eloB,
      fixturesUsed: completedPremierLeagueFixtures().filter(
        (f) => f.date < asOf.slice(0, 10)
      ).length + ratingEvents.length,
      ratingEventsUsed: ratingEvents.length,
      ratingEventIds: ratingEvents.map((event) => event.eventId),
      latestRatingEventAppliedAt,
      ratingStateAsOf: asOf,
      computedAt: options.computedAt ?? asOf,
      origin: options.origin ?? "manual",
      fixtureDataVersion:
        Object.prototype.hasOwnProperty.call(options, "fixtureDataVersion")
          ? options.fixtureDataVersion ?? null
          : liveCompetitionSeason()?.dataVersion ?? null,
      kickoffCertaintyAtFreeze: options.kickoffCertaintyAtFreeze ?? null,
      fixtureRetrievedAt: options.fixtureRetrievedAt ?? null,
      seasonInitVersion: SEASON_INIT_VERSION,
      contextSnapshotId: context?.contextId ?? null,
      contextSchemaVersion: context?.schemaVersion ?? null,
      contextSnapshotCutoffAt: context?.cutoffAt ?? null,
      contextSnapshotGeneratedAt: context?.generatedAt ?? null,
      contextTemporalRule: context?.temporalRule ?? null,
      contextLineupStatus: context?.lineup.overall ?? "NONE",
      contextLineupAvailableAt:
        [context?.lineup.home.availableAt, context?.lineup.away.availableAt]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? null,
      contextEvidenceCount: context?.evidence.length ?? 0,
      contextModelUsedEvidenceCount: context?.usedInForecastEvidenceIds.length ?? 0,
      contextInformationalEvidenceCount:
        context ? context.evidence.length - context.usedInForecastEvidenceIds.length : 0,
      contextUsedInForecastEvidenceIds: context?.usedInForecastEvidenceIds ?? [],
    },
    provenanceNotes:
      options.origin === "scheduled"
        ? `Scheduled ${stage} observation. asOf is the stage target. Ratings frozen at ratingStateAsOf. FINAL_PREKICK is not lineup-confirmed.`
        : "Durable snapshot. Key = competition+season+fixtureId+modelVersion+predictionStage+asOf. Not recomputed on read.",
  });
}
