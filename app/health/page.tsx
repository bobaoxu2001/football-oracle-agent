import type { Metadata } from "next";
import Link from "next/link";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operational health · Football Oracle",
  description: "Premier League production operations: sync, jobs, results, settlement, and ratings.",
};

function tone(state: string): string {
  if (["HEALTHY", "DATA_READY", "FRESH", "CURRENT", "READY"].includes(state)) return "text-emerald-300";
  if (["DEGRADED", "STALE", "EARLY_EVIDENCE", "PROVISIONAL"].includes(state)) return "text-amber-200";
  return "text-rose-300";
}

async function MarketHealthSection() {
  let m: Awaited<ReturnType<typeof import("@/lib/competitions/premier-league/market/health").buildMarketHealthReport>> | null =
    null;
  try {
    const { buildMarketHealthReport } = await import("@/lib/competitions/premier-league/market/health");
    m = await buildMarketHealthReport();
  } catch {
    m = null;
  }
  return (
    <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
      <h2 className="mb-3 font-semibold">Market data (observational)</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Separate from forecast health. Missing odds cannot block predictions.
      </p>
      {m ? (
        <ul className="space-y-1 text-muted-foreground">
          <li>
            Market health: <span className={tone(m.overall)}>{m.overall}</span>
          </li>
          <li>
            Market observer freshness: <span className={tone(m.freshness.status)}>{m.freshness.status}</span> · does not affect production forecasts
          </li>
          <li>Source configured: {m.source.configured ? "yes" : "no"} · {m.source.sport} · {m.source.region} · {m.source.market}</li>
          <li>Last success: {dash(m.lastSuccessAt)}</li>
          <li>Last failed: {dash(m.lastFailedAt)}</li>
          <li>Quota remaining: {dash(m.quotaRemaining)} · last cost {dash(m.lastRequestCost)}</li>
          <li>Observations: {dash(m.observationsStored)} · consensus {dash(m.consensusStored)} · bookmakers {dash(m.bookmakersObserved)}</li>
          <li>Next poll: {dash(m.nextScheduledPoll)}</li>
        </ul>
      ) : (
        <p className="text-muted-foreground">Market health unavailable.</p>
      )}
    </section>
  );
}

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

