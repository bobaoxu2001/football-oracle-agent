import { NextResponse } from "next/server";
import { BIG_FIVE_COMPETITION_IDS, isBigFiveCompetitionId } from "@/lib/competitions/types";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { matchHistoryView } from "@/lib/match-ledger/views";
import { loadLedgerState } from "@/lib/match-ledger/scheduler";
import { FOOTBALL_DATA_CAPABILITY } from "@/lib/match-ledger/providers/football-data";
import {
  publicFailureBody,
  publicOperationalErrorText,
  recordInternalOperationalError,
} from "@/lib/competitions/premier-league/ops/public-errors";

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
    const publicState = {
      ...state,
      lastError: state.lastError ? publicOperationalErrorText(state.lastError) : null,
    };

    if (requested !== null && isBigFiveCompetitionId(requested)) {
      const view = await matchHistoryView(requested, season);
      return NextResponse.json({ ...view, season, ledgerState: publicState });
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
      ledgerState: publicState,
      totalCompleted: competitions.reduce((s, c) => s + c.completedMatches, 0),
      competitions,
      note:
        "Completed = provider reported FINISHED with a full-time score. A matchweek in progress " +
        "contributes only the matches that actually finished.",
    });
  } catch (err) {
    recordInternalOperationalError("api.matches", err);
    return NextResponse.json(
      publicFailureBody("matches_failed", err),
      { status: 500 }
    );
  }
}
