/**
 * Premier League table ranking.
 *
 * Official order: points → goal difference → goals scored.
 * H2H is NOT a Premier League tie-breaker.
 */

import { PREMIER_LEAGUE_CONFIG } from "./config";
import { getClub } from "./clubs";

export interface TableRow {
  slug: string;
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  position: number;
}

export interface PlayedResult {
  homeSlug: string;
  awaySlug: string;
  homeGoals: number;
  awayGoals: number;
}

const RULES = PREMIER_LEAGUE_CONFIG.standingsRules;

export function emptyRow(slug: string): TableRow {
  const name = (() => {
    try {
      return getClub(slug).name;
    } catch {
      return slug;
    }
  })();
  return {
    slug,
    name,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    gf: 0,
    ga: 0,
    gd: 0,
    points: 0,
    position: 0,
  };
}

export function applyResult(table: Record<string, TableRow>, r: PlayedResult): void {
  if (!table[r.homeSlug]) table[r.homeSlug] = emptyRow(r.homeSlug);
  if (!table[r.awaySlug]) table[r.awaySlug] = emptyRow(r.awaySlug);
  const h = table[r.homeSlug];
  const a = table[r.awaySlug];
  h.played += 1;
  a.played += 1;
  h.gf += r.homeGoals;
  h.ga += r.awayGoals;
  a.gf += r.awayGoals;
  a.ga += r.homeGoals;
  h.gd = h.gf - h.ga;
  a.gd = a.gf - a.ga;
  if (r.homeGoals > r.awayGoals) {
    h.won += 1;
    a.lost += 1;
    h.points += RULES.pointsForWin;
    a.points += RULES.pointsForLoss;
  } else if (r.homeGoals < r.awayGoals) {
    a.won += 1;
    h.lost += 1;
    a.points += RULES.pointsForWin;
    h.points += RULES.pointsForLoss;
  } else {
    h.drawn += 1;
    a.drawn += 1;
    h.points += RULES.pointsForDraw;
    a.points += RULES.pointsForDraw;
  }
}

/** Compare two rows using Premier League tie-breakers (points, GD, GF, then slug). */
export function comparePremierLeagueRows(x: TableRow, y: TableRow): number {
  return y.points - x.points || y.gd - x.gd || y.gf - x.gf || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0);
}

export function rankTable(rows: TableRow[]): TableRow[] {
  const ranked = [...rows].sort(comparePremierLeagueRows);
  return ranked.map((r, i) => ({ ...r, position: i + 1 }));
}

export function tableFromResults(clubSlugs: string[], results: PlayedResult[]): TableRow[] {
  const table: Record<string, TableRow> = {};
  for (const slug of clubSlugs) table[slug] = emptyRow(slug);
  for (const r of results) applyResult(table, r);
  return rankTable(Object.values(table));
}
