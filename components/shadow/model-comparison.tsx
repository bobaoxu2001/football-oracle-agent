import type { FixtureComparison } from "@/lib/competitions/premier-league/shadow/compare";

/**
 * Baseline vs shadow comparison.
 *
 * The shadow is labelled EXPERIMENTAL everywhere it appears and the serving
 * model is stated explicitly, so no reader can mistake the challenger for what
 * the product actually predicts. No language here implies the shadow is better.
 */
export function ModelComparison({ comparison }: { comparison: FixtureComparison }) {
  const { baseline, shadow, delta, evidence, explanation } = comparison;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Baseline vs shadow</h2>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200">
          Shadow is experimental
        </span>
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Production serves <span className="text-foreground">{comparison.servingVersion}</span>. The
        shadow model is a challenger under evaluation — it is never served, and a difference here is
        not evidence that either model is better.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-white/10 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Model</th>
              <th className="py-2 pr-3 font-medium">Home</th>
              <th className="py-2 pr-3 font-medium">Draw</th>
              <th className="py-2 pr-3 font-medium">Away</th>
              <th className="py-2 font-medium">Frozen at</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            <Row
              label={`Baseline — ${baseline.modelVersion}`}
              side={baseline}
              emphasis
            />
            <Row label={`Shadow — ${shadow.modelVersion}`} side={shadow} />
            <tr className="border-b border-white/5">
              <td className="py-1.5 pr-3 text-foreground">Difference</td>
              <td className="py-1.5 pr-3 tabular-nums">{signedPp(delta.homePp)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{signedPp(delta.drawPp)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{signedPp(delta.awayPp)}</td>
              <td className="py-1.5 text-[10px]">
                {comparison.pairedAndFrozen ? "paired · frozen" : "preview · not frozen"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] text-muted-foreground">{comparison.note}</p>

      {/* ── Current-season evidence ── */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {[evidence.home, evidence.away].map((e) => (
          <div key={e.teamSlug} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {e.teamName} — current-season evidence
            </h3>
            {e.matchesPlayed === 0 ? (
              <p className="text-muted-foreground">
                No admissible 2026-27 result at this cutoff. The shadow uses the prior only, so it
                matches the baseline exactly for this side.
              </p>
            ) : (
              <dl className="space-y-1">
                <Line label="Matches" value={String(e.matchesPlayed)} />
                {e.latest && <Line label="Latest" value={e.latest} />}
                <Line
                  label="Goals for / expected"
                  value={`${e.goalsFor} / ${e.expectedGoalsFor.toFixed(2)}`}
                />
                <Line
                  label="Goals against / expected"
                  value={`${e.goalsAgainst} / ${e.expectedGoalsAgainst.toFixed(2)}`}
                />
                <Line label="Attack ×" value={e.attackMultiplier.toFixed(3)} />
                <Line label="Concede ×" value={e.defenceMultiplier.toFixed(3)} />
                <Line
                  label="Current-season weight"
                  value={e.currentSeasonWeight.toFixed(3)}
                />
              </dl>
            )}
          </div>
        ))}
      </div>

      {/* ── Deterministic explanation ── */}
      <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Why the probability moved
        </h3>
        <p className="mb-2 text-xs text-foreground">{explanation.headline}</p>
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {explanation.reasons.map((r) => (
            <li key={r.code} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neon/60" />
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Derived deterministically from the model and feature deltas above. No language model is
          involved in producing this explanation.
        </p>
      </div>
    </section>
  );
}

function Row({
  label,
  side,
  emphasis,
}: {
  label: string;
  side: FixtureComparison["baseline"];
  emphasis?: boolean;
}) {
  return (
    <tr className="border-b border-white/5">
      <td className={emphasis ? "py-1.5 pr-3 font-semibold text-foreground" : "py-1.5 pr-3 text-foreground"}>
        {label}
      </td>
      <td className="py-1.5 pr-3 tabular-nums">{pct(side.home)}</td>
      <td className="py-1.5 pr-3 tabular-nums">{pct(side.draw)}</td>
      <td className="py-1.5 pr-3 tabular-nums">{pct(side.away)}</td>
      <td className="py-1.5 text-[10px]">
        {side.frozen ? `${side.asOf.replace("T", " ").slice(0, 16)} UTC` : "not frozen"}
        {side.predictionStage ? ` · ${side.predictionStage}` : ""}
      </td>
    </tr>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function signedPp(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)} pp`;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
