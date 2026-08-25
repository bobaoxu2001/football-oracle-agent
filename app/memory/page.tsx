import type { Metadata } from "next";
import { Database, HardDrive, Brain, Radio, Clock, LockKeyhole } from "lucide-react";
import { NewsItemCard } from "@/components/news/news-item-card";
import { relativeTime } from "@/components/news/news-badges";
import { RefreshNewsButton } from "@/components/memory/refresh-news-button";
import { mongoConnected, countPredictions } from "@/lib/db/mongodb";
import { getNewsForTeam, getNewsStats, newsMode } from "@/lib/news/newsIngestor";
import { teamRef } from "@/lib/agent/matchResolver";
import type { NewsItemView } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Storage & privacy status · Football Oracle",
  description:
    "Operational status for private session storage and World Cup research signals. Conversations are never publicly exposed.",
};

const FEATURED = ["argentina", "germany", "brazil", "france"];

export default async function MemoryPage() {
  const [connected, preds, newsStats] = await Promise.all([
    mongoConnected(),
    countPredictions(),
    getNewsStats(),
  ]);
  const mode = newsMode();

  // Stored team-news signals for a few featured nations.
  const featured = await Promise.all(
    FEATURED.map(async (slug) => {
      const t = teamRef(slug);
      const { items } = await getNewsForTeam(slug, 3);
      const views: NewsItemView[] = items.map((it) => ({
        title: it.title,
        summary: it.summary,
        category: it.category,
        impactLevel: it.impactLevel,
        direction: it.direction,
        sourceName: it.sourceName,
        sourceUrl: it.sourceUrl,
        publishedAt: new Date(it.publishedAt).toISOString(),
        demo: it.demo,
      }));
      return { team: t, views };
    })
  );

  return (
    <div className="container py-8 md:py-12">
      {/* hero */}
      <section className="mx-auto mb-8 max-w-3xl text-center">
        <div className="chip mx-auto mb-4 w-fit">
          <LockKeyhole className="h-3.5 w-3.5 text-neon" />
          Private operational storage
        </div>
        <h1 className="text-balance text-3xl font-black tracking-tight sm:text-4xl">
          Storage &amp; <span className="neon-text">privacy status</span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-pretty text-sm text-muted-foreground sm:text-base">
          This page explains the storage layer without publishing anyone&apos;s prompts, answers,
          context, or session history. Anonymous conversations are operational data, not a public feed.
        </p>
      </section>

      {/* status cards */}
      <section className="mb-8 grid gap-4 md:grid-cols-3">
        {/* backend */}
        <div className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2">
            {connected ? (
              <Database className="h-4 w-4 text-neon" />
            ) : (
              <HardDrive className="h-4 w-4 text-amber-300" />
            )}
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
              Private session store
            </span>
          </div>
          <p className="text-lg font-bold">{connected ? "MongoDB Atlas" : "In-memory fallback"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {connected
              ? "Connected — private reliability records and research team_news persist across sessions."
              : "No MONGODB_URI / unreachable — private records use process-local storage only."}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <span className="chip text-[10px]">
              <LockKeyhole className="h-3 w-3" /> {preds.total} private session{preds.total === 1 ? "" : "s"}
            </span>
            <span className="chip text-[10px]">not publicly enumerable</span>
          </div>
        </div>

        {/* news intelligence */}
        <div className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-neon" />
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
                News intelligence
              </span>
            </div>
            <RefreshNewsButton />
          </div>
          <p className="text-lg font-bold">
            {mode.mode === "api" ? `Live news${mode.provider ? ` · ${mode.provider}` : ""}` : "Demo mode"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode.mode === "api"
              ? "Live news API configured — items are real and source-attributed."
              : "No news API key — using clearly-labelled curated sample signals."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="chip text-[10px]">{newsStats.total} stored signal{newsStats.total === 1 ? "" : "s"}</span>
            <span className="chip text-[10px]">
              <Clock className="h-3 w-3" />{" "}
              {newsStats.lastUpdate ? `updated ${relativeTime(newsStats.lastUpdate)}` : "on-demand"}
            </span>
          </div>
        </div>

        {/* why mongodb */}
        <div className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2">
            <Brain className="h-4 w-4 text-neon" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
              Operational retention
            </span>
          </div>
          <ul className="space-y-1.5 text-xs text-foreground/85">
            <li>
              <span className="font-semibold text-neon">private sessions</span> — retained for
              reliability and never publicly enumerated.
            </li>
            <li>
              <span className="font-semibold text-neon">team_news</span> — classified daily signals,
              indexed by team / impact / category.
            </li>
            <li>
              <span className="font-semibold text-neon">request context</span> — supports bounded
              follow-ups inside the World Cup research archive.
            </li>
          </ul>
        </div>
      </section>

      <section className="mb-8 rounded-2xl border border-neon/20 bg-neon/[0.05] p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <LockKeyhole className="h-4 w-4 text-neon" /> Conversation privacy
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          The public site exposes neither raw anonymous questions nor generated answers. Records are
          retained for internal reliability and are not rendered here or returned by the legacy recent-predictions API.
        </p>
      </section>

      {/* stored team news */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-neon">
          <Radio className="h-4 w-4" /> World Cup research signals
        </h2>
        <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
          These archived national-team signals are isolated from Premier League production forecasts.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {featured.map(({ team, views }) => (
            <div key={team.slug} className="glass rounded-2xl p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xl">{team.flag}</span>
                <span className="text-sm font-bold">{team.name}</span>
              </div>
              <div className="space-y-2">
                {views.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No stored signals.</p>
                ) : (
                  views.map((v, i) => <NewsItemCard key={i} item={v} compact />)
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
