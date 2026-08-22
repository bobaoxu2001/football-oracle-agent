import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isBigFiveCompetitionId } from "@/lib/competitions/types";
import { BIG_FIVE_CURRENT_SEASON } from "@/lib/competitions/big-five/configs";
import { teamSeasonView } from "@/lib/match-ledger/views";
import { MatchCard } from "@/components/matches/match-card";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ competition: string; slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `${slug} — ${BIG_FIVE_CURRENT_SEASON} season record · Football Oracle`,
    description: "Current-season record read from the canonical Big Five match ledger.",
  };
}

export default async function TeamSeasonPage({
  params,
}: {
  params: Promise<{ competition: string; slug: string }>;
}) {
  const { competition, slug } = await params;
  if (!isBigFiveCompetitionId(competition)) notFound();
  const season = BIG_FIVE_CURRENT_SEASON;
  const view = await teamSeasonView(competition, season, slug);
  if (!view) {
    return (
      <div className="container py-12">
        <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm">
          <h1 className="text-xl font-bold">No completed matches</h1>
          <p className="mt-2 text-muted-foreground">
            No finished {season} match is recorded for <code>{slug}</code> in{" "}
            {competition}. The team page reads the canonical match ledger directly, so it shows
            nothing until a real result has been observed.
          </p>
          <Link href="/matches" className="mt-4 inline-block text-neon hover:underline">
            ← Match history
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-6 max-w-4xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {view.competitionName} · {season}
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">{view.teamName}</h1>
        <p className="mt-2 text-xs text-muted-foreground">
          Read directly from the canonical match ledger — not a separate duplicated store.
        </p>
      </section>

      <section className="mx-auto mb-6 grid max-w-4xl gap-3 sm:grid-cols-4">
        <Stat label="Played" value={String(view.played)} />
        <Stat label="W-D-L" value={`${view.wins}-${view.draws}-${view.losses}`} />
        <Stat label="GF-GA" value={`${view.goalsFor}-${view.goalsAgainst}`} />
        <Stat label="Points" value={String(view.points)} />
      </section>

      <section className="mx-auto mb-8 grid max-w-4xl gap-3 sm:grid-cols-3">
        <Panel title="Season">
          <Line label="Goal difference" value={fmtGd(view.goalDifference)} />
          <Line
            label="Points per match"
            value={view.pointsPerMatch === null ? "—" : view.pointsPerMatch.toFixed(2)}
          />
          <Line label="Form (oldest first)" value={view.form || "—"} />
        </Panel>
        <Panel title="Home">
          <Line label="Played" value={String(view.home.played)} />
          <Line label="W-D-L" value={`${view.home.wins}-${view.home.draws}-${view.home.losses}`} />
          <Line label="GF-GA" value={`${view.home.goalsFor}-${view.home.goalsAgainst}`} />
        </Panel>
        <Panel title="Away">
          <Line label="Played" value={String(view.away.played)} />
          <Line label="W-D-L" value={`${view.away.wins}-${view.away.draws}-${view.away.losses}`} />
          <Line label="GF-GA" value={`${view.away.goalsFor}-${view.away.goalsAgainst}`} />
        </Panel>
      </section>

      <section className="mx-auto max-w-4xl">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Recent matches
        </h2>
        <div className="space-y-2">
          {view.recentMatches.map((m) => (
            <MatchCard key={m.canonicalMatchId} match={m} />
          ))}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          As the season accumulates this becomes a rolling last-5 / season / home / away record.
          With {view.played} match{view.played === 1 ? "" : "es"} played, current-season evidence is
          deliberately weighted at only{" "}
          {((view.played / (view.played + 8)) * 100).toFixed(0)}% against the pre-season prior.
        </p>
        <p className="mt-4">
          <Link href="/matches" className="text-neon hover:underline">
            ← Match history
          </Link>
        </p>
      </section>
    </div>
  );
}

function fmtGd(gd: number): string {
  return gd > 0 ? `+${gd}` : String(gd);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h3>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
