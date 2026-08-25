import type { CompetitionSeason, SeasonStatus } from "@/lib/identity/types";

/** Calendar-derived status prevents a stale ingest-time label from becoming the runtime truth. */
export function seasonStatusAt(
  season: Pick<CompetitionSeason, "startDate" | "endDate">,
  now = new Date()
): SeasonStatus {
  const day = now.toISOString().slice(0, 10);
  if (day < season.startDate) return "upcoming";
  if (day > season.endDate) return "completed";
  return "in_progress";
}

export function withEffectiveSeasonStatus<T extends CompetitionSeason>(season: T, now = new Date()): T {
  return { ...season, status: seasonStatusAt(season, now) };
}