export default async function HealthPage() {
  await hydrateDurableOps();
  const h = buildHealthReport();

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Premier League production · operations
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Operational health</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Visible failures only. A missed stage is recorded as missed. Unverified results do not
          settle. Historical LIVE_OOS evidence is not rewritten.
        </p>
      </section>

      <section className="mx-auto mb-6 grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Production operations" value={h.overall} className={tone(h.overall)} />
        <Stat label="Structural data gate" value={h.season.dataReady} className={tone(h.season.dataReady)} />
        <Stat label="Scheduler liveness" value={h.scheduler.freshness.status} className={tone(h.scheduler.freshness.status)} />
        <Stat label="Forecast stage coverage" value={h.freshness.forecastCoverage.status} className={tone(h.freshness.forecastCoverage.status)} />
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-2 font-semibold">Scoped freshness truth</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">{h.freshness.note}</p>
        <ul className="mt-3 space-y-1 text-muted-foreground">
          <li>Scheduler liveness: <span className={tone(h.scheduler.freshness.status)}>{h.scheduler.freshness.status}</span> · last attempt {dash(h.scheduler.lastTickAt)} · last success {dash(h.scheduler.lastSuccessAt)}</li>
          <li>Fixture metadata sync: <span className={tone(h.fixtureSync.freshness.status)}>{h.fixtureSync.freshness.status}</span> · threshold {(h.fixtureSync.freshness.staleAfterMs / 3_600_000).toFixed(0)}h</li>
          <li>Upcoming fixture forecast coverage: <span className={tone(h.freshness.forecastCoverage.status)}>{h.freshness.forecastCoverage.status}</span> · current {h.freshness.forecastCoverage.current}/{h.freshness.forecastCoverage.totalFixtures} · missed {h.freshness.forecastCoverage.missed} · update due {h.freshness.forecastCoverage.updateDue}</li>
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-2 font-semibold">Reasons</h2>
        <ul className="min-w-0 list-disc space-y-1 break-all pl-5 text-muted-foreground">
          {h.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Season</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>Season: {h.season.label}</li>
          <li>Data version: {dash(h.season.dataVersion)}</li>
          <li>Season status: {dash(h.season.status)}</li>
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Fixture sync</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>Last attempt: {dash(h.fixtureSync.lastAttempt)}</li>
          <li>Last success: {dash(h.fixtureSync.lastSuccess)}</li>
          <li>Scoped freshness: {h.fixtureSync.freshness.status}</li>
          <li>Schedule revisions: {h.fixtureSync.revisionCount}</li>
          <li>
            Live sources:{" "}
            {h.fixtureSync.configuredLiveSources.length
              ? h.fixtureSync.configuredLiveSources.join(", ")
              : "none configured"}
          </li>
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Kickoff certainty</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>CONFIRMED: {h.kickoff.confirmed}</li>
          <li>DEFAULT: {h.kickoff.default}</li>
          <li>PROVISIONAL: {h.kickoff.provisional}</li>
          <li>TBD: {h.kickoff.tbd}</li>
          <li>Conflicts: {h.kickoff.conflict}</li>
          <li>
            Next confirmed:{" "}
            {h.kickoff.nextConfirmed
              ? `${h.kickoff.nextConfirmed.home} vs ${h.kickoff.nextConfirmed.away} · ${dash(h.kickoff.nextConfirmed.kickoffUtc)}`
              : "—"}
          </li>
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Prediction jobs</h2>
        <ul className="grid grid-cols-2 gap-1 text-muted-foreground sm:grid-cols-4">
          <li>active {h.scheduler.activeJobs}</li>
          <li>pending {h.scheduler.jobs.PENDING}</li>
          <li>eligible {h.scheduler.jobs.ELIGIBLE}</li>
          <li>succeeded {h.scheduler.jobs.SUCCEEDED}</li>
          <li>failed {h.scheduler.jobs.FAILED}</li>
          <li>missed {h.scheduler.jobs.MISSED}</li>
          <li>blocked {h.scheduler.jobs.BLOCKED}</li>
          <li>cancelled {h.scheduler.jobs.CANCELLED}</li>
          <li>running {h.scheduler.jobs.RUNNING}</li>
        </ul>
        <p className="mt-3 text-muted-foreground">
          Cadence {h.scheduler.cadenceMs / 60000} min. Scheduler liveness {h.scheduler.freshness.status}.
          {h.scheduler.host ? ` Host ${h.scheduler.host}.` : ""} Cancelled rows are historical
          ledger noise and are not active work. Next eligible job:{" "}
          {h.scheduler.nextJob
            ? `${h.scheduler.nextJob.stage} ${h.scheduler.nextJob.fixtureId} · ${h.scheduler.nextJob.certainty ?? "?"} · kickoff ${h.scheduler.nextJob.kickoff} · window ${h.scheduler.nextJob.eligibleFrom} → ${h.scheduler.nextJob.eligibleUntil} · target ${h.scheduler.nextJob.target}`
            : "—"}
        </p>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Prospective PIT evidence capture</h2>
        <ul className="min-w-0 space-y-1 break-all text-muted-foreground">
          <li>Status: <span className={tone(h.provenanceCapture.status)}>{h.provenanceCapture.status}</span></li>
          <li>Invariant: <span className="font-mono text-[11px]">{h.provenanceCapture.temporalRule}</span></li>
          {h.provenanceCapture.nextForecast ? <>
            <li>Next check: {h.provenanceCapture.nextForecast.stage} · {h.provenanceCapture.nextForecast.fixtureId} · cutoff {h.provenanceCapture.nextForecast.cutoffAt}</li>
            <li>Fixture revision: {dash(h.provenanceCapture.nextForecast.fixtureRevisionId)}</li>
            <li>Membership snapshot: {dash(h.provenanceCapture.nextForecast.seasonMembershipSnapshotId)}</li>
            <li>Model bundle: {dash(h.provenanceCapture.nextForecast.modelBundleId)}</li>
            <li>Rating state hash: {dash(h.provenanceCapture.nextForecast.ratingStateHash)}</li>
            <li>Application commit: {dash(h.provenanceCapture.nextForecast.applicationCommitSha)}</li>
            {h.provenanceCapture.nextForecast.reasons.length ? <li className="text-rose-200">Reason: {h.provenanceCapture.nextForecast.reasons.join("; ")}</li> : null}
          </> : null}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">{h.provenanceCapture.note}</p>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Sources and persistence</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>football-data.org: {h.sources.footballData ? "configured" : "not configured"}</li>
          <li>API-Football: {h.sources.apiFootball ? "configured" : "not configured"}</li>
          <li>Bundled official schedule baseline: loaded</li>
          <li>
            Store: {h.persistence.backend}
            {h.persistence.durable ? " · durable" : " · ephemeral"}
            {h.persistence.mongoConfigured ? " · mongo URI present" : ""}
          </li>
          <li>Last hydrate: {dash(h.persistence.lastHydratedAt)}</li>
          <li>Last flush: {dash(h.persistence.lastFlushAt)}</li>
        </ul>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="font-semibold">Canonical production ledger metrics</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          These are the same metric definitions used by Forecasts, Track Record, Production Ledger,
          and the public APIs. Snapshot counts and unique-fixture counts are never interchangeable.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-xs text-muted-foreground">
            <caption className="sr-only">Canonical LIVE_OOS health counts by model track</caption>
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                <th scope="col" className="py-2 pr-3 font-medium">Track</th>
                <th scope="col" className="py-2 pr-3 font-medium">Forecast snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Settled snapshots</th>
                <th scope="col" className="py-2 pr-3 font-medium">Unsettled snapshots</th>
                <th scope="col" className="py-2 font-medium">Unique fixtures with linked settlements</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Production", h.ledgerMetrics.production],
                ["Shadow", h.ledgerMetrics.shadow],
                ["All LIVE_OOS tracks", h.ledgerMetrics.allTracks],
              ].map(([label, row]) => {
                const track = row as typeof h.ledgerMetrics.production;
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
        <ul className="mt-4 space-y-1 text-muted-foreground">
          <li>
            Evaluation maturity {h.ledgerMetrics.evaluationMaturity.production.status} · valid independent evidence N={h.ledgerMetrics.evaluationMaturity.production.uniqueFixtureCount} fixtures
          </li>
          <li>
            Results last success {dash(h.results.lastSuccess)} · verified {h.results.verified} ·
            pending {h.results.pending} · conflict {h.results.conflict}
          </li>
          <li>
            Persisted settlement records {h.settlement.persistedSnapshotSettlementRecords} · linked
            to forecast snapshots {h.settlement.linkedForecastSnapshotRecords} · orphan records{" "}
            {h.settlement.orphanSettlementRecords} · inconsistent linked records{" "}
            {h.settlement.inconsistentLinkedSettlementRecords}
          </li>
          <li>
            Settlement operations/events: unavailable (no durable operation-event ledger) ·
            correction records {h.settlement.corrections}
          </li>
          <li>
            Rating state {h.ratings.modelVersion} · applied events {h.ratings.appliedEvents} · last{" "}
            {dash(h.ratings.lastFixtureId)}
          </li>
          <li>Last error: {dash(h.lastError)}</li>
        </ul>
      </section>

      <MarketHealthSection />

      {h.conflicts.length > 0 && (
        <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 text-sm">
          <h2 className="mb-3 font-semibold text-rose-200">Conflicts</h2>
          <ul className="space-y-2 text-muted-foreground">
            {h.conflicts.map((c) => (
              <li key={`${c.kind}:${c.fixtureId}`}>
                {c.kind} · {c.fixtureId} · {c.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mx-auto max-w-3xl text-sm text-muted-foreground">
        <Link href="/market" className="text-neon hover:underline">
          Market observations
        </Link>
        {" · "}
        <Link href="/live" className="text-neon hover:underline">
          Production ledger
        </Link>
        {" · "}
        <Link href="/" className="text-neon hover:underline">
          Forecasts
        </Link>
      </p>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-bold ${className ?? ""}`}>{value}</p>
    </div>
  );
}
