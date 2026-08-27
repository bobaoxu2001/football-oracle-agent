/**
 * Phase 4A4 prospective rating lineage.
 *
 * This module never reads mutable fixture/result state. Callers provide the
 * immutable tapes and the append-only operational verification events. Rating
 * values are recomputed from exact result revisions; old rating events are
 * only an admission proof that a fixture reached VERIFIED_FINAL.
 */

import type { Fixture } from "@/lib/identity/types";
import { completedPremierLeagueFixtures } from "../data";
import type { RatingAppliedEvent } from "../ops/types";
import {
  applyFixtureToRatings,
  applySeasonBoundary,
  emptyRatingState,
  ratingOf,
  type RatingState,
} from "../ratings";
import {
  assertFixtureRevisionIntegrity,
  assertResultCorrectionIntegrity,
  assertResultRevisionIntegrity,
  buildFrozenRatingState,
  buildVerifiedRatingEventReference,
} from "./manifest";
import {
  canonicalJson,
  canonicalSha256,
  contentAddress,
  normalizeTimestamp,
} from "./canonical";
import type {
  FixtureRevisionRecord,
  FrozenRatingStatePayload,
  FrozenRatingStateSnapshot,
  ResultCorrectionLink,
  ResultRevisionRecord,
  SeasonMembershipSnapshot,
} from "./types";

export interface SelectedPITResult {
  readonly resultRevision: ResultRevisionRecord;
  readonly fixtureRevision: FixtureRevisionRecord;
  readonly verificationEvent: RatingAppliedEvent;
}

function timestampAtOrBefore(value: string, cutoffAt: string): boolean {
  return Date.parse(value) <= Date.parse(cutoffAt);
}

function latestFixtureRevision(
  rows: readonly FixtureRevisionRecord[],
  fixtureId: string,
  season: string,
  cutoffAt: string
): FixtureRevisionRecord {
  const eligible = rows
    .filter(
      (row) =>
        row.fixtureId === fixtureId &&
        row.season === season &&
        timestampAtOrBefore(row.availableAt, cutoffAt) &&
        Date.parse(row.kickoffAt) < Date.parse(cutoffAt)
    )
    .sort(
      (a, b) =>
        a.availableAt.localeCompare(b.availableAt) ||
        a.fixtureRevisionId.localeCompare(b.fixtureRevisionId)
    );
  const selected = eligible.at(-1);
  if (!selected) {
    throw new Error(`No PIT-safe fixture revision for verified result ${fixtureId}`);
  }
  assertFixtureRevisionIntegrity(selected);
  return selected;
}

function assertCorrectionLink(
  link: ResultCorrectionLink,
  resultById: ReadonlyMap<string, ResultRevisionRecord>
): void {
  assertResultCorrectionIntegrity(link);
  const previous = resultById.get(link.previousResultRevisionId);
  const corrected = resultById.get(link.correctedResultRevisionId);
  if (!previous || !corrected) {
    throw new Error(`Correction ${link.correctionId} references a missing result revision`);
  }
  if (
    previous.fixtureId !== link.fixtureId ||
    corrected.fixtureId !== link.fixtureId ||
    corrected.supersedesResultRevisionId !== previous.resultRevisionId
  ) {
    throw new Error(`Correction ${link.correctionId} has incompatible result lineage`);
  }
  if (
    Date.parse(previous.availableAt) > Date.parse(link.availableAt) ||
    Date.parse(corrected.availableAt) > Date.parse(link.availableAt)
  ) {
    throw new Error(`Correction ${link.correctionId} predates a referenced result revision`);
  }
}

/**
 * Select one deterministic immutable final result per verified fixture.
 * Conflicting terminal scores without a correction chain fail closed.
 */
