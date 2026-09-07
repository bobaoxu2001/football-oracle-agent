import type { Metadata } from "next";
import Link from "next/link";
import { RESEARCH_FORECAST_COMPETITION_IDS, isResearchForecastCompetitionId } from "@/lib/competitions/big-five";
import { getCompetition } from "@/lib/competitions/registry";
import { loadResearchForecastBoard } from "@/lib/competitions/big-five/research-service";
import { BigFiveForecastCard } from "@/components/research/big-five-forecast-card";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Big Five research forecasts · Football Oracle",
  description:
    "Labeled walk-forward 1X2 for La Liga, Bundesliga, Serie A and Ligue 1. Unfitted domestic prior. Not Premier League production.",
};

function evidenceCopy(level: "PRIOR_ONLY" | "THIN" | "SEASON_STARTED"): string {
  if (level === "PRIOR_ONLY") return "No current-season result is admissible yet. Numbers are the unfitted home-advantage prior.";
  if (level === "THIN") return "Fewer than 20 completed matches inform ratings. Treat the distribution as a prior with a light update, not a fitted league model.";
  return "Twenty or more current-season results are in the tape. Parameters remain an unfitted prior.";
}

export default async function BigFiveResearchPage({
  searchParams,
}: {
  searchParams: Promise<{ competition?: string | string[] }>;
}) {
  const { competition: raw } = await searchParams;
  const requested = Array.isArray(raw) ? raw[0] : raw;

  if (requested === "premier-league") {
    return (
      <div className="container py-8 md:py-12">
        <section className="mx-auto max-w-3xl rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
            Production isolation
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">Premier League is not a research league here</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Premier League 1X2 is a frozen <code>pl-live-v0.2.0</code> production artifact. This page will not mint a
            parallel research number for those fixtures.
          </p>
          <div className="mt-5 flex flex-wrap gap-3 text-sm font-semibold">
            <Link href="/" className="text-neon hover:underline">
              Open production forecasts →
            </Link>
            <Link href="/research/big-five?competition=la-liga" className="text-amber-200 hover:underline">
              La Liga research board →
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const competition = requested && isResearchForecastCompetitionId(requested) ? requested : "la-liga";
  const board = await loadResearchForecastBoard({ competition, limit: 12 });

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-5xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/90">
          Research track · separate from production
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">Big Five research forecasts</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Walk-forward Elo and Dixon-Coles 1X2 for La Liga, Bundesliga, Serie A and Ligue 1, read from the canonical
          match ledger. Parameters are a labeled domestic prior — not fitted on these leagues, and not the Premier
          League champion.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <span className="chip border-amber-300/30 text-amber-200">Model · {board.modelVersion}</span>
          <span className="chip">Not production · {board.notProductionModelVersion}</span>
          <span className="chip">HA 65 · ρ −0.10 · unfitted</span>
        </div>
      </section>

      <section className="mx-auto mb-6 flex max-w-5xl flex-wrap gap-2">
        {RESEARCH_FORECAST_COMPETITION_IDS.map((id) => {
          const name = getCompetition(id).name;
          const active = id === competition;
          return (
            <Link
              key={id}
              href={`/research/big-five?competition=${id}`}
              className={
                active
                  ? "rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-foreground"
                  : "rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-amber-300/30 hover:text-foreground"
              }
            >
              {name}
            </Link>
          );
        })}
      </section>

      <section className="mx-auto mb-8 max-w-5xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
        <p className="font-semibold text-foreground">
          {board.competitionName} · {board.season} · {board.evidenceLevel.replaceAll("_", " ").toLowerCase()}
        </p>
        <p className="mt-2">{evidenceCopy(board.evidenceLevel)}</p>
        <p className="mt-2 text-xs">
          {board.completedMatchesInLedger} completed match{board.completedMatchesInLedger === 1 ? "" : "es"} in the
          ledger · {board.upcomingCount} upcoming fixture{board.upcomingCount === 1 ? "" : "s"} after the cutoff
          {board.ledgerLastIngestAt
            ? ` · ledger last ingested ${board.ledgerLastIngestAt.replace("T", " ").slice(0, 19)} UTC`
            : " · ledger ingest time unknown"}
          .
        </p>
      </section>

      <section className="mx-auto max-w-6xl">
        {board.matches.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {board.matches.map((forecast) => (
              <BigFiveForecastCard key={forecast.canonicalMatchId} forecast={forecast} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">No upcoming research fixture</p>
            <p className="mt-2">
              {board.competitionName} has no scheduled 2026-27 match with a kickoff after the current cutoff. Unknown
              statuses and already-started fixtures are skipped rather than invented.
            </p>
          </div>
        )}
      </section>

      <section className="mx-auto mt-10 max-w-5xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-xs leading-relaxed text-muted-foreground">
        <p>{board.disclaimer}</p>
        <p className="mt-2">
          A completed match can inform a later fixture only after its result was observed. Observing a result cannot
          change a production snapshot, and this research board is recomputed on read from the ledger — it is not an
          immutable freeze tape.{" "}
          <Link href="/matches" className="text-neon hover:underline">
            Completed-match history
          </Link>
          {" · "}
          <Link href="/" className="text-neon hover:underline">
            Premier League production
          </Link>
        </p>
      </section>
    </div>
  );
}
