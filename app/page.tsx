import Link from "next/link";
import { ArrowRight, BarChart3, Database, FlaskConical, ShieldCheck, Sparkles } from "lucide-react";
import { upcomingMatchForecasts } from "@/lib/match-forecast/service";
import type { UpcomingMatchForecast } from "@/lib/match-forecast/types";

export const dynamic = "force-dynamic";

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

function kickoffLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  }).format(new Date(value));
}

export default function Home() {
  const matches = upcomingMatchForecasts(6);
  const first = matches[0];

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-10 max-w-5xl">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="chip border-neon/30 text-neon">
            <span className="h-1.5 w-1.5 rounded-full bg-neon" /> Premier League forecasting live
          </span>
          <span className="chip">Production model · pl-live-v0.2.0</span>
        </div>
        <div className="grid items-end gap-6 lg:grid-cols-[1fr_auto]">
          <div>
            <h1 className="max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
              See the match as a <span className="neon-text">probability distribution.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Auditable Premier League 1X2, expected goals, totals, BTTS and exact-score forecasts—frozen before kickoff and explained without changing the numbers.
            </p>
          </div>
          {first ? (
            <Link
              href={`/match/${first.match.id}`}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-neon px-5 py-3 text-sm font-bold text-primary-foreground transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon"
            >
              Open next Match Room <ArrowRight className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      </section>

      <section className="mx-auto mb-12 max-w-6xl" aria-labelledby="upcoming-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neon">Forecasts</p>
            <h2 id="upcoming-heading" className="mt-1 text-2xl font-black tracking-tight">Upcoming matches</h2>
          </div>
          <Link href="/live" className="text-xs font-semibold text-muted-foreground hover:text-foreground">View production ledger →</Link>
        </div>
        {matches.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {matches.map((item) => <ForecastCard key={item.match.id} item={item} />)}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-muted-foreground">
            No upcoming match currently has an immutable production forecast. We do not synthesize one in the browser.
          </div>
        )}
      </section>

      <section className="mx-auto mb-12 max-w-6xl" aria-labelledby="coverage-heading">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neon">Coverage</p>
        <h2 id="coverage-heading" className="mt-1 text-2xl font-black tracking-tight">One forecasting league. Five historical ledgers.</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="glass p-5">
            <p className="text-sm font-bold text-neon">Premier League</p>
            <p className="mt-2 text-sm text-muted-foreground">Production forecasting, Match Rooms, frozen timelines and forward settlement.</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 md:col-span-2">
            <p className="text-sm font-bold">La Liga · Bundesliga · Serie A · Ligue 1</p>
            <p className="mt-2 text-sm text-muted-foreground">Completed-match history is supported. User-facing forecasts are coming later; the site will not imply otherwise.</p>
            <Link href="/matches" className="mt-3 inline-flex text-xs font-semibold text-neon hover:underline">Browse historical ledgers →</Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl border-t border-white/10 pt-8" aria-labelledby="research-heading">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Research & operations</p>
        <h2 id="research-heading" className="mt-1 text-xl font-black tracking-tight">Evidence behind the product</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ResearchLink href="/accuracy" icon={<BarChart3 className="h-4 w-4" />} title="Track record" copy="Production, shadow and reconstruction kept separate." />
          <ResearchLink href="/shadow" icon={<FlaskConical className="h-4 w-4" />} title="Shadow lab" copy="Paired forward challenger evidence—never served as production." />
          <ResearchLink href="/research/world-cup" icon={<Sparkles className="h-4 w-4" />} title="World Cup archive" copy="Preserved research plugin with its own evidence boundary." />
          <ResearchLink href="/memory" icon={<Database className="h-4 w-4" />} title="Data & privacy" copy="Storage status without exposing user conversations." />
        </div>
        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-neon" />
          Probabilities are model estimates, not betting advice. Market prices are not production inputs and unsupported player scenarios return no number.
        </p>
      </section>
    </div>
  );
}

function ForecastCard({ item }: { item: UpcomingMatchForecast }) {
  const { match, forecast, freshness } = item;
  const top = forecast.topScores[0];
  return (
    <article className="glass glass-hover flex h-full flex-col p-5">
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{kickoffLabel(match.kickoffUtc)}</span>
        <span className={freshness.status === "stale" ? "text-amber-300" : "text-neon"}>{freshness.status}</span>
      </div>
      <h3 className="mt-4 text-lg font-black tracking-tight">{match.home.name} <span className="font-medium text-muted-foreground">vs</span> {match.away.name}</h3>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[[match.home.name, forecast.result.homeWin], ["Draw", forecast.result.draw], [match.away.name, forecast.result.awayWin]].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-white/10 bg-black/20 px-2 py-3">
            <p className="truncate text-[10px] text-muted-foreground">{String(label)}</p>
            <p className="mt-1 text-xl font-black tabular-nums">{pct(Number(value))}</p>
          </div>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="Model xG" value={`${forecast.expectedGoals.home.toFixed(2)}–${forecast.expectedGoals.away.toFixed(2)}`} />
        <MiniStat label="Over 2.5" value={pct(forecast.totals.over25)} />
        <MiniStat label="Top score" value={`${top.homeGoals}–${top.awayGoals}`} />
      </dl>
      <Link href={`/match/${match.id}`} className="mt-5 inline-flex min-h-11 items-center justify-between rounded-xl border border-neon/25 bg-neon/[0.06] px-4 py-2.5 text-sm font-bold text-neon transition hover:bg-neon/[0.1]">
        Enter Match Room <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="mt-0.5 font-bold tabular-nums">{value}</dd></div>;
}

function ResearchLink({ href, icon, title, copy }: { href: string; icon: React.ReactNode; title: string; copy: string }) {
  return (
    <Link href={href} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition hover:border-neon/25 hover:bg-white/[0.04]">
      <span className="flex items-center gap-2 text-sm font-bold">{icon}{title}</span>
      <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{copy}</span>
    </Link>
  );
}