export function selectPITVerifiedResults(input: {
  season: string;
  cutoffAt: string;
  modelVersion: string;
  formulaVersion: string;
  resultRevisions: readonly ResultRevisionRecord[];
  correctionLinks: readonly ResultCorrectionLink[];
  fixtureRevisions: readonly FixtureRevisionRecord[];
  verificationEvents: readonly RatingAppliedEvent[];
}): SelectedPITResult[] {
  const cutoffAt = normalizeTimestamp(input.cutoffAt, "rating result cutoffAt");
  const verificationByFixture = new Map<string, RatingAppliedEvent>();
  for (const event of input.verificationEvents
    .slice()
    .sort(
      (a, b) =>
        a.kickoffUtc.localeCompare(b.kickoffUtc) ||
        a.fixtureId.localeCompare(b.fixtureId) ||
        a.eventId.localeCompare(b.eventId)
    )) {
    if (event.season !== input.season || !timestampAtOrBefore(event.appliedAt, cutoffAt)) {
      continue;
    }
    if (
      event.modelVersion !== input.modelVersion ||
      event.formulaVersion !== input.formulaVersion
    ) {
      throw new Error(`Incompatible rating verification event ${event.eventId}`);
    }
    if (
      !Number.isFinite(Date.parse(event.kickoffUtc)) ||
      Date.parse(event.kickoffUtc) >= Date.parse(cutoffAt) ||
      Date.parse(event.appliedAt) < Date.parse(event.kickoffUtc)
    ) {
      throw new Error(`Invalid rating verification timing for ${event.eventId}`);
    }
    const existing = verificationByFixture.get(event.fixtureId);
    if (existing && canonicalJson(existing) !== canonicalJson(event)) {
      throw new Error(`Conflicting verification events for ${event.fixtureId}`);
    }
    verificationByFixture.set(event.fixtureId, event);
  }

  const allResultById = new Map<string, ResultRevisionRecord>();
  for (const result of input.resultRevisions) {
    assertResultRevisionIntegrity(result);
    const existing = allResultById.get(result.resultRevisionId);
    if (existing && canonicalJson(existing) !== canonicalJson(result)) {
      throw new Error(`Conflicting immutable result revision ${result.resultRevisionId}`);
    }
    allResultById.set(result.resultRevisionId, result);
  }
  for (const fixture of input.fixtureRevisions) assertFixtureRevisionIntegrity(fixture);

  const eligibleCorrections = input.correctionLinks
    .filter((link) => timestampAtOrBefore(link.availableAt, cutoffAt))
    .sort(
      (a, b) =>
        a.availableAt.localeCompare(b.availableAt) || a.correctionId.localeCompare(b.correctionId)
    );
  for (const link of eligibleCorrections) assertCorrectionLink(link, allResultById);

  const selected: SelectedPITResult[] = [];
  for (const [fixtureId, verificationEvent] of [...verificationByFixture.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    const candidates = [...allResultById.values()].filter(
      (row) =>
        row.fixtureId === fixtureId &&
        row.season === input.season &&
        row.status === "FINISHED" &&
        row.homeScore !== null &&
        row.awayScore !== null &&
        timestampAtOrBefore(row.availableAt, cutoffAt)
    );
    if (!candidates.length) {
      throw new Error(`No immutable verified result revision for ${fixtureId}`);
    }
    const candidateIds = new Set(candidates.map((row) => row.resultRevisionId));
    const superseded = new Set<string>();
    for (const row of candidates) {
      if (row.supersedesResultRevisionId) {
        const previous = allResultById.get(row.supersedesResultRevisionId);
        if (!previous) {
          throw new Error(
            `Result ${row.resultRevisionId} supersedes a missing result revision`
          );
        }
        if (
          previous.fixtureId !== row.fixtureId ||
          previous.season !== row.season
        ) {
          throw new Error(
            `Result ${row.resultRevisionId} has incompatible supersession lineage`
          );
        }
        if (Date.parse(previous.availableAt) > Date.parse(row.availableAt)) {
          throw new Error(
            `Result ${row.resultRevisionId} supersedes a temporally later revision`
          );
        }
        const scoreChanged =
          previous.status === "FINISHED" &&
          (previous.homeScore !== row.homeScore || previous.awayScore !== row.awayScore);
        if (
          scoreChanged &&
          !eligibleCorrections.some(
            (link) =>
              link.fixtureId === fixtureId &&
              link.previousResultRevisionId === previous.resultRevisionId &&
              link.correctedResultRevisionId === row.resultRevisionId
          )
        ) {
          throw new Error(`Result correction lineage is incomplete for ${fixtureId}`);
        }
        if (candidateIds.has(previous.resultRevisionId)) {
          superseded.add(previous.resultRevisionId);
        }
      }
    }
    for (const link of eligibleCorrections) {
      if (
        link.fixtureId === fixtureId &&
        candidateIds.has(link.previousResultRevisionId) &&
        candidateIds.has(link.correctedResultRevisionId)
      ) {
        superseded.add(link.previousResultRevisionId);
      }
    }
    const terminals = candidates.filter((row) => !superseded.has(row.resultRevisionId));
    if (!terminals.length) throw new Error(`Result correction cycle for ${fixtureId}`);
    const terminalScores = new Set(
      terminals.map((row) => `${row.homeScore}:${row.awayScore}`)
    );
    if (terminalScores.size !== 1) {
      throw new Error(`Conflicting PIT result revisions for ${fixtureId}`);
    }
    // The operational verification event is the only immutable evidence of
    // which score the rating engine originally admitted. Anchor the revision
    // tape to that exact score. A later score may be selected only when its
    // supersession chain reaches an eligible anchor; every score-changing edge
    // in that chain has already been required to carry a pre-cutoff correction
    // link above. This rejects unrelated 3-1 evidence for a verified 2-0 event,
    // even though those scores happen to produce the same Elo update.
    const verifiedScoreAnchors = new Set(
      candidates
        .filter(
          (row) =>
            row.homeScore === verificationEvent.homeGoals &&
            row.awayScore === verificationEvent.awayGoals
        )
        .map((row) => row.resultRevisionId)
    );
    if (!verifiedScoreAnchors.size) {
      throw new Error(`Result revisions do not anchor the verified score for ${fixtureId}`);
    }
    const reachesVerifiedScore = (terminal: ResultRevisionRecord): boolean => {
      const visited = new Set<string>();
      let current: ResultRevisionRecord | undefined = terminal;
      while (current && !visited.has(current.resultRevisionId)) {
        if (verifiedScoreAnchors.has(current.resultRevisionId)) return true;
        visited.add(current.resultRevisionId);
        const previousId = current.supersedesResultRevisionId;
        if (!previousId || !candidateIds.has(previousId)) return false;
        current = allResultById.get(previousId);
      }
      return false;
    };
    const anchoredTerminals = terminals.filter(reachesVerifiedScore);
    if (!anchoredTerminals.length) {
      throw new Error(`Result correction chain is not anchored to the verified score for ${fixtureId}`);
    }
    const resultRevision = anchoredTerminals
      .slice()
      .sort(
        (a, b) =>
          a.availableAt.localeCompare(b.availableAt) ||
          a.resultRevisionId.localeCompare(b.resultRevisionId)
      )
      .at(-1)!;
    const fixtureRevision = latestFixtureRevision(
      input.fixtureRevisions,
      fixtureId,
      input.season,
      cutoffAt
    );
    if (
      verificationEvent.homeSlug !== fixtureRevision.homeSlug ||
      verificationEvent.awaySlug !== fixtureRevision.awaySlug ||
      verificationEvent.kickoffUtc !== fixtureRevision.kickoffAt
    ) {
      throw new Error(`Verification event does not match fixture revision for ${fixtureId}`);
    }
    if (
      !fixtureRevision.homeSlug ||
      !fixtureRevision.awaySlug ||
      !fixtureRevision.sourceObservation
    ) {
      throw new Error(`Incomplete fixture identity for verified result ${fixtureId}`);
    }
    selected.push({ resultRevision, fixtureRevision, verificationEvent });
  }
  return selected.sort(
    (a, b) =>
      a.fixtureRevision.kickoffAt.localeCompare(b.fixtureRevision.kickoffAt) ||
      a.fixtureRevision.fixtureId.localeCompare(b.fixtureRevision.fixtureId) ||
      a.resultRevision.resultRevisionId.localeCompare(b.resultRevision.resultRevisionId)
  );
}

function baseStateForSeason(input: {
  season: string;
  membership: SeasonMembershipSnapshot;
  asOf: string;
}): RatingState {
  const state = emptyRatingState();
  const history = completedPremierLeagueFixtures()
    .filter((fixture) => fixture.season < input.season)
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    );
  for (const fixture of history) applyFixtureToRatings(state, fixture);
  applySeasonBoundary(
    state,
    input.season,
    [...input.membership.teamSlugs],
    input.asOf.slice(0, 10),
    { useChampionshipFeeder: true }
  );
  return state;
}

