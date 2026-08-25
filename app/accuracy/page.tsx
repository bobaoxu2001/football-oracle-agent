import type { Metadata } from "next";
import { Target, TrendingUp, Gauge, CheckCircle2, Layers, ShieldCheck } from "lucide-react";
import { computeTrackRecord, type VariantKey } from "@/lib/prediction-engine/trackRecord";
import { loadDcReport } from "@/lib/prediction-engine/dcReport";
import { MatchLog } from "@/components/accuracy/match-log";
import { livePerformanceReport } from "@/lib/competitions/premier-league/live-ledger";
import { shadowEvaluationReport } from "@/lib/competitions/premier-league/shadow/report";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { PREMIER_LEAGUE_CURRENT_SEASON } from "@/lib/competitions/premier-league/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Track Record · Football Oracle",
  description:
    "Production Premier League evidence, shadow evaluation and World Cup reconstruction shown as separate tracks.",
};

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const signedPct = (x: number, d = 0) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

const VARIANT_LABEL: Record<VariantKey, string> = {
  unif: "Uniform 1⁄3 (baseline)",
  base: "Calibrated Elo",
  old: "+ result learning + form",
  full: "+ injuries + tactics + bounce",
  drawFlat: "+ flat draw boost",
  "full+draw": "+ smart draw layer",
  "+cal": "+ confidence calibration (LIVE)",
};

