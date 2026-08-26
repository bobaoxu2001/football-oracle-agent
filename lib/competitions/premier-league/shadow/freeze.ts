/**
 * Freeze shadow predictions alongside the baseline's.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BASELINE IMMUTABILITY
 *
 * This module runs AFTER the baseline scheduler has finished. It never calls,
 * wraps, or modifies freezeScheduledStage; it reads which baseline jobs already
 * succeeded and mints a parallel snapshot under a different model version.
 *
 * Snapshot identity is (competition, season, fixtureId, modelVersion, stage,
 * asOf) and createSnapshot is first-write-wins, so:
 *   • the two models can never overwrite each other — the versions differ;
 *   • re-running is a no-op — the key is unchanged;
 *   • a baseline snapshot is untouchable from here by construction.
 *
 * The shadow reuses the baseline job's `plannedAsOf`, so both models are frozen
 * at exactly the same cutoff for the same stage. A comparison across different
 * cutoffs would be meaningless.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { createSnapshot, type PredictionSnapshot } from "@/lib/snapshots/store";
import { canonicalizePredictionStage } from "@/lib/snapshots/types";
import { evaluationClassFor } from "../stages";
import { getClub } from "../clubs";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "../config";
import { loadProductionParams, PRODUCTION_MODEL_VERSION, SEASON_INIT_VERSION } from "../model-tracks";
import { liveCompetitionSeason } from "../fixture-store";
import { listJobs } from "../ops/job-ledger";
import { archiveOperationalLiveOos } from "../ops/operational-archive";
import { listLiveSnapshots } from "../ops/live-snapshot-reader";
import { loadSettlements } from "../settlement";
import { plannedAsOfIsBeforeKickoff } from "../ops/stage-windows";
import type { CanonicalMatch } from "@/lib/match-ledger/types";
import { predictPremierLeagueShadow, type ShadowPrediction } from "./model";
import { SHADOW_MODEL_VERSION, shadowModelEnabled } from "./track";

export interface FreezeShadowInput {
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  kickoffUtc: string;
  /** The baseline job's cutoff. Must be identical for a valid comparison. */
  plannedAsOf: string;
  predictionStage: string;
  season?: string;
  computedAt: string;
  ledgerMatches: CanonicalMatch[];
}

/**
 * Build the immutable shadow snapshot for one fixture-stage.
 *
 * Refuses any cutoff at or after kickoff, exactly as the baseline path does —
 * a "pre-match" prediction frozen after kickoff would silently corrupt the
 * paired evaluation.
 */