function projectedState(
  state: RatingState,
  membership: SeasonMembershipSnapshot
): FrozenRatingStatePayload {
  return {
    season: membership.season,
    clubSlugs: membership.teamSlugs,
    ratings: Object.fromEntries(
      membership.teamSlugs.map((slug) => [slug, ratingOf(state, slug)])
    ),
    matchesPlayedSeason: Object.fromEntries(
      membership.teamSlugs.map((slug) => [
        slug,
        state.matchesPlayedSeason[slug] ?? 0,
      ])
    ),
  };
}

export interface RatingReplayComparison {
  readonly maxAbsoluteRatingDifference: number;
  readonly meanAbsoluteRatingDifference: number;
  readonly differingTeamCount: number;
  readonly recomputedStateHash: string;
  readonly productionStateHash: string;
}

export function ratingReplayMatchesExactly(
  comparison: RatingReplayComparison
): boolean {
  return (
    comparison.differingTeamCount === 0 &&
    comparison.recomputedStateHash === comparison.productionStateHash
  );
}

export function compareRatingStates(
  recomputed: FrozenRatingStatePayload,
  production: FrozenRatingStatePayload,
  tolerance = 1e-9
): RatingReplayComparison {
  if (
    recomputed.season !== production.season ||
    canonicalJson(recomputed.clubSlugs) !== canonicalJson(production.clubSlugs)
  ) {
    throw new Error("Rating replay membership/season mismatch");
  }
  const differences = recomputed.clubSlugs.map((slug) =>
    Math.abs(recomputed.ratings[slug] - production.ratings[slug])
  );
  for (const slug of recomputed.clubSlugs) {
    if (
      recomputed.matchesPlayedSeason[slug] !==
      production.matchesPlayedSeason[slug]
    ) {
      throw new Error(`Rating replay match-count mismatch for ${slug}`);
    }
  }
  return {
    maxAbsoluteRatingDifference: Math.max(0, ...differences),
    meanAbsoluteRatingDifference:
      differences.reduce((sum, value) => sum + value, 0) /
      Math.max(1, differences.length),
    differingTeamCount: differences.filter((value) => value > tolerance).length,
    recomputedStateHash: canonicalSha256(recomputed),
    productionStateHash: canonicalSha256(production),
  };
}

