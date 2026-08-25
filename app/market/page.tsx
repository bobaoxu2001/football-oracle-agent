import type { Metadata } from "next";
import Link from "next/link";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { buildMarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import {
  emptyMarketState,
  listLatestConsensus,
  loadMarketState,
} from "@/lib/competitions/premier-league/market/store";
import type { MarketHealthReport } from "@/lib/competitions/premier-league/market/health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Market observations · Football Oracle",
  description: "Recorded 1X2 market-implied fair probabilities. Not a betting recommendation.",
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default async function MarketPage() {
  await hydrateDurableOps();
  const [healthResult, stateResult, consensusResult] = await Promise.allSettled([
    buildMarketHealthReport(),
    loadMarketState(),
    listLatestConsensus(),
  ]);
  const readDegraded = [healthResult, stateResult, consensusResult].some(
    (result) => result.status === "rejected"
  );
  if (readDegraded) {
    console.warn("[market] summary read degraded; serving an explicit bounded fallback");
  }
  const health: MarketHealthReport =
    healthResult.status === "fulfilled"
      ? healthResult.value
      : {
          overall: "DEGRADED",
          reasons: ["market summary temporarily unavailable"],
          source: {
            id: "the-odds-api",
            configured: false,
            region: "uk",
            sport: "soccer_epl",
            market: "h2h",
          },
          lastSuccessAt: null,
          lastFailedAt: null,
          lastError: "market summary temporarily unavailable",
          quotaRemaining: null,
          quotaUsed: null,
          lastRequestCost: null,
          nextScheduledPoll: null,
          currentCadenceMs: null,
          eventsHint: "summary unavailable",
          fixturesMatched: 0,
          unmatched: 0,
          ambiguous: 0,
          bookmakersObserved: 0,
          observationsStored: 0,
          consensusStored: 0,
          firstMarketObservationAt: null,
          schemaVersion: "market-recorder-v0.1.0",
        };
  const state =
    stateResult.status === "fulfilled" ? stateResult.value : emptyMarketState();
  const consensus =
    consensusResult.status === "fulfilled" ? consensusResult.value : [];
  const fixtures = liveFixtures();
  const rows = consensus.sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt));

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Market observations · external benchmark data
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Recorded market 1X2</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Market-implied fair probabilities from bookmaker decimal odds after proportional de-vig.
          These observations are never production-model inputs. Model-vs-market evaluation is not
          implemented in Phase 4A; this is not an edge, a stake, or a recommendation.
        </p>
      </section>

      <section className="mx-auto mb-8 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Stat label="Market health" value={health.overall} />
        <Stat label="Observations" value={String(health.observationsStored)} />
        <Stat label="Last poll" value={health.lastSuccessAt ? health.lastSuccessAt.slice(0, 16) : "—"} />
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-muted-foreground">
        {readDegraded ? (
          <p className="mb-2 text-amber-300">
            Market summary is temporarily degraded. Production forecasts are independent and
            remain available.
          </p>
        ) : null}
        <p>Source: {health.source.sport} · region {health.source.region} · {health.source.market}</p>
        <p>Configured: {health.source.configured ? "yes" : "no"}</p>
        <p>First LIVE_RECORDED poll: {state.firstMarketObservationAt ?? "—"}</p>
        <p>Quota remaining: {health.quotaRemaining ?? "—"} · last cost {health.lastRequestCost ?? "—"}</p>
        <p>Schema: {health.schemaVersion}</p>
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
                  const fx = fixtures.find((f) => f.id === c.canonicalFixtureId);
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
