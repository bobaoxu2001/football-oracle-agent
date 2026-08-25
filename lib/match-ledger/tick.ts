/**
 * One ledger pass, as invoked by the production ops tick.
 *
 * Discover completed matches → record observations → materialize → settle any
 * frozen pre-match predictions. Fully isolated: a provider outage here must
 * never fail a forecast tick, so every failure is captured into the report
 * rather than thrown.
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { BIG_FIVE_COMPETITION_IDS } from "@/lib/competitions/types";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { ingestBigFive, type LedgerIngestReport } from "./ingest";
import { listCanonicalMatches } from "./store";
import { settleCompletedMatches, type LedgerSettlementReport } from "./settlement-link";
import { footballDataConfigured } from "./providers/football-data";
import {
  ingestIsDue,
  loadLedgerState,
  saveLedgerState,
  type LedgerState,
} from "./scheduler";

export interface LedgerTickResult {
  ran: boolean;
  skippedReason: string | null;
  ingest: LedgerIngestReport | null;
  settlement: LedgerSettlementReport[];
  completedByCompetition: Record<string, number>;
  totalCompleted: number;
  errors: string[];
  state: LedgerState;
}

export interface LedgerTickOptions {
  now?: string;
  season?: string;
  /** Ignore the cadence gate (backfill, manual runs, tests). */
  force?: boolean;
  competitions?: readonly BigFiveCompetitionId[];
  /** Skip settlement (pure-ingest backfills). */
  skipSettlement?: boolean;
  /** Bounds for serverless observer execution; defaults preserve CLI behavior. */
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
  interRequestDelayMs?: number;
}

export async function runLedgerTick(
  options: LedgerTickOptions = {}
): Promise<LedgerTickResult> {
  const now = options.now ?? new Date().toISOString();
  const season = options.season ?? BIG_FIVE_CURRENT_SEASON;
  const competitions = options.competitions ?? BIG_FIVE_COMPETITION_IDS;
  const errors: string[] = [];
  const state = await loadLedgerState();

  if (!footballDataConfigured()) {
    return {
      ran: false,
      skippedReason: "FOOTBALL_DATA_API_KEY is not configured",
      ingest: null,
      settlement: [],
      completedByCompetition: {},
      totalCompleted: 0,
      errors,
      state,
    };
  }
  if (!options.force && !ingestIsDue(state, now)) {
    return {
      ran: false,
      skippedReason: "ledger ingest not due",
      ingest: null,
      settlement: [],
      completedByCompetition: {},
      totalCompleted: 0,
      errors,
      state,
    };
  }

  state.lastIngestAt = now;
  state.ingestRuns += 1;

  let ingest: LedgerIngestReport | null = null;
  try {
    ingest = await ingestBigFive({
      season,
      observedAt: now,
      competitions,
      providerTimeoutMs: options.providerTimeoutMs,
      providerMaxRetries: options.providerMaxRetries,
      interRequestDelayMs: options.interRequestDelayMs,
    });
    for (const c of ingest.competitions) {
      if (c.error) errors.push(`${c.competition}: ${c.error}`);
    }
  } catch (err) {
    errors.push(`ingest: ${(err as Error).message}`);
  }

  const settlement: LedgerSettlementReport[] = [];
  const completedByCompetition: Record<string, number> = {};
  for (const competition of competitions) {
    try {
      const matches = await listCanonicalMatches({ competition, season });
      completedByCompetition[competition] = matches.filter(
        (m) => m.status === "FINISHED" && m.fullTimeHomeGoals !== null
      ).length;
      if (!options.skipSettlement) {
        settlement.push(settleCompletedMatches({ competition, matches, settledAt: now }));
      }
    } catch (err) {
      errors.push(`${competition}: ${(err as Error).message}`);
    }
  }

  const totalCompleted = Object.values(completedByCompetition).reduce((s, n) => s + n, 0);
  state.lastCompletedTotal = totalCompleted;
  if (errors.length) {
    state.lastError = errors[errors.length - 1];
  } else {
    state.lastIngestOkAt = now;
    state.lastError = null;
  }
  await saveLedgerState(state);

  return {
    ran: true,
    skippedReason: null,
    ingest,
    settlement,
    completedByCompetition,
    totalCompleted,
    errors,
    state,
  };
}
