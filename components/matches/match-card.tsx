import Link from "next/link";
import type { SerializedMatch } from "@/lib/match-ledger/serialize";

/**
 * One completed match, expandable to its recorded detail.
 *
 * Uses a native <details> element: expansion works without client JavaScript
 * and is keyboard/screen-reader accessible by default.
 *
 * DISPLAY HONESTY. Only statistics present in `match.statistics` are rendered.
 * Everything the source does not supply is listed once, by name, as
 * unavailable — never drawn as a 0, which would read as a real measurement.
 */
export function MatchCard({ match }: { match: SerializedMatch }) {
  const ft = match.score.fullTime;
  const ht = match.score.halfTime;
  const p = match.prediction;

  return (
    <details className="group rounded-2xl border border-white/10 bg-white/[0.03] transition hover:border-white/20">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 text-sm">
        <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {(match.kickoffUtc ?? "").slice(5, 10) || "—"}
        </span>
        <span className="flex-1 text-right font-medium">{match.home.name}</span>
        <span className="shrink-0 rounded-lg bg-white/[0.06] px-2.5 py-1 font-bold tabular-nums">
          {ft.home}–{ft.away}
        </span>
        <span className="flex-1 font-medium">{match.away.name}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {p?.settled ? "settled" : p ? "predicted" : ""}
        </span>
        <span className="shrink-0 text-muted-foreground transition group-open:rotate-90">›</span>
      </summary>

      <div className="border-t border-white/5 p-4 pt-3 text-xs">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* ── Recorded match data ── */}
          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Recorded data
            </h3>
            <dl className="space-y-1">
              <Row label="Full time" value={`${ft.home} – ${ft.away}`} />
              {ht.home !== null && ht.away !== null && (
                <Row label="Half time" value={`${ht.home} – ${ht.away}`} />
              )}
              <Row label="Result" value={match.result ?? "—"} />
              {match.matchday !== null && <Row label="Matchweek" value={String(match.matchday)} />}
              {match.kickoffUtc && (
                <Row label="Kickoff" value={`${match.kickoffUtc.replace("T", " ").slice(0, 16)} UTC`} />
              )}
              {match.statistics.map((s) => (
                <Row
                  key={s.key}
                  label={s.label}
                  value={`${s.home}${s.unit ?? ""} – ${s.away}${s.unit ?? ""}`}
                />
              ))}
            </dl>
            {match.statistics.length > 0 && match.statisticsSource && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Statistics source: {match.statisticsSource}
              </p>
            )}
            {match.unavailableStatistics.length > 0 && (
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                <span className="text-foreground/70">Not recorded for this match:</span>{" "}
                {match.unavailableStatistics.join(", ")}. The result source does not publish these,
                and they are left empty rather than shown as zero.
              </p>
            )}
          </div>

          {/* ── Frozen pre-kickoff forecast ── */}
          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Prediction before kickoff
            </h3>
            {p ? (
              <>
                <dl className="space-y-1">
                  <Row label="Home" value={`${(p.home * 100).toFixed(0)}%`} />
                  <Row label="Draw" value={`${(p.draw * 100).toFixed(0)}%`} />
                  <Row label="Away" value={`${(p.away * 100).toFixed(0)}%`} />
                  <Row label="Model" value={p.modelVersion} />
                  <Row label="Stage" value={p.predictionStage} />
                  <Row label="Frozen at" value={p.asOf.replace("T", " ").slice(0, 19) + " UTC"} />
                  <Row label="Settled" value={p.settled ? "YES" : "NO"} />
                  {p.brier !== null && <Row label="Brier" value={p.brier.toFixed(4)} />}
                  {p.rps !== null && <Row label="RPS" value={p.rps.toFixed(4)} />}
                  {p.logLoss !== null && <Row label="LogLoss" value={p.logLoss.toFixed(4)} />}
                </dl>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  These are the probabilities as frozen before kickoff. Observing the result cannot
                  alter them — the snapshot is immutable and settlement is a separate record.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                No frozen pre-kickoff forecast for this fixture. This league is currently
                ledger-only: results are recorded, but no production model forecasts it yet.
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 pt-3 text-[10px] text-muted-foreground">
          <span>Source: {match.sources.join(", ") || "—"}</span>
          <span>Observations: {match.observationCount}</span>
          {match.resultObservedAt && (
            <span>Result observed: {match.resultObservedAt.replace("T", " ").slice(0, 19)} UTC</span>
          )}
          {match.corrections > 0 && (
            <span className="text-amber-300">Provider corrections: {match.corrections}</span>
          )}
          <Link
            href={`/team/${match.competition}/${match.home.slug}`}
            className="text-neon hover:underline"
          >
            {match.home.name} season
          </Link>
          <Link
            href={`/team/${match.competition}/${match.away.slug}`}
            className="text-neon hover:underline"
          >
            {match.away.name} season
          </Link>
        </div>
      </div>
    </details>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
