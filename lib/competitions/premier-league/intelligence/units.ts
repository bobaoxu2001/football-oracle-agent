import type { PlayerAvailabilityAssessment, UnitIntegrityAssessment, UnitKind } from "./types";

const UNIT_ROLES: Record<UnitKind, string[]> = {
  GOALKEEPER_CB_PAIR: ["GOALKEEPER", "CENTER_BACK"],
  CB_PAIR: ["CENTER_BACK"],
  LEFT_FLANK: ["OTHER"],
  RIGHT_FLANK: ["OTHER"],
  MIDFIELD_PIVOT: ["DEFENSIVE_MIDFIELDER"],
  MIDFIELD_TRIANGLE: ["DEFENSIVE_MIDFIELDER", "PROGRESSION_MIDFIELDER", "MAIN_CREATOR"],
  CREATOR_FINISHER: ["MAIN_CREATOR", "PRIMARY_FINISHER"],
  FRONT_THREE: ["PRIMARY_FINISHER", "MAIN_CREATOR"],
};

function unavailable(player: PlayerAvailabilityAssessment): boolean {
  return (
    player.state === "INJURED" ||
    player.state === "SUSPENDED" ||
    player.state === "UNAVAILABLE"
  );
}

export function assessUnits(
  teamSlug: string,
  players: PlayerAvailabilityAssessment[]
): UnitIntegrityAssessment[] {
  const team = players.filter((player) => player.teamSlug === teamSlug);
  if (team.length === 0) {
    return (Object.keys(UNIT_ROLES) as UnitKind[]).map((kind) => ({
      kind,
      teamSlug,
      state: "UNKNOWN",
      expectedStarters: 0,
      availableExpectedStarters: null,
      replacementCount: null,
      forcedRoleChanges: null,
      note: "No player evidence for this unit.",
    }));
  }
  return (Object.keys(UNIT_ROLES) as UnitKind[]).map((kind) => {
    const roles = UNIT_ROLES[kind];
    const members = team.filter((player) => roles.includes(player.spineRole));
    if (members.length === 0) {
      return {
        kind,
        teamSlug,
        state: "UNKNOWN",
        expectedStarters: 0,
        availableExpectedStarters: null,
        replacementCount: null,
        forcedRoleChanges: null,
        note: "Unit membership was not declared.",
      };
    }
    const missing = members.filter(unavailable);
    const unknown = members.some((player) => player.state === "UNKNOWN" || player.state === "DOUBTFUL");
    const structural = missing.some(
      (player) => player.absenceImpact === "STRUCTURAL" || player.replacement?.systemDisruption === "STRUCTURAL"
    );
    const forced = missing.filter((player) => player.replacement?.anotherKeyPlayerForcedRoleChange === true).length;
    let state: UnitIntegrityAssessment["state"] = "INTACT";
    if (structural || missing.length >= 2) state = "STRUCTURALLY_DISRUPTED";
    else if (missing.length === 1) state = "PARTIALLY_DISRUPTED";
    else if (members.some((player) => player.state === "EXPECTED_BENCH" || player.state === "LIMITED")) {
      state = "MINOR_ROTATION";
    }
    if (unknown && missing.length === 0 && state === "INTACT") state = "UNKNOWN";
    return {
      kind,
      teamSlug,
      state,
      expectedStarters: members.length,
      availableExpectedStarters: members.length - missing.length,
      replacementCount: missing.filter((player) => player.replacement?.replacementId).length,
      forcedRoleChanges: forced,
      note:
        state === "INTACT"
          ? "Declared unit members are available."
          : `${missing.length} declared member(s) unavailable.`,
    };
  });
}
