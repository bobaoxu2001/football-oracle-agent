import type { Metadata } from "next";
import Link from "next/link";
import { livePerformanceReport, ledgerCounts } from "@/lib/competitions/premier-league/live-ledger";
import { evaluateDataGate, upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { utcIsoToLondonLocal } from "@/lib/competitions/premier-league/timezone";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live 2026-27 ledger · Football Oracle",
  description: "Genuine live out-of-sample Premier League forecasts. Reconstructions are excluded.",
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

export default function LiveLedgerPage() {
  const report = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const counts = ledgerCounts(PREMIER_LEAGUE_CURRENT_SEASON);
  const gate = evaluateDataGate();
  const params = loadProductionParams();
  const upcoming = upcomingLiveFixtures().slice(0, 8);

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {PREMIER_LEAGUE_CURRENT_SEASON} · LIVE_OOS only
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Genuine live forecast ledger</h1>
        <p className="mt-3 text-sm text-muted-foreground">{currentHonestyText()}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Model {params.modelVersion}. Data gate {gate.status}. Retrospective reconstructions and
          historical backtests are listed separately and never mixed into these scores.
        </p>
      </section>

      <section className="mx-auto mb-8 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Stat label="LIVE_OOS snapshots" value={String(report.nPredictions)} />
        <Stat label="Settled" value={String(report.nSettled)} />
        <Stat label="Data gate" value={gate.status} />
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Stage breakdown</h2>
        <ul className="grid grid-cols-2 gap-1 text-muted-foreground sm:grid-cols-3">
          <li>EARLY: {report.stages.EARLY}</li>
          <li>PRESEASON: {report.stages.PRESEASON}</li>
          <li>T24H: {report.stages.T24H}</li>
          <li>T2H: {report.stages.T2H}</li>
          <li>T60M: {report.stages.T60M}</li>
          <li>FINAL_PREKICK: {report.stages.FINAL_PREKICK}</li>
        </ul>
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
            const q = encodeURIComponent(`Who wins ${h.name} vs ${a.name}?`);
            return (
              <li key={f.id}>
                <Link href={`/?q=${q}`} className="hover:text-foreground">
                  {h.shortName} vs {a.shortName}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {formatKickoff(f.kickoffUtc ?? f.kickoff, f.date)}
                    {f.kickoffCertainty ? ` · ${f.kickoffCertainty}` : ""}
                  </span>
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
          <Link href="/" className="text-neon hover:underline">
            ← Back to the agent
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
