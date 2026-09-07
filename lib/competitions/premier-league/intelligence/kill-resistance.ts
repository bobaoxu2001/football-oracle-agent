import { KILL_RESISTANCE_HEURISTIC_VERSION } from "./types";
import type {
  DeclaredTeamArchetype,
  KillResistanceAssessment,
  MatchupLevel,
  PlayerAvailabilityAssessment,
} from "./types";

function score(level: MatchupLevel | null | undefined): number | null {
  if (level === "HIGH") return 5;
  if (level === "MODERATE") return 3;
  if (level === "LOW") return 1;
  return null;
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function spinePenalty(players: PlayerAvailabilityAssessment[], role: string): number {
  const hit = players.find(
    (player) =>
      player.spineRole === role &&
      (player.state === "INJURED" || player.state === "SUSPENDED" || player.state === "UNAVAILABLE")
  );
  if (!hit) return 0;
  if (hit.absenceImpact === "STRUCTURAL" || hit.absenceImpact === "HIGH") return 1.5;
  return 0.7;
}

export function assessKillResistance(
  team: DeclaredTeamArchetype | undefined,
  players: PlayerAvailabilityAssessment[],
  role: KillResistanceAssessment["role"]
): KillResistanceAssessment {
  const teamPlayers = players.filter((player) => player.teamSlug === team?.teamSlug);
  const killParts = [
    { label: "boxThreat", value: score(team?.boxThreat ?? null) },
    { label: "finishing", value: score(team?.finishing ?? null) },
    { label: "chanceCreation", value: score(team?.chanceCreation ?? null) },
    { label: "transitionAttack", value: score(team?.transitionAttack ?? null) },
    { label: "setPieceDelivery", value: score(team?.setPieceDelivery ?? null) },
  ];
  const resistParts = [
    { label: "compactness", value: score(team?.compactness ?? null) },
    { label: "aerialDefence", value: score(team?.aerialDefence ?? null) },
    { label: "restDefence", value: score(team?.restDefence ?? null) },
    { label: "pressResistance", value: score(team?.pressResistance ?? null) },
  ];
  const killPenalty =
    spinePenalty(teamPlayers, "PRIMARY_FINISHER") + spinePenalty(teamPlayers, "MAIN_CREATOR");
  const resistPenalty =
    spinePenalty(teamPlayers, "GOALKEEPER") +
    spinePenalty(teamPlayers, "CENTER_BACK") +
    spinePenalty(teamPlayers, "DEFENSIVE_MIDFIELDER");
  const killRaw = mean(killParts.map((part) => part.value));
  const resistRaw = mean(resistParts.map((part) => part.value));
  return {
    teamSlug: team?.teamSlug ?? "unknown",
    role,
    killIndex: killRaw == null ? null : Math.max(0, Math.min(5, killRaw - killPenalty)),
    resistanceIndex: resistRaw == null ? null : Math.max(0, Math.min(5, resistRaw - resistPenalty)),
    components: [...killParts, ...resistParts],
    heuristicVersion: KILL_RESISTANCE_HEURISTIC_VERSION,
    caveat:
      "Descriptive 0–5 heuristic. Not a 1X2 adjustment and not a production probability.",
  };
}
