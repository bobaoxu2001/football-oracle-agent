/**
 * Download Premier League (E0) + Championship (E1) results from
 * football-data.co.uk and write a processed fixtures JSON.
 *
 * Championship rows are kept only so promoted clubs can carry a prior;
 * they are tagged division=E1 and excluded from the PL backtest scorer.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveClubSlug as resolveSlug } from "../lib/competitions/premier-league/clubs";
import { parseFootballDataDate as parseDate } from "../lib/competitions/premier-league/data";

const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "data/raw/premier-league");
const OUT = path.join(ROOT, "data/processed/premier-league/fixtures.json");

const SEASONS = ["1819", "1920", "2021", "2122", "2223", "2324", "2425", "2526"];
const DIVISIONS = ["E0", "E1"] as const;

function seasonLabel(code: string): string {
  const a = 2000 + Number(code.slice(0, 2));
  const b = 2000 + Number(code.slice(2, 4));
  return `${a}-${String(b).slice(2)}`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function fetchCsv(season: string, div: string): Promise<string> {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

type Row = {
  id: string;
  season: string;
  date: string;
  homeSlug: string;
  awaySlug: string;
  homeGoals: number | null;
  awayGoals: number | null;
  status: "completed" | "postponed";
  division: string;
};

function ingest(text: string, seasonCode: string, div: string): Row[] {
  const season = seasonLabel(seasonCode);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const iDate = idx("Date");
  const iHome = idx("HomeTeam");
  const iAway = idx("AwayTeam");
  const iFTHG = idx("FTHG");
  const iFTAG = idx("FTAG");
  if (iDate < 0 || iHome < 0 || iAway < 0 || iFTHG < 0 || iFTAG < 0) {
    throw new Error(`Unexpected header for ${season} ${div}: ${header.slice(0, 12).join(",")}`);
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  let skippedUnknown = 0;
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const date = parseDate(cols[iDate] ?? "");
    const homeSlug = resolveSlug(cols[iHome] ?? "");
    const awaySlug = resolveSlug(cols[iAway] ?? "");
    if (!date || !homeSlug || !awaySlug) {
      skippedUnknown++;
      continue;
    }
    const hgRaw = cols[iFTHG];
    const agRaw = cols[iFTAG];
    const completed = hgRaw !== "" && agRaw !== "" && hgRaw != null && agRaw != null;
    const homeGoals = completed ? Number(hgRaw) : null;
    const awayGoals = completed ? Number(agRaw) : null;
    if (completed && (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals))) continue;
    const id = `${div}-${season}-${date}-${homeSlug}-${awaySlug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      season,
      date,
      homeSlug,
      awaySlug,
      homeGoals,
      awayGoals,
      status: completed ? "completed" : "postponed",
      division: div,
    });
  }
  if (skippedUnknown) {
    console.warn(`  ${season} ${div}: skipped ${skippedUnknown} rows (unmapped club or bad date)`);
  }
  return rows;
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const all: Row[] = [];
  for (const season of SEASONS) {
    for (const div of DIVISIONS) {
      const dest = path.join(RAW, `${season}-${div}.csv`);
      let text: string;
      if (fs.existsSync(dest) && fs.statSync(dest).size > 200) {
        text = fs.readFileSync(dest, "utf8");
        console.log(`cache ${season} ${div}`);
      } else {
        console.log(`fetch ${season} ${div}`);
        text = await fetchCsv(season, div);
        fs.writeFileSync(dest, text);
      }
      const rows = ingest(text, season, div);
      console.log(`  ${rows.length} fixtures`);
      all.push(...rows);
    }
  }
  all.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const payload = {
    source: "football-data.co.uk",
    sourceUrl: "https://www.football-data.co.uk/englandm.php",
    importedAt: new Date().toISOString(),
    fixtures: all,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  const pl = all.filter((r) => r.division === "E0" && r.status === "completed");
  console.log(`wrote ${all.length} rows (${pl.length} completed PL) → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
