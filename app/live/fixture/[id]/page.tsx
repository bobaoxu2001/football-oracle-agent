import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fixtureLiveView } from "@/lib/competitions/premier-league/live-ledger";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { getVerification } from "@/lib/competitions/premier-league/ops/result-feed";
import { utcIsoToLondonLocal } from "@/lib/competitions/premier-league/timezone";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { compareFixture } from "@/lib/competitions/premier-league/shadow/compare";
import { listCanonicalMatches } from "@/lib/match-ledger/store";
import { ModelComparison } from "@/components/shadow/model-comparison";
import { jobsForFixture } from "@/lib/competitions/premier-league/ops/job-ledger";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { forecastFreshness } from "@/lib/match-forecast/service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fixture live record · Football Oracle",
};

function fmt(n: number | null | undefined, d = 3): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(d);
}

export default async function FixtureLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await hydrateDurableOps();
  const now = new Date();
  const fixture = liveFixtures().find((f) => f.id === id);
  if (!fixture) notFound();
  const home = getClub(fixture.homeSlug);
  const away = getClub(fixture.awaySlug);
  const view = fixtureLiveView(id, fixture.season, now);
  const jobs = jobsForFixture(id);
  const freshness = forecastFreshness(
    fixture,
    listLiveSnapshots({ fixtureId: id }),
    now,
    jobs
  );
  const verification = getVerification(id);
  const ledgerMatches = await listCanonicalMatches({
    competition: "premier-league",
    season: fixture.season,
  });
  const comparison = compareFixture({
    fixtureId: id,
    homeSlug: fixture.homeSlug,
    awaySlug: fixture.awaySlug,
    kickoffUtc: fixture.kickoffUtc ?? fixture.kickoff ?? null,
    ledgerMatches,
    season: fixture.season,
  });
  let kickoff = fixture.date;
  try {
    if (fixture.kickoffUtc) {
      const l = utcIsoToLondonLocal(fixture.kickoffUtc);
      kickoff = `${l.date} ${l.time} UK`;
    }
  } catch {
    /* keep */
  }

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Fixture record · LIVE_OOS
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">
          {home.name} vs {away.name}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {kickoff} · {fixture.kickoffCertainty ?? "certainty unknown"} · {fixture.status}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Actual:{" "}
          {fixture.homeGoals !== null && fixture.awayGoals !== null
            ? `${fixture.homeGoals}–${fixture.awayGoals}`
            : "—"}
          {verification ? ` · result ${verification.status}` : ""}
        </p>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="font-semibold">Fixture forecast stage coverage</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {freshness.status.replaceAll("_", " ")} · selected {freshness.selectedStage ?? "none"} ·
          latest required {freshness.latestRequiredStage ?? "baseline"} · missed {freshness.missedStages.length ? freshness.missedStages.join(", ") : "none"}.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          This is fixture-specific forecast coverage. Scheduler liveness and fixture metadata sync are separate scoped statuses on Operational Health.
        </p>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Predictions by stage</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left text-xs text-muted-foreground">
            <caption className="sr-only">Production snapshots and scheduler status by forecast stage</caption>
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                <th scope="col" className="py-2 pr-3 font-medium">Stage</th>
                <th scope="col" className="py-2 pr-3 font-medium">Scheduler status</th>
                <th scope="col" className="py-2 pr-3 font-medium">Cutoff</th>
                <th scope="col" className="py-2 pr-3 font-medium">H / D / A</th>
                <th scope="col" className="py-2 pr-3 font-medium">Brier</th>
                <th scope="col" className="py-2 pr-3 font-medium">RPS</th>
                <th scope="col" className="py-2 font-medium">LogLoss</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(view.byStage).map(([stage, row]) => {
                const currentKickoff = fixture.kickoffUtc ?? fixture.kickoff ?? null;
                const stageJobs = jobs
                  .filter((job) => job.stage === stage)
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
                const job =
                  stageJobs.find((candidate) => candidate.kickoffUtc === currentKickoff) ??
                  stageJobs[0] ??
                  null;
                const status = row.snapshot
                  ? row.validForCurrentSelection
                    ? "SUCCEEDED"
                    : row.kickoffIdentityCurrent
                      ? "INVALID_PREKICK"
                      : "SUPERSEDED_KICKOFF"
                  : job?.status ?? "NOT_SCHEDULED";
                return (
                  <tr key={stage} className="border-b border-white/5">
                    <th scope="row" className="py-1.5 pr-3 font-medium text-foreground">{stage}</th>
                    <td className={status === "MISSED" || status === "SUPERSEDED_KICKOFF" || status === "INVALID_PREKICK" ? "py-1.5 pr-3 font-semibold text-amber-200" : "py-1.5 pr-3"}>
                      {status}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {row.snapshot?.asOf ?? job?.plannedAsOf ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      {row.snapshot
                        ? `${(row.snapshot.homeProbability * 100).toFixed(1)} / ${(row.snapshot.drawProbability * 100).toFixed(1)} / ${(row.snapshot.awayProbability * 100).toFixed(1)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-3">{fmt(row.settlement?.brier, 4)}</td>
                    <td className="py-1.5 pr-3">{fmt(row.settlement?.rps, 4)}</td>
                    <td className="py-1.5">{fmt(row.settlement?.logLoss, 4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          T7D is the deterministic rolling-early stage. A missed window remains MISSED and is never
          backfilled. FINAL_PREKICK is the last valid model freeze before kickoff; it is not
          lineup-confirmed.
        </p>
      </section>

      <div className="mx-auto mb-8 max-w-3xl">
        <ModelComparison comparison={comparison} />
      </div>

      <p className="mx-auto max-w-3xl text-sm">
        <Link href="/live" className="text-neon hover:underline">
          ← Production ledger
        </Link>
        {" · "}
        <Link href="/shadow" className="text-neon hover:underline">
          Shadow evaluation
        </Link>
      </p>
    </div>
  );
}
