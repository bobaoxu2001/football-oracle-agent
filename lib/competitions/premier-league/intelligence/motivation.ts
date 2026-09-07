import type { DeclaredScheduleFacts, MotivationScheduleContext } from "./types";

export function assessMotivation(facts: DeclaredScheduleFacts | undefined, teamSlug: string): MotivationScheduleContext {
  if (!facts) {
    return {
      teamSlug,
      titleRace: null,
      europeanQualificationRace: null,
      relegationRisk: null,
      daysRest: null,
      fixtureCongestion: null,
      midweekEuropean: null,
      derby: null,
      likelyRotation: null,
      note: "No declared schedule facts. Psychological effort is not inferred.",
      evidenceCompleteness: 0,
    };
  }
  const known = [
    facts.titleRace,
    facts.europeanQualificationRace,
    facts.relegationRisk,
    facts.daysRest,
    facts.fixtureCongestion,
    facts.midweekEuropean,
    facts.derby,
    facts.rotatedInComparableSpot,
  ].filter((value) => value != null).length;
  const likelyRotation =
    facts.rotatedInComparableSpot === true ||
    (facts.midweekEuropean === true && facts.fixtureCongestion === true)
      ? true
      : facts.rotatedInComparableSpot === false
        ? false
        : null;
  return {
    teamSlug,
    titleRace: facts.titleRace ?? null,
    europeanQualificationRace: facts.europeanQualificationRace ?? null,
    relegationRisk: facts.relegationRisk ?? null,
    daysRest: typeof facts.daysRest === "number" ? facts.daysRest : null,
    fixtureCongestion: facts.fixtureCongestion ?? null,
    midweekEuropean: facts.midweekEuropean ?? null,
    derby: facts.derby ?? null,
    likelyRotation,
    note: likelyRotation
      ? "Comparable scheduling spots previously rotated; this is structural, not 'trying less'."
      : "Only observable incentives are recorded. Desire to win is not inferred.",
    evidenceCompleteness: known / 8,
  };
}
