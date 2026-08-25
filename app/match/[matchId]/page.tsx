import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { AlertTriangle, ArrowLeft, BarChart3, Clock3, Database, Eye, ShieldCheck, Target, Users } from "lucide-react";
import { MatchRoomAgent } from "@/components/match-room/match-agent";
import { getMatchIntelligence, MatchForecastError } from "@/lib/match-forecast/service";
import type { MatchIntelligence } from "@/lib/match-forecast/types";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ matchId: string }> };
const pct = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const getCachedMatchIntelligence = cache(getMatchIntelligence);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { matchId } = await params;
  try {
    const data = await getCachedMatchIntelligence(matchId);
    return { title: `${data.match.home.name} vs ${data.match.away.name} · Match Room`, description: `Auditable production forecast for ${data.match.home.name} vs ${data.match.away.name}.` };
  } catch {
    return { title: "Match Room · Football Oracle" };
  }
}

export default async function MatchRoomPage({ params }: Props) {
  const { matchId } = await params;
  let data: MatchIntelligence;
  try {
    data = await getCachedMatchIntelligence(matchId);
  } catch (error) {
    return <UnavailableMatch matchId={matchId} error={error} />;
  }
  const { match, forecast, freshness } = data;
  const outcomes = [
    { label: match.home.name, sub: "Home win", value: forecast.result.homeWin },
    { label: "Draw", sub: "90 minutes", value: forecast.result.draw },
    { label: match.away.name, sub: "Away win", value: forecast.result.awayWin },
  ];
  const favoriteProbability = Math.max(...outcomes.map((outcome) => outcome.value));

  return (
    <div className="container py-6 md:py-10">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="mb-5 inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All forecasts</Link>
        <section className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-5 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span className="font-semibold uppercase tracking-[0.16em] text-neon">Premier League · {match.season}</span>
            <span>{formatKickoff(match.kickoffUtc)}</span>
          </div>
          <h1 className="mt-6 text-balance text-center text-3xl font-black tracking-tight sm:text-5xl">{match.home.name} <span className="text-muted-foreground">vs</span> {match.away.name}</h1>
          <p className="mt-3 text-center text-sm text-muted-foreground">Production forecast frozen {formatTimestamp(forecast.cutoffAt)} · {forecast.modelVersion}</p>
          {freshness.status === "stale" ? <p className="mx-auto mt-4 flex max-w-2xl items-start justify-center gap-2 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-xs text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {freshness.note}</p> : null}
          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            {outcomes.map((outcome) => (
              <div key={outcome.label} className={`rounded-2xl border p-4 text-center ${outcome.value === favoriteProbability ? "border-neon/30 bg-neon/[0.07]" : "border-white/10 bg-black/20"}`}>
                <p className="truncate text-xs font-semibold text-muted-foreground">{outcome.label}</p>
                <p className="mt-2 text-4xl font-black tabular-nums tracking-tight">{pct(outcome.value)}</p>
                <p className="mt-1 text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{outcome.sub}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
          <section className="glass p-5 sm:p-6" aria-labelledby="model-outlook-heading">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon"><Target className="h-4 w-4" /> Model outlook</p>
            <h2 id="model-outlook-heading" className="mt-1 text-xl font-black">Goals and core markets</h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <BigStat label={`${match.home.name} expected goals`} value={forecast.expectedGoals.home.toFixed(2)} />
              <BigStat label={`${match.away.name} expected goals`} value={forecast.expectedGoals.away.toFixed(2)} />
              <BigStat label="Expected total" value={forecast.expectedGoals.total.toFixed(2)} />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <ProbabilityPair label="Over / Under 1.5" leftLabel="Over" left={forecast.totals.over15} rightLabel="Under" right={forecast.totals.under15} />
              <ProbabilityPair label="Over / Under 2.5" leftLabel="Over" left={forecast.totals.over25} rightLabel="Under" right={forecast.totals.under25} />
              <ProbabilityPair label="Over / Under 3.5" leftLabel="Over" left={forecast.totals.over35} rightLabel="Under" right={forecast.totals.under35} />
              <ProbabilityPair label="Both teams to score" leftLabel="Yes" left={forecast.btts.yes} rightLabel="No" right={forecast.btts.no} />
            </div>
          </section>
          <section className="glass p-5 sm:p-6" aria-labelledby="scorelines-heading">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon"><BarChart3 className="h-4 w-4" /> Exact scores</p>
            <h2 id="scorelines-heading" className="mt-1 text-xl font-black">Five most likely</h2>
            <ol className="mt-4 space-y-2">
              {forecast.topScores.slice(0, 5).map((score, index) => <li key={`${score.homeGoals}-${score.awayGoals}`} className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-4 py-2.5"><span className="text-xs text-muted-foreground">{index + 1}</span><span className="text-lg font-black tabular-nums">{score.homeGoals}–{score.awayGoals}</span><span className="text-sm font-bold tabular-nums text-neon">{pct(score.probability)}</span></li>)}
            </ol>
          </section>
        </div>

        <section className="mt-5 glass p-5 sm:p-6" aria-labelledby="secondary-heading">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neon">Derived from the same score matrix</p>
          <h2 id="secondary-heading" className="mt-1 text-xl font-black">Secondary markets</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MarketStat label={`${match.home.name} or draw`} value={forecast.doubleChance.homeOrDraw} />
            <MarketStat label={`${match.away.name} or draw`} value={forecast.doubleChance.drawOrAway} />
            <MarketStat label={`${match.home.name} draw no bet`} value={forecast.drawNoBet.home} />
            <MarketStat label={`${match.away.name} draw no bet`} value={forecast.drawNoBet.away} />
            <MarketStat label={`${match.home.name} over 0.5`} value={forecast.teamTotals.home.over05} />
            <MarketStat label={`${match.away.name} over 0.5`} value={forecast.teamTotals.away.over05} />
            <MarketStat label={`${match.home.name} over 1.5`} value={forecast.teamTotals.home.over15} />
            <MarketStat label={`${match.away.name} over 1.5`} value={forecast.teamTotals.away.over15} />
          </div>
        </section>

        <section className="mt-5 glass p-5 sm:p-6" aria-labelledby="oracle-knows-heading">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon"><Eye className="h-4 w-4" /> What Oracle knows</p>
          <h2 id="oracle-knows-heading" className="mt-1 text-xl font-black">Selected forecast: known at cutoff</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Context is frozen separately from the probability model. “Known” means the evidence was recorded with <span className="font-mono text-[12px] text-foreground">availableAt ≤ cutoffAt</span>; it does not mean the model used it.</p>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <ContextStat
              label="Availability"
              value={contextAvailabilityLabel(data)}
              note={data.context.atForecast.availability ? "Cutoff-safe structured evidence" : "No structured player evidence"}
            />
            <ContextStat
              label="Lineups"
              value={formatStatus(data.audit.lineupStatus)}
              note={data.audit.lineupAvailableAt ? `Available ${formatTimestamp(data.audit.lineupAvailableAt)}` : "No lineup timestamp recorded"}
            />
            <ContextStat
              label="Feature usage"
              value={`${data.audit.contextEvidenceCounts.usedInForecast} model-used`}
              note={`${data.audit.contextEvidenceCounts.informationalOnly} informational-only`}
            />
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-black/20 p-4">
              <p className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="h-4 w-4 text-neon" /> Selected forecast context</p>
              <p className="mt-2 text-sm font-bold">{formatStatus(data.context.atForecast.status)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{data.context.atForecast.note}</p>
              {data.context.atForecast.contextId ? <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">{data.context.atForecast.contextId}</p> : null}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-4">
              <p className="flex items-center gap-2 text-xs font-semibold"><Users className="h-4 w-4 text-neon" /> Latest prospective context</p>
              <p className="mt-2 text-sm font-bold">{formatStatus(data.context.latest.status)}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{data.context.latest.note}</p>
              {data.context.latest.cutoffAt ? <p className="mt-2 text-[11px] text-muted-foreground">Context cutoff: {formatTimestamp(data.context.latest.cutoffAt)}</p> : null}
              {data.context.latest.latestEvidenceAt ? <p className="mt-2 text-[11px] text-muted-foreground">Latest evidence: {formatTimestamp(data.context.latest.latestEvidenceAt)}</p> : null}
              <p className="mt-2 text-[11px] font-medium text-amber-100/90">{data.context.latest.contextId && data.context.latest.contextId === data.context.atForecast.contextId ? "This is the same immutable context as the selected forecast." : "This context is not an input to the selected forecast."}</p>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs font-semibold">What changed with the selected forecast</p>
            {data.contextComparison?.status === "COMPARED" ? (
              data.contextComparison.changes.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {data.contextComparison.changes.slice(0, 8).map((change, index) => <li key={`${change.type}-${change.evidenceId ?? change.entityId ?? index}`}>{contextChangeLabel(change)}</li>)}
                  {data.contextComparison.changes.length > 8 ? <li className="font-semibold text-foreground">{data.contextComparison.changes.length - 8} additional change(s) omitted here; the complete machine-readable set remains in the match intelligence API.</li> : null}
                </ul>
              ) : <p className="mt-2 text-xs text-muted-foreground">The exact context pair is available; no context change was detected.</p>
            ) : <p className="mt-2 text-xs text-muted-foreground">{data.contextComparison?.causalNote ?? "Only one legal production snapshot is available, so there is no exact context pair to compare."}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">Context timing and probability movement are shown together without claiming that one caused the other.</p>
          </div>
        </section>

        <div className="mt-5"><MatchRoomAgent matchId={match.id} home={match.home.name} away={match.away.name} /></div>

        <section className="mt-5 glass p-5 sm:p-6" aria-labelledby="timeline-heading">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon"><Clock3 className="h-4 w-4" /> Immutable history</p>
          <h2 id="timeline-heading" className="mt-1 text-xl font-black">Production probability timeline</h2>
          {data.timeline.length === 1 ? (
            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-sm font-semibold">One production snapshot is available.</p><p className="mt-1 text-xs text-muted-foreground">There is no verified probability change to chart. The site will not invent an earlier point or attribute movement that did not occur.</p><TimelineRow point={data.timeline[0]} home={match.home.name} away={match.away.name} /></div>
          ) : (
            <div className="mt-4 space-y-2">{data.timeline.map((point) => <TimelineRow key={point.forecastId} point={point} home={match.home.name} away={match.away.name} />)}</div>
          )}
        </section>

        <details className="mt-5 rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"><span className="flex items-center gap-2"><Database className="h-4 w-4 text-neon" /> Audit forecast</span><span className="text-xs font-medium text-muted-foreground">provenance & inputs</span></summary>
          <div className="mt-5 grid gap-4 text-xs text-muted-foreground md:grid-cols-2">
            <AuditLine label="Immutable forecast ID" value={data.audit.immutableForecastId} mono />
            <AuditLine label="Cutoff" value={data.audit.cutoffAt} />
            <AuditLine label="Generated" value={data.audit.generatedAt} />
            <AuditLine label="Data freshness" value={`${freshness.status} · ${freshness.ageHours.toFixed(1)} hours at page render`} />
            <AuditLine label="Latest input" value={data.audit.dataFreshness.latestInputAt} />
            <AuditLine label="Rating state cutoff" value={data.audit.dataFreshness.ratingStateAsOf} />
            <AuditLine label="Model" value={`${data.audit.modelVersion} · production`} />
            <AuditLine label="Score artifact" value={data.audit.scoreDistributionArtifact} />
            <AuditLine label="Evaluation class" value={data.audit.evaluationClass} />
            <AuditLine label="Training window" value={data.audit.trainingWindow ? `${data.audit.trainingWindow.from} → ${data.audit.trainingWindow.to}` : "not recorded"} />
            <AuditLine label="Context snapshot" value={data.audit.contextSnapshotId ?? "not recorded for this historical snapshot"} mono={Boolean(data.audit.contextSnapshotId)} />
            <AuditLine label="Context status" value={formatStatus(data.context.atForecast.status)} />
            <AuditLine label="Lineup state" value={`${formatStatus(data.audit.lineupStatus)}${data.audit.lineupAvailableAt ? ` · ${data.audit.lineupAvailableAt}` : ""}`} />
            <AuditLine label="Context feature usage" value={`${data.audit.contextEvidenceCounts.usedInForecast} model-used · ${data.audit.contextEvidenceCounts.informationalOnly} informational-only`} />
          </div>
          <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 text-xs text-muted-foreground"><p className="font-semibold text-foreground">Production inputs</p><ul className="mt-2 list-disc space-y-1 pl-5">{data.audit.inputsUsed.map((input) => <li key={input}>{input}</li>)}</ul>{data.audit.reconstructionNote ? <p className="mt-3 text-amber-100/90">{data.audit.reconstructionNote}</p> : null}</div>
          <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-neon" /> Current news, market prices, tactical profiles and shadow-model outputs are not production inputs. Only the selected forecast context is constrained to its cutoff; separately labelled latest context is prospective and never backfilled.</p>
        </details>
      </div>
    </div>
  );
}

function formatKickoff(value: string) { return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London", timeZoneName: "short" }).format(new Date(value)); }
function formatTimestamp(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(value)); }
function BigStat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] leading-tight text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-black tabular-nums">{value}</p></div>; }
function MarketStat({ label, value }: { label: string; value: number }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-black tabular-nums">{pct(value)}</p></div>; }
function ProbabilityPair({ label, leftLabel, left, rightLabel, right }: { label: string; leftLabel: string; left: number; rightLabel: string; right: number }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-xs font-semibold">{label}</p><div className="mt-3 grid grid-cols-2 gap-2"><div><p className="text-[10px] text-muted-foreground">{leftLabel}</p><p className="text-2xl font-black tabular-nums">{pct(left)}</p></div><div><p className="text-[10px] text-muted-foreground">{rightLabel}</p><p className="text-2xl font-black tabular-nums">{pct(right)}</p></div></div></div>; }
function TimelineRow({ point, home, away }: { point: MatchIntelligence["timeline"][number]; home: string; away: string }) { return <div className="mt-3 grid gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs sm:grid-cols-[1fr_auto] sm:items-center"><div><p className="flex flex-wrap items-center gap-2 font-semibold text-foreground"><span>{point.predictionStage} · {formatTimestamp(point.cutoffAt)}</span>{point.validForCurrentKickoff ? null : <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">Obsolete kickoff</span>}</p><p className="mt-1 break-all text-muted-foreground">{point.forecastId}</p><p className="mt-1 text-[10px] text-muted-foreground">Context: {point.contextSnapshotId ?? "not recorded"}</p>{point.validForCurrentKickoff || !point.kickoffAtFreeze ? null : <p className="mt-1 text-amber-200/80">Frozen for {formatTimestamp(point.kickoffAtFreeze)}; retained for audit history and excluded from the current forecast.</p>}</div><p className="tabular-nums text-muted-foreground">{home} {pct(point.result.homeWin)} · Draw {pct(point.result.draw)} · {away} {pct(point.result.awayWin)}</p></div>; }
function ContextStat({ label, value, note }: { label: string; value: string; note: string }) { return <div className="rounded-xl border border-white/10 bg-black/20 p-4"><p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-2 text-lg font-black">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{note}</p></div>; }
function contextAvailabilityLabel(data: MatchIntelligence) { const availability = data.context.atForecast.availability; if (!availability) return "NOT RECORDED"; const total = availability.home.entities.length + availability.away.entities.length; return total ? `${total} player record${total === 1 ? "" : "s"}` : "NO EVIDENCE"; }
function contextChangeValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(contextChangeValue).join(", ") || "empty";
  const record = value as Record<string, unknown>;
  const fields = ["kind", "status", "lineupStatus", "availabilityStatus", "availableAt", "usedInForecast"]
    .filter((key) => record[key] !== null && record[key] !== undefined)
    .map((key) => `${key}=${String(record[key])}`);
  return fields.join(", ") || "structured record";
}
function contextChangeLabel(change: MatchIntelligence["contextComparison"] extends infer T ? NonNullable<T> extends { changes: Array<infer C> } ? C : never : never) { const subject = change.entityId ?? change.teamSlug ?? "match"; return `${change.type.replaceAll("_", " ")} · ${subject}${change.before !== null || change.after !== null ? ` · ${contextChangeValue(change.before)} → ${contextChangeValue(change.after)}` : ""}`; }
function formatStatus(value: string) { return value.replaceAll("_", " "); }
function AuditLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><p className="text-[10px] uppercase tracking-[0.14em]">{label}</p><p className={`mt-1 break-words text-foreground ${mono ? "font-mono text-[11px]" : ""}`}>{value}</p></div>; }
function UnavailableMatch({ matchId, error }: { matchId: string; error: unknown }) { const known = error instanceof MatchForecastError; return <div className="container py-16"><section className="mx-auto max-w-xl rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6"><AlertTriangle className="h-6 w-6 text-amber-300" /><h1 className="mt-4 text-2xl font-black">No auditable Match Room is available</h1><p className="mt-3 text-sm text-muted-foreground">{known ? error.message : "Match intelligence is temporarily unavailable."}</p><p className="mt-2 text-xs text-muted-foreground">Requested match: {matchId}. No probability is reconstructed in the browser.</p><Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-xl bg-neon px-4 text-sm font-bold text-primary-foreground">Back to forecasts</Link></section></div>; }
