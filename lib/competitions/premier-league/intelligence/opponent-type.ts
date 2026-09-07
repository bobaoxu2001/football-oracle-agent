import { primaryArchetype } from "./matchup";
import type { DeclaredTeamArchetype, OpponentTypeExperience } from "./types";

export function assessOpponentExperience(
  team: DeclaredTeamArchetype | undefined,
  opponent: DeclaredTeamArchetype | undefined
): OpponentTypeExperience {
  const opponentArchetype = primaryArchetype(opponent);
  if (!team || !opponentArchetype) {
    return {
      teamSlug: team?.teamSlug ?? "unknown",
      opponentArchetype,
      observations: null,
      solvedTacticalProblem: null,
      note: "Opponent-type experience requires a declared opponent archetype and historical sample. Win/loss alone is not used.",
      evidenceCompleteness: 0,
    };
  }
  const prior = team.priorVsArchetype?.[opponentArchetype];
  if (!prior) {
    return {
      teamSlug: team.teamSlug,
      opponentArchetype,
      observations: null,
      solvedTacticalProblem: null,
      note: `No declared sample against ${opponentArchetype}.`,
      evidenceCompleteness: 0.2,
    };
  }
  return {
    teamSlug: team.teamSlug,
    opponentArchetype,
    observations: prior.observations,
    solvedTacticalProblem: prior.solved,
    note: prior.solved
      ? `Declared sample suggests the tactical problem ${opponentArchetype} was previously solved.`
      : `Declared sample does not show the tactical problem ${opponentArchetype} was solved.`,
    evidenceCompleteness: Math.min(1, prior.observations / 6),
  };
}
