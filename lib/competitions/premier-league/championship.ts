/**
 * Championship (E1) feeder ratings — used only at Premier League season
 * initialization for clubs that were not in last season's PL field.
 *
 * Not a live Championship model. Coefficients are placeholders.
 * 2026-27 promoted clubs are NOT invented here.
 */

import processed from "@/data/processed/premier-league/fixtures.json";
import {
  DEFAULT_CLUB_ELO,
  baseK,
  expectedScore,
  gMult,
} from "@/lib/prediction-engine/rating-core";

interface RawRow {
  id: string;
  season: string;
  date: string;
  homeSlug: string;
  awaySlug: string;
  homeGoals: number | null;
  awayGoals: number | null;
  status: string;
  division?: string;
}

let _e1: RawRow[] | null = null;

export function loadChampionshipResults(): RawRow[] {
  if (_e1) return _e1;
  const rows = ((processed as { fixtures?: RawRow[] }).fixtures ?? []).filter(
    (f) => f.division === "E1" && f.status === "completed" && f.homeGoals !== null && f.awayGoals !== null
  );
  _e1 = rows;
  return rows;
}

/** Walk-forward Championship Elo using only results with date < asOf. */
export function championshipRatingsAsOf(asOf: string): Record<string, number> {
  const ratings: Record<string, number> = {};
  const kBase = baseK("championship");
  const ordered = loadChampionshipResults()
    .filter((f) => f.date < asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const f of ordered) {
    const ra = ratings[f.homeSlug] ?? DEFAULT_CLUB_ELO;
    const rb = ratings[f.awaySlug] ?? DEFAULT_CLUB_ELO;
    const hg = f.homeGoals as number;
    const ag = f.awayGoals as number;
    const exp = expectedScore(ra, rb, 65);
    const sc = hg > ag ? 1 : hg < ag ? 0 : 0.5;
    const k = kBase * gMult(hg - ag);
    ratings[f.homeSlug] = ra + k * (sc - exp);
    ratings[f.awaySlug] = rb - k * (sc - exp);
  }
  return ratings;
}
