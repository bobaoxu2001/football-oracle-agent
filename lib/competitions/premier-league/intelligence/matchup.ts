import { TACTICAL_MATCHUP_HEURISTIC_VERSION } from "./types";
import type {
  DeclaredTeamArchetype,
  MatchupDimension,
  MatchupLevel,
  OpponentArchetype,
} from "./types";

function rank(level: MatchupLevel | null | undefined): number | null {
  if (level === "HIGH") return 3;
  if (level === "MODERATE") return 2;
  if (level === "LOW") return 1;
  return null;
}

function levelFromDelta(delta: number | null): MatchupLevel {
  if (delta == null) return "UNKNOWN";
  const abs = Math.abs(delta);
  if (abs >= 2) return "HIGH";
  if (abs >= 1) return "MODERATE";
  return "LOW";
}

function favors(delta: number | null): MatchupDimension["favors"] {
  if (delta == null) return "unknown";
  if (delta > 0) return "home";
  if (delta < 0) return "away";
  return "neither";
}

function dimension(
  id: MatchupDimension["id"],
  home: number | null,
  away: number | null,
  note: string,
  extra: Partial<Pick<MatchupDimension, "sterilePossessionRisk" | "firstGoalLeverage">> = {}
): MatchupDimension {
  const delta = home != null && away != null ? home - away : null;
  return {
    id,
    level: levelFromDelta(delta),
    favors: favors(delta),
    sterilePossessionRisk: extra.sterilePossessionRisk ?? false,
    firstGoalLeverage: extra.firstGoalLeverage ?? null,
    note: `${note} Heuristic ${TACTICAL_MATCHUP_HEURISTIC_VERSION}; not a probability.`,
  };
}

export function primaryArchetype(team: DeclaredTeamArchetype | undefined): OpponentArchetype | null {
  return team?.archetypes[0] ?? null;
}

export function assessMatchups(
  home: DeclaredTeamArchetype | undefined,
  away: DeclaredTeamArchetype | undefined
): MatchupDimension[] {
  if (!home && !away) {
    return [
      dimension("HIGH_LINE_VS_PACE", null, null, "No declared tactical archetypes."),
      dimension("PRESS_VS_BUILD_UP", null, null, "No declared tactical archetypes."),
      dimension("LOW_BLOCK_VS_CHANCE_CREATION", null, null, "No declared tactical archetypes."),
      dimension("WIDE_LEFT", null, null, "No declared tactical archetypes."),
      dimension("WIDE_RIGHT", null, null, "No declared tactical archetypes."),
      dimension("CENTRAL_MIDFIELD", null, null, "No declared tactical archetypes."),
      dimension("AERIAL_SET_PIECE", null, null, "No declared tactical archetypes."),
      dimension("TRANSITION", null, null, "No declared tactical archetypes."),
      dimension("FINISHER_VS_DEFENCE", null, null, "No declared tactical archetypes."),
      dimension("GAME_STATE", null, null, "No declared tactical archetypes.", {
        firstGoalLeverage: "UNKNOWN",
      }),
    ];
  }
  const highLineVsPace = dimension(
    "HIGH_LINE_VS_PACE",
    rank(home?.recoverySpeed ?? null),
    rank(away?.transitionAttack ?? null),
    "Home recovery/line height versus away pace in behind. Positive favors the defending home side."
  );
  const pressVsBuild = dimension(
    "PRESS_VS_BUILD_UP",
    rank(home?.pressIntensity ?? null),
    rank(away?.pressResistance ?? null),
    "Home press intensity versus away press resistance."
  );
  const sterile =
    home?.sterilePossessionRisk === true &&
    (away?.archetypes.includes("LOW_BLOCK") || away?.compactness === "HIGH");
  const lowBlock = dimension(
    "LOW_BLOCK_VS_CHANCE_CREATION",
    rank(away?.compactness ?? null),
    rank(home?.chanceCreation ?? null),
    "Away compactness versus home chance creation.",
    { sterilePossessionRisk: Boolean(sterile) }
  );
  const firstGoal: MatchupDimension["firstGoalLeverage"] =
    home?.transitionAttack === "HIGH" && away?.restDefence === "LOW"
      ? "HOME_OPENS"
      : away?.transitionAttack === "HIGH" && home?.restDefence === "LOW"
        ? "AWAY_OPENS"
        : away?.compactness === "HIGH"
          ? "COMPACT_SURVIVES"
          : "UNKNOWN";
  return [
    highLineVsPace,
    pressVsBuild,
    lowBlock,
    dimension("WIDE_LEFT", rank(home?.wideThreatLeft ?? null), rank(away?.wideThreatLeft ?? null), "Left-flank threat mismatch."),
    dimension("WIDE_RIGHT", rank(home?.wideThreatRight ?? null), rank(away?.wideThreatRight ?? null), "Right-flank threat mismatch."),
    dimension("CENTRAL_MIDFIELD", rank(home?.centralControl ?? null), rank(away?.centralControl ?? null), "Central control mismatch."),
    dimension(
      "AERIAL_SET_PIECE",
      rank(home?.setPieceDelivery ?? home?.aerialAttack ?? null),
      rank(away?.aerialDefence ?? null),
      "Home set-piece/aerial attack versus away aerial defence."
    ),
    dimension(
      "TRANSITION",
      rank(home?.transitionAttack ?? null),
      rank(away?.restDefence ?? null),
      "Home transition attack versus away rest defence."
    ),
    dimension(
      "FINISHER_VS_DEFENCE",
      rank(home?.boxThreat ?? home?.finishing ?? null),
      rank(away?.compactness ?? away?.aerialDefence ?? null),
      "Home box threat versus away defensive structure."
    ),
    dimension("GAME_STATE", rank(home?.transitionAttack ?? null), rank(away?.compactness ?? null), "First-goal leverage is descriptive, not a scoreline probability.", {
      firstGoalLeverage: firstGoal,
    }),
  ];
}
