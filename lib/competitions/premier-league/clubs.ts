/**
 * Premier League club identities.
 *
 * A club is a durable organisation. Season membership is separate
 * (see seasons.ts). Aliases cover football-data.co.uk names, API-Football
 * names, and common English forms. Never resolve a club by display string alone.
 */

import type { Club } from "@/lib/identity/types";

function club(
  slug: string,
  name: string,
  shortName: string,
  officialNames: string[],
  aliases: string[],
  code?: string
): Club {
  return { slug, name, shortName, officialNames, aliases, code };
}

export const PREMIER_LEAGUE_CLUBS: Club[] = [
  club("arsenal", "Arsenal", "Arsenal", ["Arsenal"], ["gunners", "afc"], "ARS"),
  club("aston-villa", "Aston Villa", "Villa", ["Aston Villa"], ["villa"], "AVL"),
  club("bournemouth", "AFC Bournemouth", "Bournemouth", ["Bournemouth", "AFC Bournemouth"], ["cherries"], "BOU"),
  club("brentford", "Brentford", "Brentford", ["Brentford"], ["bees"], "BRE"),
  club("brighton", "Brighton & Hove Albion", "Brighton", ["Brighton", "Brighton & Hove Albion"], ["seagulls", "brighton and hove albion"], "BHA"),
  club("burnley", "Burnley", "Burnley", ["Burnley"], ["clarets"], "BUR"),
  club("chelsea", "Chelsea", "Chelsea", ["Chelsea"], ["cfc"], "CHE"),
  club("crystal-palace", "Crystal Palace", "Palace", ["Crystal Palace"], ["palace", "eagles"], "CRY"),
  club("everton", "Everton", "Everton", ["Everton"], ["toffees"], "EVE"),
  club("fulham", "Fulham", "Fulham", ["Fulham"], ["cottagers"], "FUL"),
  club("ipswich", "Ipswich Town", "Ipswich", ["Ipswich", "Ipswich Town"], ["tractor boys"], "IPS"),
  club("leeds", "Leeds United", "Leeds", ["Leeds", "Leeds United"], ["whites"], "LEE"),
  club("leicester", "Leicester City", "Leicester", ["Leicester", "Leicester City"], ["foxes"], "LEI"),
  club("liverpool", "Liverpool", "Liverpool", ["Liverpool"], ["lfc"], "LIV"),
  club("luton", "Luton Town", "Luton", ["Luton", "Luton Town"], ["hatters"], "LUT"),
  club("manchester-city", "Manchester City", "Man City", ["Man City", "Manchester City"], ["man city", "mcfc"], "MCI"),
  club("manchester-united", "Manchester United", "Man United", ["Man United", "Manchester United"], ["man utd", "man united", "mufc", "red devils"], "MUN"),
  club("newcastle", "Newcastle United", "Newcastle", ["Newcastle", "Newcastle United"], ["magpies", "toon"], "NEW"),
  club("nottingham-forest", "Nottingham Forest", "Forest", ["Nott'm Forest", "Nottingham Forest"], ["forest", "nottm forest", "notts forest"], "NFO"),
  club("sheffield-united", "Sheffield United", "Sheff Utd", ["Sheffield United", "Sheffield Utd"], ["blades", "sheff utd"], "SHU"),
  club("southampton", "Southampton", "Southampton", ["Southampton"], ["saints"], "SOU"),
  club("tottenham", "Tottenham Hotspur", "Spurs", ["Tottenham", "Tottenham Hotspur"], ["spurs", "hotspur"], "TOT"),
  club("west-ham", "West Ham United", "West Ham", ["West Ham", "West Ham United"], ["hammers", "irons"], "WHU"),
  club("wolves", "Wolverhampton Wanderers", "Wolves", ["Wolves", "Wolverhampton Wanderers"], ["wanderers"], "WOL"),
  club("sunderland", "Sunderland", "Sunderland", ["Sunderland"], ["black cats"], "SUN"),
  club("norwich", "Norwich City", "Norwich", ["Norwich", "Norwich City"], ["canaries"], "NOR"),
  club("watford", "Watford", "Watford", ["Watford"], ["hornets"], "WAT"),
  club("west-brom", "West Bromwich Albion", "West Brom", ["West Brom", "West Bromwich Albion"], ["baggies", "albion"], "WBA"),
  club("cardiff", "Cardiff City", "Cardiff", ["Cardiff", "Cardiff City"], ["bluebirds"], "CAR"),
  club("huddersfield", "Huddersfield Town", "Huddersfield", ["Huddersfield", "Huddersfield Town"], ["terriers"], "HUD"),
  club("swansea", "Swansea City", "Swansea", ["Swansea", "Swansea City"], ["swans"], "SWA"),
  club("stoke", "Stoke City", "Stoke", ["Stoke", "Stoke City"], ["potters"], "STK"),
  club("hull", "Hull City", "Hull", ["Hull", "Hull City"], ["tigers"], "HUL"),
  club("middlesbrough", "Middlesbrough", "Boro", ["Middlesbrough"], ["boro"], "MID"),
  club("sheffield-wednesday", "Sheffield Wednesday", "Sheff Wed", ["Sheffield Weds", "Sheffield Wednesday"], ["owls", "sheff wed"], "SHW"),
  club("blackburn", "Blackburn Rovers", "Blackburn", ["Blackburn", "Blackburn Rovers"], ["rovers"], "BLB"),
  club("bristol-city", "Bristol City", "Bristol City", ["Bristol City"], ["robins"], "BRC"),
  club("derby", "Derby County", "Derby", ["Derby", "Derby County"], ["rams"], "DER"),
  club("preston", "Preston North End", "Preston", ["Preston", "Preston North End"], ["pne", "lilywhites"], "PNE"),
  club("qpr", "Queens Park Rangers", "QPR", ["QPR", "Queens Park Rangers"], [], "QPR"),
  club("millwall", "Millwall", "Millwall", ["Millwall"], ["lions"], "MIL"),
  club("coventry", "Coventry City", "Coventry", ["Coventry", "Coventry City"], ["sky blues"], "COV"),
  club("birmingham", "Birmingham City", "Birmingham", ["Birmingham", "Birmingham City"], [], "BIR"),
  club("plymouth", "Plymouth Argyle", "Plymouth", ["Plymouth", "Plymouth Argyle"], ["argyle", "pilgrims"], "PLY"),
  club("oxford", "Oxford United", "Oxford", ["Oxford", "Oxford United"], [], "OXF"),
  club("portsmouth", "Portsmouth", "Portsmouth", ["Portsmouth"], ["pompey"], "POR"),
  club("charlton", "Charlton Athletic", "Charlton", ["Charlton", "Charlton Athletic"], ["addicks"], "CHA"),
  club("wigan", "Wigan Athletic", "Wigan", ["Wigan", "Wigan Athletic"], ["lattics"], "WIG"),
  club("barnsley", "Barnsley", "Barnsley", ["Barnsley"], ["tykes"], "BAR"),
  club("reading", "Reading", "Reading", ["Reading"], ["royals"], "REA"),
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_SLUG = new Map(PREMIER_LEAGUE_CLUBS.map((c) => [c.slug, c]));
const BY_ALIAS = new Map<string, string>();

function indexName(name: string, slug: string) {
  const n = norm(name);
  if (n && !BY_ALIAS.has(n)) BY_ALIAS.set(n, slug);
}

for (const c of PREMIER_LEAGUE_CLUBS) {
  indexName(c.slug.replace(/-/g, " "), c.slug);
  indexName(c.name, c.slug);
  indexName(c.shortName, c.slug);
  if (c.code) indexName(c.code, c.slug);
  for (const n of c.officialNames) indexName(n, c.slug);
  for (const n of c.aliases) indexName(n, c.slug);
}

export function getClub(slug: string): Club {
  const c = BY_SLUG.get(slug);
  if (!c) throw new Error(`Unknown Premier League club slug: ${slug}`);
  return c;
}

export function findClub(slug: string): Club | undefined {
  return BY_SLUG.get(slug);
}

export function resolveClubSlug(raw: string): string | null {
  const n = norm(raw);
  if (!n) return null;
  return BY_ALIAS.get(n) ?? null;
}

export function resolveAllClubSlugs(query: string): string[] {
  const q = norm(query);
  const hits: { slug: string; index: number }[] = [];
  const seen = new Set<string>();
  const candidates = [...BY_ALIAS.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, slug] of candidates) {
    if (seen.has(slug)) continue;
    const re = new RegExp(`(?:^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
    const m = q.match(re);
    if (m && m.index !== undefined) {
      seen.add(slug);
      hits.push({ slug, index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map((h) => h.slug);
}

export function listClubSlugs(): string[] {
  return PREMIER_LEAGUE_CLUBS.map((c) => c.slug);
}
