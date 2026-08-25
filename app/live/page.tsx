import type { Metadata } from "next";
import Link from "next/link";
import { livePerformanceReport, ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { canonicalLedgerMetrics } from "@/lib/competitions/premier-league/ledger-metrics";
import { evaluateDataGate, upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { utcIsoToLondonLocal } from "@/lib/competitions/premier-league/timezone";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Production ledger · Football Oracle",
  description: "Immutable out-of-sample Premier League production forecasts. Research tracks are excluded.",
};

function pct(x: number | null, d = 3) {
  if (x === null) return "—";
  return x.toFixed(d);
}

function formatKickoff(utc: string | null | undefined, date: string): string {
  if (!utc) return date;
  try {
    const local = utcIsoToLondonLocal(utc);
    return `${local.date} ${local.time} UK`;
  } catch {
    return date;
  }
}

export default async function LiveLedgerPage() {
  await hydrateDurableOps();
  const report = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const metrics = canonicalLedgerMetrics(PREMIER_LEAGUE_CURRENT_SEASON);
  const counts = ledgerCounts(PREMIER_LEAGUE_CURRENT_SEASON);
  const gate = evaluateDataGate();
  const params = loadProductionParams();
  const upcoming = upcomingLiveFixtures().slice(0, 8);

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {PREMIER_LEAGUE_CURRENT_SEASON} · production LIVE_OOS only
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Premier League production ledger</h1>
        <p className="mt-3 text-sm text-muted-foreground">{currentHonestyText()}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Model {params.modelVersion}. Data gate {gate.status}. Retrospective reconstructions and
          historical backtests are listed separately and never mixed into these scores.
        </p>
      </section>

      <section className="mx-auto mb-8 grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Production forecast snapshots" value={String(metrics.production.totalForecastSnapshots)} />
        <Stat label="Settled forecast snapshots" value={String(metrics.production.settledForecastSnapshots)} />
        <Stat label="Unique settled fixtures" value={String(metrics.production.uniqueFixturesSettled)} />
        <Stat label="Data gate" value={gate.status} />
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="font-semibold">Canonical ledger count contract</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Snapshot counts measure immutable forecasts. Fixture counts deduplicate every stage for the
          same match. Production and shadow tracks remain separate; the all-track row is never used as
          a production headline.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-xs text-muted-foreground">
            <caption className="sr-only">Canonical forecast ledger counts by model track</caption>
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                <th scope="col" className="py-2 pr-3 font-medium">Track</th>
                <th scope="col" className="py-2 pr-3 font-medium">Forecast snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Settled snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Unsettled snapshots</th>
                <th scope="col" className="py-2 font-medium">Unique settled fixtures</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Production", metrics.production],
                ["Shadow", metrics.shadow],
                ["All LIVE_OOS tracks", metrics.allTracks],
              ].map(([label, row]) => {
                const track = row as typeof metrics.production;
                return (
                  <tr key={String(label)} className="border-b border-white/5">
                    <th scope="row" className="py-2 pr-3 font-medium text-foreground">{String(label)}</th>
                    <td className="py-2 pr-3 tabular-nums">{track.totalForecastSnapshots}</td>
                    <td className="py-2 pr-3 tabular-nums">{track.settledForecastSnapshots}</td>
                    <td className="py-2 pr-3 tabular-nums">{track.unsettledForecastSnapshots}</td>
                    <td className="py-2 tabular-nums">{track.uniqueFixturesSettled}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Persisted settlement records: {metrics.settlements.persistedSnapshotSettlementRecords}.
          These are one-per-snapshot records, not settlement operations. A durable operation-event
          count is not currently recorded and is therefore reported as unavailable.
        </p>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Stage performance</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Each stage is scored separately. N=0 is shown as —. Headline Brier/RPS/LogLoss stay blank
          until 20 unique fixtures have settled. EARLY is the legacy initial freeze; T7D is the
          deterministic rolling-early stage. FINAL_PREKICK is not a lineup-confirmed model.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-muted-foreground">
            <caption className="sr-only">Production forecast performance by immutable snapshot stage</caption>
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                <th scope="col" className="py-2 pr-3 font-medium">Stage</th>
                <th scope="col" className="py-2 pr-3 font-medium">Snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Settled snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Brier</th>
                <th scope="col" className="py-2 pr-3 font-medium">RPS</th>
                <th scope="col" className="py-2 font-medium">LogLoss</th>
              </tr>
            </thead>
            <tbody>
              {report.byStage.map((row) => (
                <tr key={row.stage} className="border-b border-white/5">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-foreground">{row.stage}</th>
                  <td className="py-1.5 pr-3">{row.totalForecastSnapshots}</td>
                  <td className="py-1.5 pr-3">{row.settledForecastSnapshots}</td>
                  <td className="py-1.5 pr-3">{row.brier === null ? "—" : row.brier.toFixed(4)}</td>
                  <td className="py-1.5 pr-3">{row.rps === null ? "—" : row.rps.toFixed(4)}</td>
                  <td className="py-1.5">{row.logLoss === null ? "—" : row.logLoss.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">LIVE_OOS scores</h2>
        <p className="mb-4 text-amber-200/90">{report.sampleNote}</p>
        <ul className="space-y-1 text-muted-foreground">
          <li>Brier: {pct(report.brier, 4)}</li>
          <li>RPS: {pct(report.rps, 4)}</li>
          <li>LogLoss: {pct(report.logLoss, 4)}</li>
          <li>Calibration (confidence ECE): {report.confidenceEce === null ? "n too small" : pct(report.confidenceEce, 3)}</li>
          <li>Top-pick accuracy (secondary): {report.topPickAccuracy === null ? "—" : `${(report.topPickAccuracy * 100).toFixed(1)}%`}</li>
        </ul>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Upcoming fixtures</h2>
        <ul className="space-y-2">
          {upcoming.map((f) => {
            const h = getClub(f.homeSlug);
            const a = getClub(f.awaySlug);
            return (
              <li key={f.id}>
                <Link href={`/live/fixture/${f.id}`} className="hover:text-foreground">
                  {h.shortName} vs {a.shortName}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {formatKickoff(f.kickoffUtc ?? f.kickoff, f.date)}
                    {f.kickoffCertainty ? ` · ${f.kickoffCertainty}` : ""}
                  </span>
                </Link>
                <Link href={`/match/${f.id}`} className="ml-2 text-xs text-neon hover:underline">
                  Open Match Room
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mx-auto max-w-3xl text-sm text-muted-foreground">
        <p>
          Other classes this season — RETROSPECTIVE: {counts.RETROSPECTIVE} · BACKTEST: {counts.BACKTEST}.
        </p>
        <p className="mt-4">
          <Link href="/health" className="text-neon hover:underline">
            Operational health
          </Link>
          {" · "}
          <Link href="/" className="text-neon hover:underline">
            ← Back to forecasts
          </Link>
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}