export interface RecomputedProspectiveRatingState {
  readonly ratingState: FrozenRatingStateSnapshot;
  readonly selectedResults: readonly SelectedPITResult[];
}

/** Deterministic, store-free state recomputation from exact immutable inputs. */
export function recomputeProspectiveRatingState(input: {
  computedAt: string;
  membership: SeasonMembershipSnapshot;
  modelVersion: string;
  formulaVersion: string;
  featureCodeVersion: string;
  codeCommitSha: string;
  resultRevisions: readonly ResultRevisionRecord[];
  correctionLinks: readonly ResultCorrectionLink[];
  fixtureRevisions: readonly FixtureRevisionRecord[];
  verificationEvents: readonly RatingAppliedEvent[];
}): RecomputedProspectiveRatingState {
  const computedAt = normalizeTimestamp(input.computedAt, "rating state computedAt");
  const selectedResults = selectPITVerifiedResults({
    season: input.membership.season,
    cutoffAt: computedAt,
    modelVersion: input.modelVersion,
    formulaVersion: input.formulaVersion,
    resultRevisions: input.resultRevisions,
    correctionLinks: input.correctionLinks,
    fixtureRevisions: input.fixtureRevisions,
    verificationEvents: input.verificationEvents,
  });
  const state = baseStateForSeason({
    season: input.membership.season,
    membership: input.membership,
    asOf: computedAt,
  });
  const events = selectedResults.map(
    ({ resultRevision, fixtureRevision, verificationEvent }) => {
      const preHome = ratingOf(state, fixtureRevision.homeSlug);
      const preAway = ratingOf(state, fixtureRevision.awaySlug);
      const preHomeMatches = state.matchesPlayedSeason[fixtureRevision.homeSlug] ?? 0;
      const preAwayMatches = state.matchesPlayedSeason[fixtureRevision.awaySlug] ?? 0;
      const venue: "home" | "neutral" =
        fixtureRevision.venue === "neutral" ? "neutral" : "home";
      const fixture: Fixture = {
        id: fixtureRevision.fixtureId,
        competition: "premier-league",
        season: fixtureRevision.season,
        date: fixtureRevision.kickoffAt.slice(0, 10),
        kickoffUtc: fixtureRevision.kickoffAt,
        homeSlug: fixtureRevision.homeSlug,
        awaySlug: fixtureRevision.awaySlug,
        homeGoals: resultRevision.homeScore,
        awayGoals: resultRevision.awayScore,
        status: "FINISHED",
        venue,
      };
      applyFixtureToRatings(state, fixture);
      const ratingUpdateInputs = {
        homeSlug: fixtureRevision.homeSlug,
        awaySlug: fixtureRevision.awaySlug,
        homeScore: resultRevision.homeScore!,
        awayScore: resultRevision.awayScore!,
        venue,
        preHome,
        preAway,
        preHomeMatches,
        preAwayMatches,
        postHome: ratingOf(state, fixtureRevision.homeSlug),
        postAway: ratingOf(state, fixtureRevision.awaySlug),
        postHomeMatches: state.matchesPlayedSeason[fixtureRevision.homeSlug] ?? 0,
        postAwayMatches: state.matchesPlayedSeason[fixtureRevision.awaySlug] ?? 0,
        formulaVersion: input.formulaVersion,
        modelVersion: input.modelVersion,
        verificationEventId: verificationEvent.eventId,
      } as const;
      const identity = {
        fixtureId: fixtureRevision.fixtureId,
        fixtureRevisionId: fixtureRevision.fixtureRevisionId,
        resultRevisionId: resultRevision.resultRevisionId,
        verificationEventId: verificationEvent.eventId,
        formulaVersion: input.formulaVersion,
        modelVersion: input.modelVersion,
      };
      return buildVerifiedRatingEventReference({
        ratingEventId: contentAddress("pl-rating-event", identity),
        fixtureId: fixtureRevision.fixtureId,
        fixtureKickoff: fixtureRevision.kickoffAt,
        appliedAt: computedAt,
        availableAt: computedAt,
        resultRevisionId: resultRevision.resultRevisionId,
        resultPayloadHash: resultRevision.resultPayloadHash,
        resultAvailableAt: resultRevision.availableAt,
        fixtureRevisionId: fixtureRevision.fixtureRevisionId,
        fixturePayloadHash: fixtureRevision.fixturePayloadHash,
        ratingUpdateInputs,
      });
    }
  );
  const ratingState = buildFrozenRatingState({
    season: input.membership.season,
    asOf: computedAt,
    availableAt: computedAt,
    modelVersion: input.modelVersion,
    formulaVersion: input.formulaVersion,
    seasonMembershipSnapshotId: input.membership.seasonMembershipSnapshotId,
    ratingEvents: events,
    state: projectedState(state, input.membership),
    ratingResultLineageStatus: "VERIFIED",
    featureCodeVersion: input.featureCodeVersion,
    codeCommitSha: input.codeCommitSha,
  });
  return { ratingState, selectedResults };
}