export default async function AccuracyPage() {
  await hydrateDurableOps();
  const production = livePerformanceReport("LIVE_OOS", PREMIER_LEAGUE_CURRENT_SEASON);
  const shadow = shadowEvaluationReport(PREMIER_LEAGUE_CURRENT_SEASON);
  const track = computeTrackRecord();
  const dc = loadDcReport();
  const live = track.variants["+cal"];
  const base = track.variants.base;

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-4xl text-center">
        <div className="chip mx-auto mb-4 w-fit"><ShieldCheck className="h-3.5 w-3.5 text-neon" /> Evidence tracks kept separate</div>
        <h1 className="text-balance text-3xl font-black tracking-tight sm:text-5xl">Track record, <span className="neon-text">without mixing evidence.</span></h1>
        <p className="mx-auto mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">Premier League production snapshots, experimental shadow pairs and historical World Cup reconstruction answer different questions. They are never pooled into one headline accuracy claim.</p>
      </section>
      <section className="mx-auto mb-12 grid max-w-5xl gap-4 md:grid-cols-3">
        <EvidenceCard label="Premier League production" value={`${production.nSettled} settled`} status={production.brier === null ? "Metrics withheld" : `RPS ${production.rps?.toFixed(3)}`} copy={`${production.nPredictions} immutable LIVE_OOS snapshots. ${production.sampleNote}`} href="/live" />
        <EvidenceCard label="Shadow challenger" value={`${shadow.collection.pairedEvidence} paired`} status={shadow.promotion.status} copy={shadow.sampleNote} href="/shadow" />
        <EvidenceCard label="World Cup reconstruction" value={`${track.nMatches} matches`} status="Historical only" copy="Walk-forward chronology is enforced inside a completed dataset, but forecasts were not proven frozen and served live before every kickoff." href="#world-cup-reconstruction" />
      </section>
      {/* hero */}
      <section id="world-cup-reconstruction" className="mx-auto mb-8 max-w-3xl text-center scroll-mt-24">
        <div className="chip mx-auto mb-4 w-fit">
          <Layers className="h-3.5 w-3.5 text-neon" />
          Historical reconstruction track
        </div>
        <h2 className="text-balance text-3xl font-black tracking-tight sm:text-4xl">
          World Cup <span className="neon-text">walk-forward audit</span>
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-pretty text-sm text-muted-foreground sm:text-base">
          Every completed 2026 World Cup match is recomputed using{" "}
          <strong className="text-foreground">only the results before it</strong> — never its own
          outcome. That blocks direct target leakage inside the reconstruction, but it does not turn
          a post-tournament dataset into a live frozen forecast ledger. Scored on{" "}
          <strong className="text-foreground">{track.nMatches} matches</strong> through{" "}
          {track.asOf || "—"}.
        </p>
      </section>

      {/* headline metric cards */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={<Target className="h-4 w-4 text-neon" />}
          label="Top-pick accuracy"
          value={pct(live.topPickAcc)}
          sub={`${live.hits} / ${track.nMatches} outcomes called right`}
        />
        <MetricCard
          icon={<TrendingUp className="h-4 w-4 text-neon" />}
          label="RPS skill vs coin-flip"
          value={signedPct(track.skill.rpsSkill, 1)}
          sub="Ranked Probability Score beats a no-information 1⁄3 forecast"
        />
        <MetricCard
          icon={<Gauge className="h-4 w-4 text-neon" />}
          label="Calibration error"
          value={pct(track.calibration.ece, 1)}
          sub="ECE — how close stated confidence is to reality (lower is better)"
        />
        <MetricCard
          icon={<CheckCircle2 className="h-4 w-4 text-neon" />}
          label="Draws predicted"
          value={pct(live.avgDrawPred)}
          sub={`vs ${pct(track.actualDraws / track.nMatches)} actual draw rate`}
        />
      </section>

      {/* two-model agreement */}
      {dc ? (
        <section className="mb-8">
          <div className="glass rounded-2xl p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2">
              <Layers className="h-4 w-4 text-neon" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-neon">
                Two retrospective models agree
              </h2>
            </div>
            <p className="mb-5 max-w-3xl text-sm text-muted-foreground">
              The live engine is an <strong className="text-foreground">Elo → Dixon-Coles → Monte
              Carlo</strong> stack in TypeScript. A completely separate{" "}
              <strong className="text-foreground">ridge Dixon-Coles</strong> bivariate-Poisson model
              (Python, refit nightly) is leave-one-out scored on the same fixtures. When two models
              built differently land near the same walk-forward score, it is a useful consistency
              check—not proof that either forecast was served live before kickoff.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <ModelCard
                title="Live TypeScript engine"
                subtitle="Walk-forward reconstruction · full stack"
                rows={[
                  ["RPS skill vs baseline", signedPct(track.skill.rpsSkill, 1)],
                  ["Top-pick accuracy", pct(live.topPickAcc)],
                  ["Calibration (ECE)", pct(track.calibration.ece, 1)],
                  ["Matches graded", String(track.nMatches)],
                ]}
              />
              <ModelCard
                title="Ridge Dixon-Coles"
                subtitle="Independent · leave-one-out"
                rows={[
                  ["RPS skill vs baseline", signedPct(dc.loo.rpsSkill, 1)],
                  ["Top-pick accuracy", pct(dc.loo.topAcc)],
                  ["Calibration (ECE)", pct(dc.loo.ece, 1)],
                  ["Matches fit", String(dc.nMatches)],
                ]}
              />
            </div>
          </div>
        </section>
      ) : null}

      {/* what each layer adds */}
      <section className="mb-8">
        <div className="glass rounded-2xl p-5 sm:p-6">
          <div className="mb-1 flex items-center gap-2">
            <Layers className="h-4 w-4 text-neon" />
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-neon">
              What each engine layer earns
            </h2>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Cumulative variants, each adding one layer. Lower RPS is better — this is why the agent is
            a pipeline, not a single number.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Model variant</th>
                  <th className="py-2 px-3 text-right font-medium">RPS ↓</th>
                  <th className="py-2 px-3 text-right font-medium">Brier ↓</th>
                  <th className="py-2 pl-3 text-right font-medium">Top pick</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(VARIANT_LABEL) as VariantKey[]).map((k) => {
                    const v = track.variants[k];
                    const isLive = k === "+cal";
                    return (
                      <tr
                        key={k}
                        className={
                          "border-b border-white/5 " +
                          (isLive ? "bg-neon/[0.06]" : "")
                        }
                      >
                        <td className="py-2 pr-3">
                          <span className={isLive ? "font-semibold text-neon" : "text-foreground/85"}>
                            {VARIANT_LABEL[k]}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{v.rps.toFixed(3)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                          {v.brier.toFixed(3)}
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums">{pct(v.topPickAcc)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            The live stack cuts RPS from {base.rps.toFixed(3)} (plain Elo) to{" "}
            <span className="text-foreground">{live.rps.toFixed(3)}</span> — a{" "}
            {signedPct((base.rps - live.rps) / base.rps, 0)} improvement from the agent&apos;s
            learning, tactical and calibration layers.
          </p>
        </div>
      </section>

      {/* calibration + match log */}
      <section className="grid gap-6 lg:grid-cols-5">
        {/* calibration */}
        <div className="lg:col-span-2">
          <div className="glass h-full rounded-2xl p-5 sm:p-6">
            <div className="mb-1 flex items-center gap-2">
              <Gauge className="h-4 w-4 text-neon" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-neon">
                Is it honestly confident?
              </h2>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              When the live model says an outcome is X% likely, does it happen ~X% of the time?
              Closer columns = better-calibrated probabilities.
            </p>
            <div className="space-y-3">
              {track.calibration.bins.map((b) => (
                <div key={b.label}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground/85">
                      Said {b.label}
                      <span className="ml-1.5 text-muted-foreground">· {b.n} calls</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      happened {pct(b.observed)}
                    </span>
                  </div>
                  <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-neon/40"
                      style={{ width: `${Math.max(b.meanPred * 100, 1)}%` }}
                      title={`predicted ${pct(b.meanPred)}`}
                    />
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-neon shadow-glow"
                      style={{ width: `${Math.max(b.observed * 100, 1)}%`, opacity: 0.85 }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Expected Calibration Error:{" "}
              <span className="font-semibold text-foreground">{pct(track.calibration.ece, 1)}</span>{" "}
              (0% = perfect). Faint bar = predicted, bright bar = observed.
            </p>
          </div>
        </div>

        {/* match log */}
        <div className="lg:col-span-3">
          <div className="glass h-full rounded-2xl p-5 sm:p-6">
            <div className="mb-1 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-neon" />
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-neon">
                Every call, on the record
              </h2>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              The pre-match favourite and confidence for each graded fixture, with the actual result.
              Filter to the misses — they&apos;re shown, not hidden.
            </p>
            <MatchLog matches={track.matches} />
          </div>
        </div>
      </section>

      <p className="mx-auto mt-8 max-w-3xl text-center text-xs text-muted-foreground">
        Numbers recompute from the results file on every load. RPS (Ranked Probability Score) is the
        football-forecasting standard — it rewards getting the home → draw → away order right, not
        just the exact bucket. Chronology is enforced within this historical reconstruction; it remains separate from the frozen Premier League production ledger.
      </p>
    </div>
  );
}

function EvidenceCard({ label, value, status, copy, href }: { label: string; value: string; status: string; copy: string; href: string }) {
  return <a href={href} className="glass glass-hover block p-5 text-left"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neon">{label}</p><p className="mt-3 text-2xl font-black tabular-nums">{value}</p><p className="mt-1 text-xs font-semibold text-foreground/85">{status}</p><p className="mt-3 line-clamp-4 text-xs leading-relaxed text-muted-foreground">{copy}</p><span className="mt-4 inline-block text-xs font-semibold text-neon">Inspect track →</span></a>;
}

function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-neon">
          {label}
        </span>
      </div>
      <p className="text-3xl font-black tabular-nums tracking-tight">{value}</p>
      <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{sub}</p>
    </div>
  );
}

function ModelCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: [string, string][];
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <p className="text-sm font-bold">{title}</p>
      <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
