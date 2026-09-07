import { createHash } from "node:crypto";
import { assessAvailability, bandImpact, mapAvailabilityState } from "./availability";
import {
  contextStageFromLineup,
  evidenceRef,
  legallyAvailable,
  lineupStateFromStage,
} from "./evidence";
import { buildPlayerImportance } from "./importance";
import { assessKillResistance } from "./kill-resistance";
import { assessMatchups } from "./matchup";
import { assessMotivation } from "./motivation";
import { assessOpponentExperience } from "./opponent-type";
import { assessReplacement } from "./replacement";
import { assessUnits } from "./units";
import {
  INTELLIGENCE_TEMPORAL_RULE,
  MATCH_INTELLIGENCE_SCHEMA_VERSION,
  type IntelligenceStance,
  type MatchIntelligenceInput,
  type PremierLeagueMatchIntelligenceReport,
  type SourceConflict,
} from "./types";

const DISCLAIMER =
  "Contextual intelligence — not included in the frozen champion probability unless stated otherwise. includedInChampionProbability is always false for pl-live-v0.2.0.";

function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function stanceOf(report: {
  homeSlug: string;
  intelligenceConfidence: PremierLeagueMatchIntelligenceReport["intelligenceConfidence"];
  availability: PremierLeagueMatchIntelligenceReport["availability"];
  matchups: PremierLeagueMatchIntelligenceReport["matchups"];
  killResistance: PremierLeagueMatchIntelligenceReport["killResistance"];
}): IntelligenceStance {
  if (report.intelligenceConfidence === "LOW" && report.availability.length === 0 && report.matchups.every((row) => row.level === "UNKNOWN")) {
    return "INSUFFICIENT_EVIDENCE";
  }
  const structural = report.availability.filter(
    (player) => player.absenceImpact === "STRUCTURAL" || player.absenceImpact === "HIGH"
  );
  const sterile = report.matchups.some((row) => row.sterilePossessionRisk);
  const homeKill = report.killResistance.find((row) => row.teamSlug === report.homeSlug);
  const awayKill = report.killResistance.find((row) => row.teamSlug !== report.homeSlug);
  if (structural.length > 0 || sterile) return "CHALLENGES_CHAMPION";
  if (
    homeKill?.killIndex != null &&
    awayKill?.resistanceIndex != null &&
    homeKill.killIndex >= 4 &&
    awayKill.resistanceIndex <= 2
  ) {
    return "SUPPORTS_CHAMPION";
  }
  if (report.intelligenceConfidence === "LOW") return "INSUFFICIENT_EVIDENCE";
  return "NEUTRAL";
}