export function snapshotShadowPrediction(
  input: FreezeShadowInput
): { snapshot: PredictionSnapshot; prediction: ShadowPrediction } {
  if (!plannedAsOfIsBeforeKickoff(input.plannedAsOf, input.kickoffUtc)) {
    throw new Error(
      `Refusing shadow ${input.predictionStage} for ${input.fixtureId}: ` +
        `plannedAsOf ${input.plannedAsOf} is not < kickoff ${input.kickoffUtc}`
    );
  }
  if (Date.parse(input.computedAt) >= Date.parse(input.kickoffUtc)) {
    throw new Error(
      `Refusing shadow ${input.predictionStage} for ${input.fixtureId}: ` +
        `computedAt ${input.computedAt} is not < kickoff ${input.kickoffUtc}`
    );
  }

  const season = input.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const params = loadProductionParams();
  const prediction = predictPremierLeagueShadow({
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    asOf: input.plannedAsOf,
    season,
    fixtureId: input.fixtureId,
    ledgerMatches: input.ledgerMatches,
  });

  const snapshot = createSnapshot({
    fixtureId: input.fixtureId,
    competition: "premier-league",
    season,
    asOf: input.plannedAsOf,
    kickoff: input.kickoffUtc,
    modelVersion: SHADOW_MODEL_VERSION,
    predictionStage: input.predictionStage as never,
    evaluationClass: evaluationClassFor({
      asOf: input.plannedAsOf,
      kickoffUtc: input.kickoffUtc,
      intended: "LIVE_OOS",
    }),
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    homeTeam: getClub(input.homeSlug).name,
    awayTeam: getClub(input.awaySlug).name,
    home: prediction.home,
    draw: prediction.draw,
    away: prediction.away,
    homeExpectedGoals: prediction.homeExpectedGoals,
    awayExpectedGoals: prediction.awayExpectedGoals,
    scorelineDistribution: prediction.scorelineDistribution,
    modelParameters: {
      homeAdvantage: params.homeAdvantage,
      dcRho: params.dcRho,
      kFactor: params.kFactor,
      fittedAt: params.fittedAt,
      trainingWindow: params.trainingWindow,
      challenger: true,
      championVersion: params.modelVersion,
    },
    // Feature provenance travels WITH the frozen prediction, so the evidence a
    // prediction was allowed to see is auditable after the fact and cannot be
    // reconstructed (or misremembered) later.
    sourceState: {
      eloHome: prediction.baseline.eloHome,
      eloAway: prediction.baseline.eloAway,
      ratingStateAsOf: input.plannedAsOf,
      computedAt: input.computedAt,
      origin: "scheduled",
      fixtureDataVersion: liveCompetitionSeason()?.dataVersion ?? null,
      seasonInitVersion: SEASON_INIT_VERSION,
      featureCutoff: prediction.features.featureCutoff,
      currentSeasonMatchesHome: prediction.features.homeStrength.matchesPlayed,
      currentSeasonMatchesAway: prediction.features.awayStrength.matchesPlayed,
      currentSeasonWeightHome: prediction.features.homeStrength.currentSeasonWeight,
      currentSeasonWeightAway: prediction.features.awayStrength.currentSeasonWeight,
      attackMultiplierHome: prediction.features.homeStrength.attackMultiplier,
      defenceMultiplierHome: prediction.features.homeStrength.defenceMultiplier,
      attackMultiplierAway: prediction.features.awayStrength.attackMultiplier,
      defenceMultiplierAway: prediction.features.awayStrength.defenceMultiplier,
      evidenceMatchIdsHome: prediction.features.homeMatchIds,
      evidenceMatchIdsAway: prediction.features.awayMatchIds,
      latestEvidenceKickoff: prediction.features.latestEvidenceKickoff,
      latestEvidenceObservedAt: prediction.features.latestEvidenceObservedAt,
      baselineHome: prediction.baseline.home,
      baselineDraw: prediction.baseline.draw,
      baselineAway: prediction.baseline.away,
    },
    provenanceNotes:
      `EXPERIMENTAL challenger ${SHADOW_MODEL_VERSION}. Frozen at the same cutoff as the ` +
      `${params.modelVersion} baseline for this stage. Never served as production. ` +
      `Current-season correction is a Gamma-Poisson shrunk residual against the baseline's ` +
      `own walk-forward expectations.`,
  });

  return { snapshot, prediction };
}

export interface ShadowFreezeReport {
  enabled: boolean;
  jobsConsidered: number;
  frozen: number;
  alreadyPresent: number;
  skipped: number;
  errors: string[];
}

/**
 * Freeze a shadow snapshot for every baseline job that has already succeeded.
 *
 * Idempotent: an existing shadow snapshot for the same (fixture, stage, asOf)
 * is detected and skipped, and createSnapshot would refuse to overwrite anyway.
 */
