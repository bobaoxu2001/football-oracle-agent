import { bandImpact } from "./availability";
import type {
  AbsenceImpact,
  DeclaredPlayerProfile,
  IntelligenceAvailabilityState,
  ReplacementCompatibilityAssessment,
} from "./types";

function bool(value: boolean | null | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function assessReplacement(
  profile: DeclaredPlayerProfile,
  state: IntelligenceAvailabilityState,
  rawPlayerLoss: AbsenceImpact
): ReplacementCompatibilityAssessment | null {
  if (state === "AVAILABLE" || state === "EXPECTED_START" || state === "UNKNOWN") return null;
  const flags = [
    profile.possessionStructureChanges,
    profile.pressingStructureChanges,
    profile.defensiveCoverageChanges,
    profile.transitionThreatChanges,
    profile.setPieceHierarchyChanges,
    profile.anotherKeyPlayerForcedRoleChange,
    profile.formationCanRemain === false,
  ];
  const known = flags.filter((value) => typeof value === "boolean");
  const disruptionCount = known.filter(Boolean).length;
  let systemScore = 0;
  if (known.length === 0) systemScore = Number.NaN;
  else if (profile.formationCanRemain === false || profile.anotherKeyPlayerForcedRoleChange === true) {
    systemScore = 0.8;
  } else {
    systemScore = Math.min(1, disruptionCount / 5);
  }
  const systemDisruption: AbsenceImpact = Number.isFinite(systemScore)
    ? bandImpact(systemScore)
    : "UNKNOWN";
  return {
    starterId: profile.playerId,
    replacementId: profile.replacementId ?? null,
    replacementName: profile.replacementName ?? null,
    samePositionalArchetype: bool(profile.samePositionalArchetype),
    formationCanRemain: bool(profile.formationCanRemain),
    possessionStructureChanges: bool(profile.possessionStructureChanges),
    pressingStructureChanges: bool(profile.pressingStructureChanges),
    defensiveCoverageChanges: bool(profile.defensiveCoverageChanges),
    transitionThreatChanges: bool(profile.transitionThreatChanges),
    setPieceHierarchyChanges: bool(profile.setPieceHierarchyChanges),
    anotherKeyPlayerForcedRoleChange: bool(profile.anotherKeyPlayerForcedRoleChange),
    rawPlayerLoss,
    systemDisruption,
    note:
      systemDisruption === "STRUCTURAL" || systemDisruption === "HIGH"
        ? "Replacement may change the system, not only player quality."
        : profile.samePositionalArchetype === true && profile.formationCanRemain === true
          ? "Replacement can preserve structure; this is a quality gap, not automatic collapse."
          : "Replacement compatibility is incomplete.",
  };
}
