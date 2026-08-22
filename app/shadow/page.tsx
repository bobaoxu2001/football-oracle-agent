import type { Metadata } from "next";
import Link from "next/link";
import { shadowEvaluationReport } from "@/lib/competitions/premier-league/shadow/report";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shadow model evaluation · Football Oracle",
  description:
    "Paired forward out-of-sample comparison of the production Premier League model against an experimental challenger.",
};

export default async function ShadowPage() {
  await hydrateDurableOps();
  const report = shadowEvaluationReport(PREMIER_LEAGUE_CURRENT_SEASON);

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {report.season} · paired forward evaluation
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Baseline vs shadow</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Production serves <span className="text-foreground">{report.servingVersion}</span> and
          always will until a promotion is decided deliberately. The challenger{" "}
          <span className="text-foreground">{report.shadowVersion}</span> is frozen alongside it
          before every kickoff and settled against the same result, so the two accumulate genuinely
          paired out-of-sample evidence.
        </p>
        <p className="mt-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs text-amber-100/90">
          This page exists to test whether current-season evidence adds signal. It does not assume
          that it does. A difference in either direction at this sample size is noise.
        </p>
      </section>

      <section className="mx-auto mb-8 grid max-w-3xl gap-3 sm:grid-cols-4">
        <Stat label="Baseline frozen" value={String(report.frozenBaselineSnapshots)} />
        <Stat label="Shadow frozen" value={String(report.frozenShadowSnapshots)} />
        <Stat label="Paired evidence" value={String(report.collection.pairedEvidence)} />
        <Stat label="Shadow freezing" value={report.shadowEnabled ? "ON" : "OFF"} />
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-2 font-semibold">Collection status</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          A frozen pair is both models written at the same cutoff. A settled pair is both scored
          against the same result. Paired evidence is a settled pair that still resolves to those
          frozen snapshots. Unsettled frozen pairs and live previews are not evidence.
        </p>
        {report.collection.neverFrozenInProduction ? (
          <p className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs text-amber-100/90">
            No successful production shadow freeze has been recorded yet. Collection has not started.
          </p>
        ) : null}
        <dl className="grid gap-2 sm:grid-cols-2 text-xs">
          <Line label="Baseline version" value={report.baselineVersion} />
          <Line label="Challenger version" value={report.shadowVersion} />
          <Line label="Freezing" value={report.collection.freezingEnabled ? "ON" : "OFF"} />
          <Line
            label="Last successful shadow freeze"
            value={report.collection.lastSuccessfulShadowFreezeAt ?? "never"}
          />
          <Line label="Last ops tick" value={report.collection.lastOpsTickAt ?? "never"} />
          <Line
            label="Last shadow lifecycle error"
            value={report.collection.lastShadowLifecycleError ?? "none"}
          />
          <Line label="Frozen pairs" value={String(report.collection.frozenPairs)} />
          <Line label="Settled pairs" value={String(report.collection.settledPairs)} />
          <Line label="Paired evidence n" value={String(report.collection.pairedEvidence)} />
          <Line label="Unpaired baseline-only" value={String(report.collection.unpairedBaselineOnly)} />
          <Line
            label="Orphan shadow settlements"
            value={String(report.collection.orphanShadowSettlements)}
          />
          <Line
            label="Orphan shadow snapshots"
            value={String(report.collection.orphanShadowSnapshots)}
          />
          <Line label="Duplicate identities" value={String(report.collection.duplicateIdentities)} />
          <Line label="Cutoff mismatches" value={String(report.collection.cutoffMismatches)} />
          <Line
            label="Missed shadow freeze windows"
            value={String(report.collection.missedShadowFreezeWindows)}
          />
          <Line
            label="Metrics display floor"
            value={`${report.promotion.minForDisplay} paired evidence`}
          />
          <Line
            label="Promotion consideration floor"
            value={`${report.promotion.minForDecision} paired evidence`}
          />
          <Line
            label="Headline metrics"
            value={report.promotion.metricsVisible ? "visible" : "withheld"}
          />
          <Line
            label="Integrity"
            value={
              report.integrity.ok
                ? report.integrity.issues.length
                  ? `OK · ${report.integrity.issues.length} note${report.integrity.issues.length === 1 ? "" : "s"}`
                  : "OK"
                : `FAIL (${report.integrity.issues.length})`
            }
          />
        </dl>
        {report.collection.nextEligible.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Next eligible freezes
            </h3>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {report.collection.nextEligible.map((j) => (
                <li key={`${j.fixtureId}-${j.stage}-${j.plannedAsOf}`}>
                  <span className="text-foreground">{j.fixtureId}</span> · {j.stage} · {j.status} ·
                  eligible {j.eligibleFrom.replace("T", " ").slice(0, 16)} UTC
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">No pending or eligible timed freeze jobs.</p>
        )}
        {report.integrity.issues.length > 0 ? (
          <ul className="mt-4 space-y-1 text-xs text-amber-100/90">
            {report.integrity.issues.slice(0, 8).map((issue, i) => (
              <li key={`${issue.code}-${i}`}>
                {issue.code}: {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-3 font-semibold">Paired metrics</h2>
        <p className="mb-4 text-amber-200/90">{report.sampleNote}</p>
        {report.metrics ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-muted-foreground">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                  <th className="py-2 pr-3 font-medium">Metric</th>
                  <th className="py-2 pr-3 font-medium">Baseline</th>
                  <th className="py-2 pr-3 font-medium">Shadow</th>
                  <th className="py-2 font-medium">Δ (shadow − baseline)</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow
                  label="Brier"
                  a={report.metrics.baseline.brier}
                  b={report.metrics.shadow.brier}
                  d={report.metrics.delta.brier}
                />
                <MetricRow
                  label="RPS"
                  a={report.metrics.baseline.rps}
                  b={report.metrics.shadow.rps}
                  d={report.metrics.delta.rps}
                />
                <MetricRow
                  label="LogLoss"
                  a={report.metrics.baseline.logLoss}
                  b={report.metrics.shadow.logLoss}
                  d={report.metrics.delta.logLoss}
                />
                <MetricRow
                  label="Top-pick accuracy (descriptive)"
                  a={report.metrics.baseline.topPickAccuracy}
                  b={report.metrics.shadow.topPickAccuracy}
                  d={null}
                />
              </tbody>
            </table>
            <p className="mt-3 text-[10px]">
              Negative Δ means the shadow scored better on that proper score. Top-pick accuracy is
              descriptive only and is never a promotion criterion.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">
            Headline metrics are withheld until {report.promotion.minForDisplay} paired settlements
            exist. Reporting a Brier delta over {report.pairedSettlements}{" "}
            {report.pairedSettlements === 1 ? "match" : "matches"} would invite exactly the
            conclusion this evaluation is designed to avoid.
          </p>
        )}
      </section>

      {report.recentPairs.length > 0 && (
        <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
          <h2 className="mb-3 font-semibold">Recent paired settlements</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-muted-foreground">
              <thead>
                <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em]">
                  <th className="py-2 pr-3 font-medium">Fixture</th>
                  <th className="py-2 pr-3 font-medium">Stage</th>
                  <th className="py-2 pr-3 font-medium">Result</th>
                  <th className="py-2 pr-3 font-medium">Base Brier</th>
                  <th className="py-2 pr-3 font-medium">Shadow Brier</th>
                  <th className="py-2 font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {report.recentPairs.map((p) => (
                  <tr key={`${p.fixtureId}-${p.predictionStage}`} className="border-b border-white/5">
                    <td className="py-1.5 pr-3 text-foreground">{p.fixtureId}</td>
                    <td className="py-1.5 pr-3">{p.predictionStage}</td>
                    <td className="py-1.5 pr-3 uppercase">{p.actualOutcome}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.baseline.brier.toFixed(4)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{p.shadow.brier.toFixed(4)}</td>
                    <td className="py-1.5 tabular-nums">{signed(p.delta.brier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
        <h2 className="mb-2 font-semibold">Promotion gate — {report.promotion.status}</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Metric visibility and promotion eligibility are different thresholds: headline metrics
          appear at {report.promotion.minForDisplay} paired evidence rows; a human may consider
          promotion only at {report.promotion.minForDecision}. UNDER_OBSERVATION is not promotion.
          Production continues to serve {report.servingVersion}.
        </p>
        <p className="mb-3 text-xs text-muted-foreground">{report.promotion.note}</p>
        {report.promotion.reasons.length > 0 ? (
          <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
            {report.promotion.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {report.promotion.criteria.map((c) => (
            <li key={c.key} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neon/60" />
              <span>
                <span className="text-foreground">{c.requirement}</span> — {c.rationale}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-3xl text-sm">
        <p className="text-xs text-muted-foreground">
          Unpaired settlements are excluded from every average: baseline-only{" "}
          {report.baselineOnlySettlements}, shadow-only {report.shadowOnlySettlements}, rejected for
          disagreeing on the actual result {report.inconsistentPairs}.
        </p>
        <p className="mt-4">
          <Link href="/live" className="text-neon hover:underline">
            ← Live ledger
          </Link>
        </p>
      </section>
    </div>
  );
}

function MetricRow({
  label,
  a,
  b,
  d,
}: {
  label: string;
  a: number | null;
  b: number | null;
  d: number | null;
}) {
  return (
    <tr className="border-b border-white/5">
      <td className="py-1.5 pr-3 text-foreground">{label}</td>
      <td className="py-1.5 pr-3 tabular-nums">{a === null ? "—" : a.toFixed(4)}</td>
      <td className="py-1.5 pr-3 tabular-nums">{b === null ? "—" : b.toFixed(4)}</td>
      <td className="py-1.5 tabular-nums">{d === null ? "—" : signed(d)}</td>
    </tr>
  );
}

function signed(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
