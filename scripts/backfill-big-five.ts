/**
 * Controlled backfill of the 2026-27 Big Five match ledger.
 *
 *   FOOTBALL_DATA_API_KEY=… npx tsx scripts/backfill-big-five.ts
 *   … --dry-run        report what the provider has, write nothing
 *   … --no-settle      ingest only, skip settlement linkage
 *   … --season 2026-27
 *
 * Idempotent: re-running stores no duplicate observations and creates no
 * duplicate matches. Only matches the provider reports as FINISHED with a
 * full-time score are counted as completed — a partially played matchweek
 * contributes only the matches that actually finished.
 */

import { BIG_FIVE_COMPETITION_IDS, type BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { runLedgerTick } from "@/lib/match-ledger/tick";
import { listCanonicalMatches, listObservations, matchLedgerBackend, matchLedgerDir } from "@/lib/match-ledger/store";
import { isCompletedMatch } from "@/lib/match-ledger/types";
import { fetchCompetitionMatches, footballDataConfigured, mapLedgerStatus } from "@/lib/match-ledger/providers/football-data";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noSettle = args.includes("--no-settle");
const seasonIdx = args.indexOf("--season");
const season = seasonIdx >= 0 ? args[seasonIdx + 1] : BIG_FIVE_CURRENT_SEASON;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function dryRunReport(): Promise<void> {
  console.log(`Dry run — provider state for ${season} (nothing written)\n`);
  for (const competition of BIG_FIVE_COMPETITION_IDS) {
    const cfg = getCompetition(competition);
    try {
      const { matches, httpStatus } = await fetchCompetitionMatches(competition, season);
      if (httpStatus !== 200) {
        console.log(`${pad(cfg.name, 16)} provider HTTP ${httpStatus}`);
        continue;
      }
      const byStatus = new Map<string, number>();
      let completed = 0;
      for (const m of matches) {
        const st = mapLedgerStatus(m.status);
        byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
        if (st === "FINISHED" && typeof m.score?.fullTime?.home === "number") completed += 1;
      }
      const detail = [...byStatus.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`${pad(cfg.name, 16)} rows=${pad(String(matches.length), 4)} completed=${pad(String(completed), 4)} ${detail}`);
    } catch (err) {
      console.log(`${pad(cfg.name, 16)} ERROR ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  if (!footballDataConfigured()) {
    console.error("FOOTBALL_DATA_API_KEY is not configured — refusing to run.");
    process.exit(1);
  }
  console.log(`backend=${matchLedgerBackend()} dir=${matchLedgerDir()} season=${season}\n`);

  if (dryRun) {
    await dryRunReport();
    return;
  }

  const result = await runLedgerTick({
    season,
    force: true,
    skipSettlement: noSettle,
  });

  if (!result.ran) {
    console.error(`Ledger pass did not run: ${result.skippedReason}`);
    process.exit(1);
  }

  console.log("── Ingest ───────────────────────────────────────────────────");
  for (const c of result.ingest?.competitions ?? []) {
    const rejected = c.rejected.length
      ? ` rejected=[${c.rejected.map((r) => `${r.reason}:${r.count}`).join(", ")}]`
      : "";
    console.log(
      `${pad(c.competitionName, 16)} rows=${pad(String(c.providerRows), 4)}` +
        ` providerCompleted=${pad(String(c.providerCompleted), 4)}` +
        ` obsWritten=${pad(String(c.observationsWritten), 5)}` +
        ` obsSkipped=${pad(String(c.observationsSkipped), 5)}` +
        `${c.error ? ` ERROR=${c.error}` : ""}${rejected}`
    );
  }

  if (!noSettle) {
    console.log("\n── Settlement ───────────────────────────────────────────────");
    for (const s of result.settlement) {
      console.log(
        `${pad(getCompetition(s.competition).name, 16)} completed=${pad(String(s.completedMatches), 4)}` +
          ` settlementsWritten=${pad(String(s.settlementsWritten), 4)}` +
          ` withoutFrozenSnapshot=${s.matchesWithoutSnapshots}` +
          `${s.errors.length ? ` errors=${s.errors.length}` : ""}`
      );
    }
  }

  console.log("\n── Completed matches stored (2026-27) ───────────────────────");
  let total = 0;
  for (const competition of BIG_FIVE_COMPETITION_IDS as readonly BigFiveCompetitionId[]) {
    const matches = await listCanonicalMatches({ competition, season });
    const done = matches.filter(isCompletedMatch);
    total += done.length;
    console.log(`${getCompetition(competition).name}: ${done.length} completed matches`);
  }
  const observations = await listObservations({ season });
  console.log(`\nTotal completed: ${total}`);
  console.log(`Observations stored: ${observations.length}`);
  if (result.errors.length) {
    console.log(`\nErrors: ${result.errors.join("; ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
