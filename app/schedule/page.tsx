import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, Database, ShieldCheck, Sparkles, Trophy } from "lucide-react";
import {
  buildGroupFixtures,
  mergeLiveIntoGroups,
  mergeManualIntoGroups,
  bracketColumns,
} from "@/lib/schedule/buildSchedule";
import { computeStandings } from "@/lib/schedule/standings";
import { resolveQualification } from "@/lib/schedule/qualification";
import { getCachedFixtures } from "@/lib/live-sports/tournamentState";
import { getTeam } from "@/lib/seed/world-cup-2026-groups";
import { fmtDatetime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "World Cup research schedule · Football Oracle",
  description:
    "Archived World Cup 2026 schedule research, separated from Premier League production forecasting.",
};

const STATUS_STYLE: Record<string, string> = {
  Finished: "text-muted-foreground border-white/10",
  Live: "text-neon border-neon/30",
  Scheduled: "text-sky-300/90 border-sky-400/20",
  TBA: "text-amber-300/80 border-amber-400/20",
  Unknown: "text-muted-foreground border-white/10",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
        STATUS_STYLE[status] ?? STATUS_STYLE.Unknown
      }`}
    >
      {status}
    </span>
  );
}

/** Concise verified-kickoff display ("Jun 11 · 18:00 UTC") or honest "TBA". */
function fmtKickoff(iso: string): string {
  if (!iso || iso === "TBA") return "TBA";
  const d = new Date(iso);
  if (isNaN(+d)) return "TBA";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const hm = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return hm === "00:00" ? date : `${date} · ${hm} UTC`;
}

/** Date-only display ("Jun 11") — used next to a final score, where the
 *  kickoff time is no longer interesting and crowds narrow rows. */
function fmtShortDate(iso: string): string {
  if (!iso || iso === "TBA") return "TBA";
  const d = new Date(iso);
  if (isNaN(+d)) return "TBA";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Research-archive link that pre-submits a match question (slug → clean name). */
function askHref(slugA: string, slugB: string): string {
  const a = getTeam(slugA).name;
  const b = getTeam(slugB).name;
  return `/research/world-cup?q=${encodeURIComponent(`Who will win ${a} vs ${b}?`)}`;
}

/** Small research-agent affordance used on fixture rows. */
function AskOracleLink({ slugA, slugB }: { slugA: string; slugB: string }) {
  return (
    <Link
      href={askHref(slugA, slugB)}
      title={`Ask the World Cup research agent: ${getTeam(slugA).name} vs ${getTeam(slugB).name}`}
      aria-label={`Ask the World Cup research agent about ${getTeam(slugA).name} vs ${getTeam(slugB).name}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-neon/20 bg-neon/[0.04] px-2 py-0.5 text-[10px] font-semibold text-neon/90 transition hover:border-neon/50 hover:bg-neon/[0.12] hover:text-neon"
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" /> Ask
    </Link>
  );
}

