import type { Metadata } from "next";
import Link from "next/link";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import {
  buildMarketHealthReport,
  unavailableMarketHealthReport,
} from "@/lib/competitions/premier-league/market/health";
import {
  emptyMarketState,
  listLatestConsensus,
  loadMarketState,
} from "@/lib/competitions/premier-league/market/store";
import type { MarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import { productionMarketBenchmarkReport } from "@/lib/competitions/premier-league/market/benchmark-report";
import { marketQualityFlags } from "@/lib/competitions/premier-league/market/benchmark";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "External benchmark · Football Oracle",
  description: "Time-aligned production forecast versus recorded de-vigged bookmaker consensus.",
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default async function MarketPage() {
  await hydrateDurableOps();
  const [healthResult, stateResult, consensusResult, benchmarkResult] = await Promise.allSettled([
    buildMarketHealthReport(),
    loadMarketState(),
    listLatestConsensus(),
    productionMarketBenchmarkReport(),
  ]);
  const readDegraded = [healthResult, stateResult, consensusResult, benchmarkResult].some(
    (result) => result.status === "rejected"
  );
  if (readDegraded) {
    console.warn("[market] summary read degraded; serving an explicit bounded fallback");
  }
  const health: MarketHealthReport =
    healthResult.status === "fulfilled"
      ? healthResult.value
      : unavailableMarketHealthReport(
          new Date(),
          "market summary temporarily unavailable"
        );
  const state =
    stateResult.status === "fulfilled" ? stateResult.value : emptyMarketState();
  const consensus =
    consensusResult.status === "fulfilled" ? consensusResult.value : [];
  const benchmark =
    benchmarkResult.status === "fulfilled" ? benchmarkResult.value : null;
  const fixtures = liveFixtures();
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const rows = consensus.sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt));

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          External benchmark · observational only
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Model vs market evidence</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Football Oracle is compared only with bookmaker consensus recorded no later than the
          forecast&apos;s immutable cutoff. Odds are proportionally de-vigged per bookmaker, then the
          median is taken across books. Market data never enters the production model. This is not
          an edge, stake, or recommendation.
        </p>
      </section>

      <section className="mx-auto mb-8 grid max-w-3xl gap-3 sm:grid-cols-4">
        <Stat label="Market health" value={health.overall} />
        <Stat label="Observations" value={health.observationsStored === null ? "—" : String(health.observationsStored)} />
        <Stat label="Aligned fixtures" value={benchmark ? String(benchmark.counts.alignedUniqueFixtures) : "—"} />
        <Stat label="Settled aligned" value={benchmark ? String(benchmark.counts.settledAlignedUniqueFixtures) : "—"} />
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
        <h2 className="mb-2 font-semibold text-foreground">Evidence status: {benchmark?.status ?? "UNAVAILABLE"}</h2>
        <p>
          Canonical unit: one latest valid production snapshot per fixture. Temporal rule: market
          retrievedAt ≤ forecast cutoffAt &lt; kickoffUtc.
        </p>
        <p className="mt-2">
          {benchmark?.performance.reportingReason ??
            "Benchmark evidence could not be read. Production forecasts remain independent."}
        </p>
        {benchmark && benchmark.counts.productionSnapshotsRejected > 0 ? (
          <p className="mt-2 text-amber-300">
            {benchmark.counts.productionSnapshotsRejected} retained production snapshot(s) fail
            current temporal/stage validity and are excluded, not rewritten.
          </p>
        ) : null}
      </section>

      {benchmark && benchmark.pairs.length > 0 ? (
        <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
          <h2 className="mb-3 font-semibold">Time-aligned fixture pairs</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-muted-foreground">
              <caption className="sr-only">Time-aligned Football Oracle and bookmaker consensus pairs</caption>
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                  <th scope="col" className="py-2 pr-3 font-medium">Fixture / stage</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Oracle H/D/A</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Market H/D/A</th>
                  <th scope="col" className="py-2 font-medium">Alignment</th>
                </tr>
              </thead>
              <tbody>
                {benchmark.pairs.map((pair) => (
                  <tr key={pair.fixtureId} className="border-b border-white/5 align-top">
                    <td className="py-2 pr-3">
                      <span className="text-foreground">{pair.home} vs {pair.away}</span>
                      <br />{pair.forecast.stage} · {pair.forecast.cutoffAt.slice(0, 16)}Z
                    </td>
                    <td className="py-2 pr-3">{pct(pair.forecast.home)} / {pct(pair.forecast.draw)} / {pct(pair.forecast.away)}</td>
                    <td className="py-2 pr-3">{pct(pair.market.home)} / {pct(pair.market.draw)} / {pct(pair.market.away)} · n={pair.market.bookmakerCount}</td>
                    <td className="py-2">
                      market {Math.round(pair.market.lagToForecastCutoffMs / 60_000)}m before cutoff
                      {pair.market.qualityFlags.length ? <><br /><span className="text-amber-300">quality caution</span></> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
          No time-aligned model/market pair is currently publishable. This is a valid zero, not a
          missing-data estimate: the first market print may be later than the latest valid forecast
          cutoff, and invalid historical rolling snapshots are not relabelled.
        </section>
      )}

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
        {readDegraded ? (
          <p className="mb-2 text-amber-300">
            Market summary is temporarily degraded. Production forecasts are independent and
            remain available.
          </p>
        ) : null}
        <p>Source: {health.source.sport} · region {health.source.region} · {health.source.market}</p>
        <p>Configured: {health.source.configured ? "yes" : "no"}</p>
        <p>Last successful poll: {health.lastSuccessAt ?? "—"}</p>
        <p>First LIVE_RECORDED poll: {state.firstMarketObservationAt ?? "—"}</p>
        <p>Quota remaining: {health.quotaRemaining ?? "—"} · last cost {health.lastRequestCost ?? "—"}</p>
        <p>Schema: {health.schemaVersion}</p>
        <p>Quality caution: maximum contributing bookmaker margin above 25%; row retained.</p>
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Latest de-vigged consensus by fixture</h2>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">No LIVE_RECORDED consensus yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-muted-foreground">
              <caption className="sr-only">Latest observational bookmaker consensus by fixture</caption>
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                  <th scope="col" className="py-2 pr-3 font-medium">Fixture</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Books</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Fair H/D/A</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Margin</th>
                  <th scope="col" className="py-2 font-medium">Observed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const fx = fixtureById.get(c.canonicalFixtureId);
                  const label = fx
                    ? `${getClub(fx.homeSlug).name} vs ${getClub(fx.awaySlug).name}`
                    : c.canonicalFixtureId;
                  return (
                    <tr key={c.consensusId} className="border-b border-white/5">
                      <td className="py-2 pr-3">{label}</td>
                      <td className="py-2 pr-3">{c.bookmakerCount}</td>
                      <td className="py-2 pr-3">
                        {pct(c.fairHome)} / {pct(c.fairDraw)} / {pct(c.fairAway)}
                      </td>
                      <td className="py-2 pr-3">
                        {(c.marginMin * 100).toFixed(1)}–{(c.marginMax * 100).toFixed(1)}%
                        {marketQualityFlags(c).length ? <span className="ml-1 text-amber-300">caution</span> : null}
                      </td>
                      <td className="py-2">{c.retrievedAt.slice(0, 16)}Z</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mx-auto max-w-3xl text-xs text-muted-foreground">
        <Link href="/live" className="text-neon hover:underline">
          Production ledger
        </Link>
        {" · "}
        <Link href="/health" className="text-neon hover:underline">
          Health
        </Link>
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
