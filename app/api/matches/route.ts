import { NextResponse } from "next/server";
import { BIG_FIVE_COMPETITION_IDS, isBigFiveCompetitionId } from "@/lib/competitions/types";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { matchHistoryView } from "@/lib/match-ledger/views";
import { loadLedgerState } from "@/lib/match-ledger/scheduler";
import { FOOTBALL_DATA_CAPABILITY } from "@/lib/match-ledger/providers/football-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/matches                        → completed-match counts for all five leagues
 * GET /api/matches?competition=la-liga    → that competition's matchweeks in full
 * GET /api/matches?season=2026-27
 *
 * Serves the canonical ledger. Statistics appear only where the source supplies
 * them; `unavailableStatistics` names the rest rather than emitting zeros.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requested = url.searchParams.get("competition");
    const season = url.searchParams.get("season") || BIG_FIVE_CURRENT_SEASON;

    if (requested !== null && !isBigFiveCompetitionId(requested)) {
      return NextResponse.json(
        { error: "unknown competition", supported: BIG_FIVE_COMPETITION_IDS },
        { status: 400 }
      );
    }

    const state = await loadLedgerState();

    if (requested !== null && isBigFiveCompetitionId(requested)) {
      const view = await matchHistoryView(requested, season);
      return NextResponse.json({ ...view, season, ledgerState: state });
    }

    const competitions = await Promise.all(
      BIG_FIVE_COMPETITION_IDS.map(async (id) => {
        const view = await matchHistoryView(id, season);
        return {
          competition: id,
          competitionName: view.competitionName,
          completedMatches: view.completedCount,
          matchweeksWithResults: view.matchweeks.length,
        };
      })
    );

    return NextResponse.json({
      season,
      source: FOOTBALL_DATA_CAPABILITY.source,
      capability: FOOTBALL_DATA_CAPABILITY,
      ledgerState: state,
      totalCompleted: competitions.reduce((s, c) => s + c.completedMatches, 0),
      competitions,
      note:
        "Completed = provider reported FINISHED with a full-time score. A matchweek in progress " +
        "contributes only the matches that actually finished.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "matches_failed", message: (err as Error).message },
      { status: 500 }
    );
  }
}
