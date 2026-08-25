import type {
  AvailabilityContextChange,
  EntityAvailabilityContext,
  ForecastUsageChange,
  LineupContextChange,
  MatchContextDiff,
  MatchContextEvidence,
  MatchContextSnapshot,
  TeamLineupContext,
} from "./types";
import { assertMatchContextIntegrity, canonicalMatchContextJson } from "./snapshot";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sameLineupState(a: TeamLineupContext, b: TeamLineupContext): boolean {
  return canonicalMatchContextJson(a as unknown as never) ===
    canonicalMatchContextJson(b as unknown as never);
}

function sameAvailabilityState(
  a: EntityAvailabilityContext | null,
  b: EntityAvailabilityContext | null
): boolean {
  return canonicalMatchContextJson(a as unknown as never) ===
    canonicalMatchContextJson(b as unknown as never);
}

function assertSameFixture(from: MatchContextSnapshot, to: MatchContextSnapshot): void {
  const fields = ["competition", "season", "fixtureId", "homeSlug", "awaySlug"] as const;
  for (const field of fields) {
    if (from[field] !== to[field]) throw new Error(`cannot diff contexts with different ${field}`);
  }
  if (Date.parse(to.cutoffAt) < Date.parse(from.cutoffAt)) {
    throw new Error("to context cutoff must not precede from context cutoff");
  }
}

/** Directional audit diff. Changes are temporal observations, never causal claims. */
export function diffMatchContexts(
  from: MatchContextSnapshot,
  to: MatchContextSnapshot
): MatchContextDiff {
  assertMatchContextIntegrity(from);
  assertMatchContextIntegrity(to);
  assertSameFixture(from, to);

  const fromById = new Map(from.evidence.map((item) => [item.evidenceId, item]));
  const toById = new Map(to.evidence.map((item) => [item.evidenceId, item]));
  const addedEvidence: MatchContextEvidence[] = to.evidence.filter(
    (item) => !fromById.has(item.evidenceId)
  );
  const removedEvidence: MatchContextEvidence[] = from.evidence.filter(
    (item) => !toById.has(item.evidenceId)
  );
  const forecastUsageChanges: ForecastUsageChange[] = from.evidence.flatMap((item) => {
    const next = toById.get(item.evidenceId);
    if (!next || next.usedInForecast === item.usedInForecast) return [];
    return [{
      evidenceId: item.evidenceId,
      kind: item.kind,
      before: item.usedInForecast,
      after: next.usedInForecast,
    }];
  });
  const lineupChanges: LineupContextChange[] = [];
  for (const side of ["home", "away"] as const) {
    const before = from.lineup[side];
    const after = to.lineup[side];
    if (!sameLineupState(before, after)) {
      lineupChanges.push({ side, teamSlug: before.teamSlug, before, after });
    }
  }
  const availabilityChanges: AvailabilityContextChange[] = [];
  for (const side of ["home", "away"] as const) {
    const beforeTeam = from.availability[side];
    const afterTeam = to.availability[side];
    const beforeByEntity = new Map(beforeTeam.entities.map((item) => [item.entityId, item]));
    const afterByEntity = new Map(afterTeam.entities.map((item) => [item.entityId, item]));
    const entityIds = [...new Set([...beforeByEntity.keys(), ...afterByEntity.keys()])].sort();
    for (const entityId of entityIds) {
      const before = beforeByEntity.get(entityId) ?? null;
      const after = afterByEntity.get(entityId) ?? null;
      if (!sameAvailabilityState(before, after)) {
        availabilityChanges.push({
          side,
          teamSlug: beforeTeam.teamSlug,
          entityId,
          before,
          after,
        });
      }
    }
  }

  return deepFreeze(structuredClone({
    fixtureId: from.fixtureId,
    fromContextId: from.contextId,
    toContextId: to.contextId,
    fromCutoffAt: from.cutoffAt,
    toCutoffAt: to.cutoffAt,
    addedEvidence,
    removedEvidence,
    forecastUsageChanges,
    lineupChanges,
    availabilityChanges,
    kickoffChanged: from.kickoffAt === to.kickoffAt
      ? null
      : { before: from.kickoffAt, after: to.kickoffAt },
    forecastReferenceChanged: from.forecastSnapshotKey === to.forecastSnapshotKey
      ? null
      : { before: from.forecastSnapshotKey, after: to.forecastSnapshotKey },
    causalAttribution: "not-established" as const,
    causalNote:
      "Context changes were available by the later cutoff. This diff does not establish that any item caused a forecast change.",
  }));
}
