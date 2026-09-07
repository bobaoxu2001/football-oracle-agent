import { occupiesSpine } from "./importance";
import type {
  AbsenceImpact,
  DeclaredPlayerProfile,
  IntelligenceAvailabilityState,
  PlayerAvailabilityAssessment,
  PlayerImportanceProfile,
  ReplacementCompatibilityAssessment,
} from "./types";
import type { IntelligenceEvidenceRef } from "./types";

const SEVERITY: Record<IntelligenceAvailabilityState, number | null> = {
  AVAILABLE: 0,
  EXPECTED_START: 0,
  EXPECTED_BENCH: 0.18,
  DOUBTFUL: 0.45,
  LIMITED: 0.55,
  SUSPENDED: 0.92,
  INJURED: 1,
  UNAVAILABLE: 1,
  UNKNOWN: null,
};

export function mapAvailabilityState(
  contextStatus: string | null,
  payload?: Record<string, unknown> | null
): IntelligenceAvailabilityState {
  if (payload && typeof payload.availabilityState === "string") {
    const raw = payload.availabilityState;
    if (
      raw === "AVAILABLE" ||
      raw === "EXPECTED_START" ||
      raw === "EXPECTED_BENCH" ||
      raw === "DOUBTFUL" ||
      raw === "LIMITED" ||
      raw === "SUSPENDED" ||
      raw === "INJURED" ||
      raw === "UNAVAILABLE" ||
      raw === "UNKNOWN"
    ) {
      return raw;
    }
  }
  switch (contextStatus) {
    case "AVAILABLE":
      return "AVAILABLE";
    case "EXPECTED_AVAILABLE":
      return "EXPECTED_START";
    case "DOUBTFUL":
      return "DOUBTFUL";
    case "OUT":
      return "UNAVAILABLE";
    case "SUSPENDED":
      return "SUSPENDED";
    default:
      return "UNKNOWN";
  }
}

export function bandImpact(score: number | null): AbsenceImpact {
  if (score == null || !Number.isFinite(score)) return "UNKNOWN";
  if (score < 0.08) return "NEGLIGIBLE";
  if (score < 0.2) return "LOW";
  if (score < 0.4) return "MODERATE";
  if (score < 0.65) return "HIGH";
  return "STRUCTURAL";
}

export function absenceImpactScore(input: {
  importance: number | null;
  state: IntelligenceAvailabilityState;
  replacementGap: number | null;
  spine: boolean;
}): number | null {
  const severity = SEVERITY[input.state];
  if (severity == null) return null;
  if (input.state === "AVAILABLE" || input.state === "EXPECTED_START") return 0;
  if (input.importance == null) return null;
  const gap = input.replacementGap ?? 0.5;
  const spine = input.spine ? 1.25 : 1;
  return Math.min(1, input.importance * severity * gap * spine);
}

export function assessAvailability(input: {
  profile: DeclaredPlayerProfile;
  importance: PlayerImportanceProfile;
  state: IntelligenceAvailabilityState;
  replacement: ReplacementCompatibilityAssessment | null;
  evidence: IntelligenceEvidenceRef;
}): PlayerAvailabilityAssessment {
  const spine = occupiesSpine(input.profile.spineRole);
  const impactScore = absenceImpactScore({
    importance: input.importance.importanceScore,
    state: input.state,
    replacementGap: input.importance.replacementGap,
    spine,
  });
  return {
    playerId: input.profile.playerId,
    teamSlug: input.profile.teamSlug,
    displayName: input.profile.displayName,
    state: input.state,
    spineRole: input.profile.spineRole,
    occupiesSpine: spine,
    importance: input.importance,
    absenceImpact: bandImpact(impactScore),
    impactScore,
    replacement: input.replacement,
    evidence: input.evidence,
  };
}
