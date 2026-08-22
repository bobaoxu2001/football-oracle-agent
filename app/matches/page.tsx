import type { Metadata } from "next";
import Link from "next/link";
import { BIG_FIVE_COMPETITION_IDS, isBigFiveCompetitionId, type BigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition } from "@/lib/competitions/registry";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { matchHistoryView } from "@/lib/match-ledger/views";
import { MatchCard } from "@/components/matches/match-card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Match history · Football Oracle",
  description:
    "Completed 2026-27 Big Five matches recorded in the canonical match ledger, with the frozen pre-kickoff forecast for each.",
};

export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ competition?: string | string[] }>;
}) {
  const { competition: raw } = await searchParams;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const competition: BigFiveCompetitionId =
    requested && isBigFiveCompetitionId(requested) ? requested : "premier-league";
  const season = BIG_FIVE_CURRENT_SEASON;

  const view = await matchHistoryView(competition, season);
  const counts = await Promise.all(
    BIG_FIVE_COMPETITION_IDS.map(async (id) => ({
      id,
      name: getCompetition(id).name,
      count: (await matchHistoryView(id, season)).completedCount,
    }))
  );
  const totalCompleted = counts.reduce((s, c) => s + c.count, 0);

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-4xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {season} · canonical match ledger
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Match history</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Every completed Big Five match discovered from{" "}
          <span className="text-foreground">{view.capability.source}</span> and recorded as
          append-only observations. A match becomes evidence for later fixtures only once its
          result was observed — it can never change its own frozen pre-kickoff forecast.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {totalCompleted} completed match{totalCompleted === 1 ? "" : "es"} stored across five
          leagues. Statistics are shown only where the source actually supplies them.
        </p>
      </section>

      <section className="mx-auto mb-6 flex max-w-4xl flex-wrap gap-2">
        {counts.map((c) => (
          <Link
            key={c.id}
            href={`/matches?competition=${c.id}`}
            className={
              c.id === competition
                ? "rounded-full border border-neon/40 bg-neon/10 px-3 py-1.5 text-xs font-semibold text-foreground"
                : "rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-neon/30 hover:text-foreground"
            }
          >
            {c.name}
            <span className="ml-1.5 text-muted-foreground">{c.count}</span>
          </Link>
        ))}
      </section>

      <section className="mx-auto max-w-4xl space-y-6">
        {view.matchweeks.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">No completed matches yet</p>
            <p className="mt-2">
              {view.competitionName} has no finished 2026-27 fixture in the ledger. Scheduled
              fixtures are tracked, but only a full-time result with a score is recorded as a
              completed match — a matchweek in progress contributes only the matches that have
              actually finished.
            </p>
          </div>
        ) : (
          view.matchweeks.map((group) => (
            <div key={String(group.matchday)}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {group.matchday === null ? "Unscheduled" : `Matchweek ${group.matchday}`}
                <span className="ml-2 font-normal normal-case tracking-normal">
                  {group.matches.length} completed
                </span>
              </h2>
              <div className="space-y-2">
                {group.matches.map((m) => (
                  <MatchCard key={m.canonicalMatchId} match={m} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="mx-auto mt-10 max-w-4xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-xs text-muted-foreground">
        <h2 className="mb-2 text-sm font-semibold text-foreground">What this source supplies</h2>
        <p>
          <span className="text-foreground">Available:</span> full-time and half-time score,
          outcome, matchweek, kickoff, provider ids.
        </p>
        <p className="mt-1">
          <span className="text-foreground">Not available on this plan:</span>{" "}
          {view.capability.missing.join(", ")}.
        </p>
        <p className="mt-2">{view.capability.notes}</p>
      </section>
    </div>
  );
}