export function deriveMatchIntelligence(input: MatchIntelligenceInput): PremierLeagueMatchIntelligenceReport {
  const cutoff = input.contextCutoffAt;
  const stage = contextStageFromLineup(input.contextSnapshot?.lineupOverall ?? null);
  const evidence = input.contextSnapshot?.evidence ?? [];
  const excludedAfterCutoffCount = evidence.filter((row) => !legallyAvailable(row.availableAt, cutoff)).length;
  const legalEvidence = evidence.filter((row) => legallyAvailable(row.availableAt, cutoff));
  const conflicts: SourceConflict[] = [];

  const availabilityByPlayer = new Map<string, string[]>();
  for (const row of legalEvidence) {
    if (row.kind !== "SQUAD_AVAILABILITY") continue;
    const mapped = mapAvailabilityState(row.availabilityStatus, row.payload ?? null);
    const list = availabilityByPlayer.get(row.entityId) ?? [];
    if (!list.includes(mapped)) list.push(mapped);
    availabilityByPlayer.set(row.entityId, list);
  }
  for (const [playerId, states] of availabilityByPlayer) {
    if (states.length > 1) {
      conflicts.push({
        subjectId: playerId,
        field: "availability",
        left: states[0],
        right: states[1],
        note: "Conflicting availability evidence is surfaced, not silently resolved.",
      });
    }
  }

  const declaredPlayers = [...(input.players ?? [])];
  const knownIds = new Set(declaredPlayers.map((profile) => profile.playerId));
  for (const row of legalEvidence) {
    if (row.kind !== "SQUAD_AVAILABILITY" || knownIds.has(row.entityId) || !row.teamSlug) continue;
    knownIds.add(row.entityId);
    declaredPlayers.push({
      playerId: row.entityId,
      teamSlug: row.teamSlug,
      displayName: row.entityId,
      spineRole: "OTHER",
    });
  }
  const players = declaredPlayers;
  const availability = players.map((profile) => {
    const rows = legalEvidence.filter((row) => row.entityId === profile.playerId);
    const row = rows[0] ?? null;
    const conflicted = (availabilityByPlayer.get(profile.playerId) ?? []).length > 1;
    const state = conflicted
      ? "UNKNOWN"
      : mapAvailabilityState(row?.availabilityStatus ?? null, row?.payload ?? null);
    const importance = buildPlayerImportance(profile);
    const rawLoss = bandImpact(
      importance.importanceScore == null || state === "UNKNOWN" ? null : importance.importanceScore
    );
    const replacement = assessReplacement(profile, state, rawLoss === "UNKNOWN" ? "UNKNOWN" : rawLoss);
    return assessAvailability({
      profile,
      importance,
      state: row || profile.synthetic ? state : state === "UNKNOWN" ? "UNKNOWN" : state,
      replacement,
      evidence: evidenceRef({
        evidenceId: row?.evidenceId ?? null,
        sourceName: row?.sourceName ?? (profile.synthetic ? "synthetic-test" : ""),
        lineupStatus: row?.lineupStatus ?? null,
        observedAt: row?.observedAt ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        availableAt: row?.availableAt ?? null,
        cutoffAt: cutoff,
        kind: row?.kind ?? "SQUAD_AVAILABILITY",
        payload: row?.payload ?? null,
        conflicted,
      }),
    });
  });

  const homeArchetype = input.archetypes?.find((row) => row.teamSlug === input.homeSlug);
  const awayArchetype = input.archetypes?.find((row) => row.teamSlug === input.awaySlug);
  const matchups = assessMatchups(homeArchetype, awayArchetype);
  const units = [...assessUnits(input.homeSlug, availability), ...assessUnits(input.awaySlug, availability)];
  const killResistance = [
    assessKillResistance(homeArchetype, availability, "favorite"),
    assessKillResistance(awayArchetype, availability, "underdog"),
  ];
  const opponentExperience = [
    assessOpponentExperience(homeArchetype, awayArchetype),
    assessOpponentExperience(awayArchetype, homeArchetype),
  ];
  const motivation = [
    assessMotivation(input.schedule?.find((row) => row.teamSlug === input.homeSlug), input.homeSlug),
    assessMotivation(input.schedule?.find((row) => row.teamSlug === input.awaySlug), input.awaySlug),
  ];

  const completeness =
    availability.length === 0 && !homeArchetype && !awayArchetype
      ? 0
      : Math.min(
          1,
          (availability.filter((row) => row.state !== "UNKNOWN").length +
            matchups.filter((row) => row.level !== "UNKNOWN").length) /
            Math.max(1, availability.length + matchups.length)
        );
  const intelligenceConfidence = completeness >= 0.7 ? "HIGH" : completeness >= 0.35 ? "MEDIUM" : "LOW";

  const unsigned: Omit<PremierLeagueMatchIntelligenceReport, "intelligenceId"> = {
    schemaVersion: MATCH_INTELLIGENCE_SCHEMA_VERSION,
    competition: "premier-league",
    season: input.season,
    fixtureId: input.fixtureId,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    contextStage: stage,
    contextCutoffAt: cutoff,
    generatedAt: input.generatedAt,
    temporalRule: INTELLIGENCE_TEMPORAL_RULE,
    productionForecastId: input.productionForecastId,
    productionModelVersion: "pl-live-v0.2.0",
    includedInChampionProbability: false,
    sourceAuthorization: input.sourceAuthorization ?? "NONE_CONFIGURED",
    lineupState: lineupStateFromStage(stage),
    availability,
    units,
    matchups,
    opponentExperience,
    killResistance,
    motivation,
    conflicts,
    excludedAfterCutoffCount,
    stance: "INSUFFICIENT_EVIDENCE",
    intelligenceConfidence,
    disclaimer: DISCLAIMER,
  };
  const stance = stanceOf(unsigned);
  const withStance = { ...unsigned, stance };
  const { generatedAt: _generatedAt, ...identity } = withStance;
  return {
    ...withStance,
    intelligenceId: `${MATCH_INTELLIGENCE_SCHEMA_VERSION}:${canonicalHash(identity)}`,
  };
}

export function emptyMatchIntelligence(input: {
  season: string;
  fixtureId: string;
  homeSlug: string;
  awaySlug: string;
  cutoffAt: string;
  generatedAt: string;
  productionForecastId: string | null;
}): PremierLeagueMatchIntelligenceReport {
  return deriveMatchIntelligence({
    season: input.season,
    fixtureId: input.fixtureId,
    homeSlug: input.homeSlug,
    awaySlug: input.awaySlug,
    kickoffAt: input.cutoffAt,
    contextCutoffAt: input.cutoffAt,
    generatedAt: input.generatedAt,
    productionForecastId: input.productionForecastId,
    contextSnapshot: null,
    sourceAuthorization: "NONE_CONFIGURED",
  });
}
