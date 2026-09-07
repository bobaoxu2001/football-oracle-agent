import {
  PLAYER_IMPORTANCE_HEURISTIC_VERSION,
  type ConfidenceBand,
  type DeclaredPlayerProfile,
  type PlayerImportanceProfile,
  type SpineRole,
} from "./types";

const WEIGHTS = {
  minutesShare: 0.22,
  startShare: 0.14,
  attackingRole: 0.1,
  creativeRole: 0.09,
  progressionRole: 0.1,
  defensiveRole: 0.11,
  setPieceRole: 0.06,
  roleScarcity: 0.08,
  replacementGap: 0.1,
} as const;

const CAVEAT =
  "Heuristic team-dependence score, not fame, transfer value, or a causal injury effect. Missing components are omitted, never fabricated.";

function finiteUnit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function completeness(profile: DeclaredPlayerProfile): number {
  const keys = Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>;
  const present = keys.filter((key) => finiteUnit(profile[key]) != null).length;
  return present / keys.length;
}

function confidenceOf(completeness: number): ConfidenceBand {
  if (completeness >= 0.7) return "HIGH";
  if (completeness >= 0.4) return "MEDIUM";
  return "LOW";
}

export function buildPlayerImportance(profile: DeclaredPlayerProfile): PlayerImportanceProfile {
  const components: { label: string; value: number }[] = [];
  let weighted = 0;
  let weightSum = 0;
  (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).forEach((key) => {
    const value = finiteUnit(profile[key]);
    if (value == null) return;
    components.push({ label: key, value });
    weighted += WEIGHTS[key] * value;
    weightSum += WEIGHTS[key];
  });
  const evidenceCompleteness = completeness(profile);
  const importanceScore =
    weightSum > 0 && evidenceCompleteness > 0 ? Math.min(1, Math.max(0, weighted / weightSum)) : null;
  return {
    playerId: profile.playerId,
    teamSlug: profile.teamSlug,
    displayName: profile.displayName,
    spineRole: profile.spineRole,
    minutesShare: finiteUnit(profile.minutesShare),
    startShare: finiteUnit(profile.startShare),
    attackingRole: finiteUnit(profile.attackingRole),
    creativeRole: finiteUnit(profile.creativeRole),
    progressionRole: finiteUnit(profile.progressionRole),
    defensiveRole: finiteUnit(profile.defensiveRole),
    setPieceRole: finiteUnit(profile.setPieceRole),
    roleScarcity: finiteUnit(profile.roleScarcity),
    replacementGap: finiteUnit(profile.replacementGap),
    importanceScore,
    evidenceCompleteness,
    confidence: confidenceOf(evidenceCompleteness),
    heuristicVersion: PLAYER_IMPORTANCE_HEURISTIC_VERSION,
    componentsUsed: components.map((row) => row.label),
    caveat: CAVEAT,
  };
}

export function occupiesSpine(role: SpineRole): boolean {
  return role !== "OTHER";
}
