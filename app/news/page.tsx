import type { Metadata } from "next";
import { Newspaper } from "lucide-react";
import { NewsBrowser } from "@/components/news/news-browser";
import { DailyBrief } from "@/components/news/daily-brief";
import { getNewsForTeam, TRACKED_TEAMS, newsProviderConfigured } from "@/lib/news/newsIngestor";
import { teamRef } from "@/lib/agent/matchResolver";
import type { NewsItemView } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "World Cup research news · Football Oracle",
  description:
    "Archived World Cup 2026 team-news research, isolated from Premier League production forecasts.",
};

export default async function NewsPage() {
  const teams = TRACKED_TEAMS.map((slug) => {
    const t = teamRef(slug);
    return { slug: t.slug, name: t.name, flag: t.flag };
  });

  const initialSlug = "argentina";
  const { items, source } = await getNewsForTeam(initialSlug, 10);
  const initialItems: NewsItemView[] = items.map((it) => ({
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

  const live = newsProviderConfigured();

  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl text-center">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Research archive · World Cup · separate evidence track
        </p>
        <div className="chip mx-auto mb-4 w-fit">
          <Newspaper className="h-3.5 w-3.5 text-neon" />
          Archived research signals
        </div>
        <h1 className="text-balance text-3xl font-black tracking-tight sm:text-4xl">
          World Cup <span className="neon-text">research news</span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-pretty text-sm text-muted-foreground sm:text-base">
          Archived injuries, squad replacements, call-ups, suspensions and tactical updates for tracked
          2026 nations. These signals belong to the World Cup research system and never enter Premier League production forecasts.
          {!live && (
            <>
              {" "}
              No live news API key is configured, so these are clearly-labelled{" "}
              <strong className="text-foreground">demo signals</strong>.
            </>
          )}
        </p>
      </section>

      {/* Show the full knockout press-conference layer (pre- & post-match), not
          just the latest few — these managers'/players' briefings are the story
          now that the tournament is in the knockout rounds. */}
      <DailyBrief limit={9} />

      <NewsBrowser
        teams={teams}
        initialSlug={initialSlug}
        initialItems={initialItems}
        initialSource={source}
      />
    </div>
  );
}
