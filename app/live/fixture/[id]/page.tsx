import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fixtureLiveView } from "@/lib/competitions/premier-league/live-ledger";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { getVerification } from "@/lib/competitions/premier-league/ops/result-feed";
import { utcIsoToLondonLocal } from "@/lib/competitions/premier-league/timezone";

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
  const fixture = liveFixtures().find((f) => f.id === id);
  if (!fixture) notFound();
  const home = getClub(fixture.homeSlug);
  const away = getClub(fixture.awaySlug);
  const view = fixtureLiveView(id);
  const verification = getVerification(id);
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
        <h2 className="mb-3 font-semibold">Predictions by stage</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-muted-foreground">
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                <th className="py-2 pr-3 font-medium">Stage</th>
                <th className="py-2 pr-3 font-medium">H / D / A</th>
                <th className="py-2 pr-3 font-medium">Brier</th>
                <th className="py-2 pr-3 font-medium">RPS</th>
                <th className="py-2 font-medium">LogLoss</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(view.byStage).map(([stage, row]) => (
                <tr key={stage} className="border-b border-white/5">
                  <td className="py-1.5 pr-3 text-foreground">{stage}</td>
                  <td className="py-1.5 pr-3">
                    {row.snapshot
                      ? `${(row.snapshot.homeProbability * 100).toFixed(1)} / ${(row.snapshot.drawProbability * 100).toFixed(1)} / ${(row.snapshot.awayProbability * 100).toFixed(1)}`
                      : "—"}
                  </td>
                  <td className="py-1.5 pr-3">{fmt(row.settlement?.brier, 4)}</td>
                  <td className="py-1.5 pr-3">{fmt(row.settlement?.rps, 4)}</td>
                  <td className="py-1.5">{fmt(row.settlement?.logLoss, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          FINAL_PREKICK is the last valid model freeze before kickoff. It is not lineup-confirmed.
        </p>
      </section>

      <p className="mx-auto max-w-3xl text-sm">
        <Link href="/live" className="text-neon hover:underline">
          ← Live ledger
        </Link>
      </p>
    </div>
  );
}
