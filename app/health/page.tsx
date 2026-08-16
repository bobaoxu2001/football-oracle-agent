import type { Metadata } from "next";
import Link from "next/link";
import { buildHealthReport } from "@/lib/competitions/premier-league/ops/health";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operational health · Football Oracle",
  description: "Live-season operations: sync, jobs, results, settlement, ratings.",
};

function tone(state: string): string {
  if (state === "HEALTHY" || state === "DATA_READY") return "text-emerald-300";
  if (state === "DEGRADED") return "text-amber-200";
  return "text-rose-300";
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
          Phase 2A.2 · operations
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Operational health</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Visible failures only. A missed stage is recorded as missed. Unverified results do not
          settle. Historical LIVE_OOS evidence is not rewritten.
        </p>
      </section>

      <section className="mx-auto mb-6 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Stat label="Overall" value={h.overall} className={tone(h.overall)} />
        <Stat label="DATA_READY" value={h.season.dataReady} className={tone(h.season.dataReady)} />
        <Stat label="Last tick" value={dash(h.scheduler.lastTickAt?.slice(0, 19) ?? null)} />
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-2 font-semibold">Reasons</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
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
          <li>Stale: {h.fixtureSync.stale ? "yes" : "no"}</li>
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
          Cadence {h.scheduler.cadenceMs / 60000} min. Freshness {h.scheduler.freshness}.
          {h.scheduler.host ? ` Host ${h.scheduler.host}.` : ""} Cancelled rows are historical
          ledger noise and are not active work. Next eligible job:{" "}
          {h.scheduler.nextJob
            ? `${h.scheduler.nextJob.stage} ${h.scheduler.nextJob.fixtureId} · ${h.scheduler.nextJob.certainty ?? "?"} · kickoff ${h.scheduler.nextJob.kickoff} · window ${h.scheduler.nextJob.eligibleFrom} → ${h.scheduler.nextJob.eligibleUntil} · target ${h.scheduler.nextJob.target}`
            : "—"}
        </p>
      </section>

      <section className="mx-auto mb-6 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Sources and persistence</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>football-data.org: {h.sources.footballData ? "configured" : "not configured"}</li>
          <li>API-Football: {h.sources.apiFootball ? "configured" : "not configured"}</li>
          <li>Official baseline: yes</li>
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
        <h2 className="mb-3 font-semibold">LIVE_OOS / results / ratings</h2>
        <ul className="space-y-1 text-muted-foreground">
          <li>
            LIVE_OOS total {h.liveOos.total} · settled {h.liveOos.settled} · unsettled{" "}
            {h.liveOos.unsettled} · committed {h.liveOos.committed} · operational{" "}
            {h.liveOos.operational}
          </li>
          <li>
            Results last success {dash(h.results.lastSuccess)} · verified {h.results.verified} ·
            pending {h.results.pending} · conflict {h.results.conflict}
          </li>
          <li>
            Settlement succeeded {h.settlement.succeeded} · pending/conflict{" "}
            {h.settlement.pendingOrConflict} · corrections {h.settlement.corrections}
          </li>
          <li>
            Rating state {h.ratings.modelVersion} · applied events {h.ratings.appliedEvents} · last{" "}
            {dash(h.ratings.lastFixtureId)}
          </li>
          <li>Last error: {dash(h.lastError)}</li>
        </ul>
      </section>

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
        <Link href="/live" className="text-neon hover:underline">
          Live ledger
        </Link>
        {" · "}
        <Link href="/" className="text-neon hover:underline">
          Agent
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