export function freezeShadowForCompletedJobs(input: {
  now: string;
  ledgerMatches: CanonicalMatch[];
  season?: string;
}): ShadowFreezeReport {
  const report: ShadowFreezeReport = {
    enabled: shadowModelEnabled(),
    jobsConsidered: 0,
    frozen: 0,
    alreadyPresent: 0,
    skipped: 0,
    errors: [],
  };
  if (!report.enabled) return report;

  const season = input.season ?? PREMIER_LEAGUE_CURRENT_SEASON;
  const nowMs = Date.parse(input.now);
  const live = listLiveSnapshots({ season });
  const settledFixtures = new Set(
    loadSettlements()
      .filter((s) => s.season === season)
      .map((s) => s.fixtureId)
  );

  function findLive(
    fixtureId: string,
    stage: string,
    modelVersion: string,
    asOf: string
  ): PredictionSnapshot | null {
    const canonical = canonicalizePredictionStage(stage);
    return (
      live.find(
        (s) =>
          s.fixtureId === fixtureId &&
          s.modelVersion === modelVersion &&
          canonicalizePredictionStage(s.predictionStage) === canonical &&
          s.asOf === asOf
      ) ?? null
    );
  }

  for (const job of listJobs()) {
    if (job.status !== "SUCCEEDED") continue;
    if (job.season !== season) continue;
    report.jobsConsidered += 1;

    // The shadow cannot be frozen after kickoff: it would not be a pre-match
    // prediction, and pairing it with the baseline would be dishonest.
    if (!Number.isFinite(nowMs) || nowMs >= Date.parse(job.kickoffUtc)) {
      report.skipped += 1;
      continue;
    }

    // A fixture that has already been settled is historical. Minting a shadow
    // now, even at the original plannedAsOf, would reconstruct a prediction
    // after the result is known. That is not OOS evidence.
    if (settledFixtures.has(job.fixtureId)) {
      report.skipped += 1;
      continue;
    }

    const existing = findLive(job.fixtureId, job.stage, SHADOW_MODEL_VERSION, job.plannedAsOf);
    if (existing) {
      report.alreadyPresent += 1;
      continue;
    }

    const baseline = findLive(
      job.fixtureId,
      job.stage,
      job.modelVersion || PRODUCTION_MODEL_VERSION,
      job.plannedAsOf
    );
    if (!baseline) {
      report.errors.push(
        `${job.fixtureId}/${job.stage}: no baseline snapshot at ${job.plannedAsOf}; refusing to freeze an unpaired shadow`
      );
      continue;
    }

    try {
      const { snapshot } = snapshotShadowPrediction({
        fixtureId: job.fixtureId,
        homeSlug: baseline.homeSlug,
        awaySlug: baseline.awaySlug,
        kickoffUtc: job.kickoffUtc,
        plannedAsOf: job.plannedAsOf,
        predictionStage: job.stage,
        season,
        computedAt: input.now,
        ledgerMatches: input.ledgerMatches,
      });
      archiveOperationalLiveOos([snapshot]);
      live.push(snapshot);
      report.frozen += 1;
    } catch (err) {
      report.errors.push(`${job.fixtureId}/${job.stage}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * Recover home/away slugs from a canonical fixture id.
 *
 * Ids are `pl-{season}-{homeSlug}-{awaySlug}` and slugs themselves contain
 * hyphens, so the split is done against the known club list rather than by
 * counting separators.
 */
export function slugsFromJob(fixtureId: string): { home: string; away: string } {
  const withoutPrefix = fixtureId.replace(/^pl-\d{4}-\d{2}-/, "");
  const clubs = knownSlugs();
  for (const home of clubs) {
    if (!withoutPrefix.startsWith(`${home}-`)) continue;
    const away = withoutPrefix.slice(home.length + 1);
    if (clubs.includes(away)) return { home, away };
  }
  throw new Error(`Cannot resolve club slugs from fixture id: ${fixtureId}`);
}

let cachedSlugs: string[] | null = null;
function knownSlugs(): string[] {
  if (cachedSlugs) return cachedSlugs;
  // Longest first so "manchester-united" is matched before any shorter prefix.
  const season = liveCompetitionSeason();
  const slugs = season?.clubIds ?? [];
  cachedSlugs = [...slugs].sort((a, b) => b.length - a.length);
  return cachedSlugs;
}

export function resetShadowSlugCacheForTests(): void {
  cachedSlugs = null;
}
