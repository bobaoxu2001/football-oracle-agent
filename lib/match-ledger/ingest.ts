/**
 * Big Five ledger ingestion.
 *
 * One pass per competition: fetch → map → append observations → persist team
 * identity. Idempotent by construction (see observationIdFor), so it is safe to
 * run on every ops tick and safe to re-run after a partial failure.
 *
 * Ingestion NEVER touches prediction snapshots, ratings, or the frozen tape.
 * It only adds evidence; deciding what that evidence is allowed to influence is
 * the feature layer's job (see features.ts).
 */

import type { BigFiveCompetitionId } from "@/lib/competitions/types";
import { BIG_FIVE_COMPETITION_IDS } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import type { MatchObservation } from "./types";
import { isCompletedMatch } from "./types";
import {
  appendObservations,
  listCanonicalMatches,
  loadTeamIdentityRegistry,
  saveTeamIdentityRegistry,
} from "./store";
import {
  fetchCompetitionMatches,
  footballDataConfigured,
  mapFootballDataMatch,
  type FootballDataMatch,
} from "./providers/football-data";

export interface CompetitionIngestReport {
  competition: BigFiveCompetitionId;
  competitionName: string;
  season: string;
  /** Rows returned by the provider for the season. */
  providerRows: number;
  /** Rows the provider reported as FINISHED with a full-time score. */
  providerCompleted: number;
  observationsWritten: number;
  observationsSkipped: number;
  /** Completed matches in the ledger for this competition AFTER the pass. */
  ledgerCompleted: number;
  /** Rows we refused to map, with reasons. */
  rejected: { reason: string; count: number }[];
  httpStatus: number | null;
  error: string | null;
}

export interface LedgerIngestReport {
  ranAt: string;
  season: string;
  source: string;
  configured: boolean;
  competitions: CompetitionIngestReport[];
  totalCompleted: number;
}

function emptyReport(
  competition: BigFiveCompetitionId,
  season: string
): CompetitionIngestReport {
  return {
    competition,
    competitionName: getCompetition(competition).name,
    season,
    providerRows: 0,
    providerCompleted: 0,
    observationsWritten: 0,
    observationsSkipped: 0,
    ledgerCompleted: 0,
    rejected: [],
    httpStatus: null,
    error: null,
  };
}

/**
 * Ingest one competition-season.
 *
 * `matches` may be injected (tests, fixtures, replay). When omitted the live
 * provider is called.
 */
export async function ingestCompetition(input: {
  competition: BigFiveCompetitionId;
  season?: string;
  observedAt?: string;
  matches?: FootballDataMatch[];
  /** Hosted observers may bound retries to stay inside one function budget. */
  providerOptions?: {
    timeoutMs?: number;
    maxRetries?: number;
    sleepFn?: (ms: number) => Promise<void>;
  };
}): Promise<CompetitionIngestReport> {
  const season = input.season ?? BIG_FIVE_CURRENT_SEASON;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const report = emptyReport(input.competition, season);

  let rows: FootballDataMatch[];
  if (input.matches) {
    rows = input.matches;
  } else {
    if (!footballDataConfigured()) {
      report.error = "FOOTBALL_DATA_API_KEY is not configured";
      return report;
    }
    try {
      const fetched = await fetchCompetitionMatches(
        input.competition,
        season,
        input.providerOptions
      );
      rows = fetched.matches;
      report.httpStatus = fetched.httpStatus;
      if (fetched.httpStatus !== 200) {
        report.error = `provider HTTP ${fetched.httpStatus}`;
        return report;
      }
    } catch (err) {
      report.error = (err as Error).message;
      return report;
    }
  }

  report.providerRows = rows.length;

  let registry = await loadTeamIdentityRegistry();
  const observations: MatchObservation[] = [];
  const rejected = new Map<string, number>();

  for (const raw of rows) {
    const mapped = mapFootballDataMatch(raw, {
      competition: input.competition,
      season,
      observedAt,
      registry,
    });
    registry = mapped.registry;
    if (!mapped.observation) {
      const reason = mapped.rejectedReason ?? "unmapped";
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }
    if (
      mapped.observation.status === "FINISHED" &&
      mapped.observation.fullTimeHomeGoals !== null
    ) {
      report.providerCompleted += 1;
    }
    observations.push(mapped.observation);
  }

  report.rejected = [...rejected.entries()].map(([reason, count]) => ({ reason, count }));

  const appended = await appendObservations(observations);
  report.observationsWritten = appended.written;
  report.observationsSkipped = appended.skipped;

  // Identity is persisted only after observations land, so a crash cannot
  // register a slug for a match that was never stored.
  await saveTeamIdentityRegistry(registry);

  const canonical = await listCanonicalMatches({ competition: input.competition, season });
  report.ledgerCompleted = canonical.filter(isCompletedMatch).length;
  return report;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ingest every Big Five competition for a season. */
export async function ingestBigFive(input: {
  season?: string;
  observedAt?: string;
  competitions?: readonly BigFiveCompetitionId[];
  /** Injected provider payloads keyed by competition (tests/replay). */
  matchesByCompetition?: Partial<Record<BigFiveCompetitionId, FootballDataMatch[]>>;
  /** Gap between live provider calls. Ignored when payloads are injected. */
  interRequestDelayMs?: number;
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
} = {}): Promise<LedgerIngestReport> {
  const season = input.season ?? BIG_FIVE_CURRENT_SEASON;
  const ranAt = input.observedAt ?? new Date().toISOString();
  const competitions = input.competitions ?? BIG_FIVE_COMPETITION_IDS;
  const out: CompetitionIngestReport[] = [];

  for (let i = 0; i < competitions.length; i++) {
    const competition = competitions[i];
    const injected = input.matchesByCompetition?.[competition];
    // Space live calls out: five back-to-back requests reach the provider's
    // ~10/min free-tier ceiling. Injected payloads make no request, so tests
    // and replays are not slowed down by this.
    if (!injected && i > 0) await sleep(input.interRequestDelayMs ?? 7_000);
    out.push(
      await ingestCompetition({
        competition,
        season,
        observedAt: ranAt,
        matches: injected,
        providerOptions: injected
          ? undefined
          : {
              timeoutMs: input.providerTimeoutMs,
              maxRetries: input.providerMaxRetries,
            },
      })
    );
  }

  return {
    ranAt,
    season,
    source: "football-data.org",
    configured: footballDataConfigured(),
    competitions: out,
    totalCompleted: out.reduce((s, c) => s + c.ledgerCompleted, 0),
  };
}