export default async function SchedulePage() {
  const { fixtures, fetchedAt } = await getCachedFixtures();
  // Drawn pairings, enriched with VERIFIED kickoff dates/results from the
  // football-data.org cache where the same two teams match (else TBA), then
  // with manually entered results (clearly labelled; live always wins).
  const groups = mergeManualIntoGroups(mergeLiveIntoGroups(buildGroupFixtures(), fixtures));
  const standingsByGroup = new Map(computeStandings(groups).map((s) => [s.group, s]));

  // Once the group stage is complete, resolve the official Round-of-32 slots to
  // the actual qualified teams (and the eight best third-placed teams). Until
  // then the bracket keeps its positional placeholders (1A, 2B, 3rd→M74).
  const qualification = resolveQualification(groups);
  const resolvedR32 = qualification.complete
    ? new Map(qualification.r32.map((m) => [m.no, { home: m.home, away: m.away }]))
    : undefined;
  const bracket = bracketColumns(resolvedR32);
  const qualifiedThirds = qualification.thirds.filter((t) => t.qualified);
  const missedThirds = qualification.thirds.filter((t) => !t.qualified);

  // Freshness label is driven by the data actually on screen: the most recent
  // completed-result date in the standings (manual OR verified live). This can't
  // go stale while results exist. The live-cache fetch time is shown separately
  // and clearly scoped, so the two sources are never conflated.
  const finishedDates = groups
    .flatMap((g) => g.rows)
    .filter((r) => r.status === "Finished" && r.date !== "TBA")
    .map((r) => r.date)
    .sort();
  const resultsThrough = finishedDates.length
    ? fmtShortDate(finishedDates[finishedDates.length - 1])
    : null;
  const liveCacheAt = fetchedAt ? fmtDatetime(fetchedAt) : null;

  return (
    <div className="container py-8 md:py-12">
      <header className="mb-6">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Research archive · World Cup · separate evidence track
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <CalendarDays className="h-5 w-5 text-neon" />
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">World Cup 2026 research schedule</h1>
          <span className="chip text-[10px] text-amber-300/80">
            <Database className="h-3 w-3" /> official draw · recorded results
          </span>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          This archived research view is not part of Premier League production forecasting. Group tables update from completed match results. Kickoff times and venues aren&apos;t in
          the bundled draw data, so they stay <strong>TBA</strong> until a verified source provides
          them.
        </p>
      </header>

      {/* Transparency note */}
      <div className="glass mb-6 flex items-start gap-2 rounded-2xl p-4 text-[12px] leading-relaxed text-muted-foreground/90">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-neon" />
        <span>
          Standings are computed only from completed match results. <strong>TBA</strong> means the
          app is not inventing official fixture details rather than showing a placeholder
          {resultsThrough ? <> · results through {resultsThrough}</> : null}
          {liveCacheAt ? <> · live cache refreshed {liveCacheAt}</> : null}.
        </span>
      </div>

      {/* Knockout bracket — official routing as a round-by-round bracket view.
          Now the headline section: the tournament is in the knockout rounds, so
          this sits ABOVE the (completed) group stage. */}
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-neon">
          {qualification.complete
            ? "Knockout bracket — Round of 32 underway; later rounds resolve as matches are played"
            : "Knockout bracket — official 2026 routing (teams TBA until groups finish)"}
        </h2>
        <div className="glass overflow-x-auto rounded-2xl p-4">
          <div className="flex min-w-[1060px] items-stretch gap-4">
            {bracket.map((col) => (
              <div key={col.round} className="flex w-[196px] shrink-0 flex-col">
                <h3 className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-neon">
                  {col.round}
                </h3>
                <div className="flex flex-1 flex-col justify-around gap-2">
                  {col.matches.map((m) => (
                    <div
                      key={m.matchNo}
                      className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 transition hover:border-neon/25"
                    >
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="font-semibold">M{m.matchNo}</span>
                        {m.status === "Finished" && m.score ? (
                          <span className="font-semibold text-foreground tabular-nums">
                            {m.score}
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              · {fmtShortDate(m.date)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-amber-300/70">
                            {m.date === "TBA" ? "TBA" : fmtKickoff(m.date)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums">
                        {m.teamA} <span className="font-normal text-muted-foreground">vs</span>{" "}
                        {m.teamB}
                      </div>
                      {m.advanced && (
                        <div className="mt-0.5 truncate text-[10px] font-medium text-neon/90">
                          {m.advanced} advance on penalties
                        </div>
                      )}
                      {m.teamASlot && m.teamBSlot && (
                        <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70 tabular-nums">
                          {m.teamASlot} v {m.teamBSlot}
                        </div>
                      )}
                      {m.slugA && m.slugB && (
                        <div className="mt-1 flex justify-end">
                          <AskOracleLink slugA={m.slugA} slugB={m.slugB} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          {qualification.complete ? (
            <>
              Round-of-32 teams are resolved from the final group standings, with the eight best
              third-placed teams assigned to their slots via FIFA Annex C (slot labels shown
              beneath, e.g. 1A v 2B). Completed knockout ties show the recorded result (manual
              layer; shootouts are stored at their extra-time score with the advancing side named)
              and their winners fill the next round. Undecided slots keep the feeding match
              (W73 = winner of Match 73). Tap <strong>Ask</strong> on any resolved tie to send it to
              the Oracle. Kickoff &amp; venue: TBA.
            </>
          ) : (
            <>
              Pairings show official bracket slots (1A = Group A winners, W73 = winner of Match 73,
              3rd→M74 = best-third assigned by FIFA Annex C). Kickoff &amp; venue: TBA.
            </>
          )}
        </p>
      </section>

      {/* Group stage — drawn pairings + standings per group (now complete, below
          the live knockout bracket) */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-neon">
            <Trophy className="h-3.5 w-3.5" /> Group Stage Schedule
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => {
            const s = standingsByGroup.get(g.group);
            return (
              <div key={g.group} className="glass min-w-0 rounded-2xl p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-bold">Group {g.group}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {s && s.liveResults + s.manualResults > 0
                      ? `${s.liveResults + s.manualResults} result${
                          s.liveResults + s.manualResults === 1 ? "" : "s"
                        }`
                      : "Awaiting results"}
                  </span>
                </div>

                {/* Standings — always shown; all-zero rows before any result */}
                {s && (
                  <div className="mb-3 grid grid-cols-[auto_1fr_repeat(4,minmax(0,auto))] items-center gap-x-2.5 gap-y-1 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[13px]">
                    <span />
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Team
                    </span>
                    {["P", "W·D·L", "GD", "Pts"].map((h) => (
                      <span
                        key={h}
                        className="text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        {h}
                      </span>
                    ))}
                    {s.rows.map((r, i) => (
                      <div key={r.slug} className="contents">
                        <span className="text-[11px] font-bold text-muted-foreground">{i + 1}</span>
                        <span className={`min-w-0 truncate font-medium ${i < 2 ? "" : "text-muted-foreground"}`}>
                          {r.flag} {r.name}
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">{r.played}</span>
                        <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                          {r.won}·{r.drawn}·{r.lost}
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff}
                        </span>
                        <span className="text-right font-bold tabular-nums text-neon">{r.points}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Fixtures — drawn pairings with results where completed */}
                <ul className="space-y-1.5">
                  {g.rows.map((r, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="min-w-0 truncate">
                        {r.teamA} <span className="text-muted-foreground">v</span> {r.teamB}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-right text-[11px] tabular-nums">
                        {r.status === "Live" && <StatusChip status="Live" />}
                        {r.score && (
                          <span className="font-bold text-foreground">
                            {r.score} ·
                          </span>
                        )}
                        <span
                          className={
                            r.date === "TBA" ? "text-amber-300/70" : "font-medium text-muted-foreground"
                          }
                        >
                          {r.score ? fmtShortDate(r.date) : fmtKickoff(r.date)}
                        </span>
                        {r.slugA && r.slugB && <AskOracleLink slugA={r.slugA} slugB={r.slugB} />}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Standings count only finished matches. Top 2 qualify directly; 8 of 12 third-placed teams
          also advance.
        </p>
      </section>

      {/* Best third-placed teams — resolved once every group has finished */}
      {qualification.complete && (
        <section className="mb-8">
          <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-neon">
            <Trophy className="h-3.5 w-3.5" /> Best third-placed teams — 8 of 12 advance
          </h2>
          <div className="glass rounded-2xl p-4">
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
              {qualifiedThirds.map((t) => (
                <div
                  key={t.slug}
                  className="flex items-center justify-between gap-2 rounded-xl border border-neon/20 bg-neon/[0.05] px-3 py-1.5 text-[13px]"
                >
                  <span className="min-w-0 truncate font-medium">
                    {getTeam(t.slug).flag} {getTeam(t.slug).name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    3{t.group} · {t.row.points}pts · {t.row.goalDiff > 0 ? `+${t.row.goalDiff}` : t.row.goalDiff}
                  </span>
                </div>
              ))}
            </div>
            {missedThirds.length > 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground/70">
                Did not advance (lower-ranked thirds):{" "}
                {missedThirds.map((t, i) => (
                  <span key={t.slug}>
                    {i > 0 ? ", " : ""}
                    {getTeam(t.slug).name} ({t.row.points}pts)
                  </span>
                ))}
                . Thirds are ranked on points → goal difference → goals scored.
              </p>
            )}
          </div>
        </section>
      )}

    </div>
  );
}
