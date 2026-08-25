"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Loader2, Database, HardDrive } from "lucide-react";
import { NewsItemCard } from "./news-item-card";
import { cn } from "@/lib/utils";
import type { NewsItemView } from "@/lib/agent/types";

interface TeamOption {
  slug: string;
  name: string;
  flag: string;
}

export function NewsBrowser({
  teams,
  initialSlug,
  initialItems,
  initialSource,
}: {
  teams: TeamOption[];
  initialSlug: string;
  initialItems: NewsItemView[];
  initialSource: "api" | "demo";
}) {
  const [selected, setSelected] = useState(initialSlug);
  const [items, setItems] = useState<NewsItemView[]>(initialItems);
  const [source, setSource] = useState<"api" | "demo">(initialSource);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadTeam = useCallback(async (slug: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/news/team/${slug}?limit=10`, { cache: "no-store" });
      const data = await res.json();
      setItems(data.items ?? []);
      setSource(data.source ?? "demo");
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected === initialSlug) return;
    const timer = window.setTimeout(() => void loadTeam(selected), 0);
    return () => window.clearTimeout(timer);
  }, [initialSlug, loadTeam, selected]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch(`/api/news/refresh?team=${selected}`, { cache: "no-store" });
      await loadTeam(selected);
    } finally {
      setRefreshing(false);
    }
  }, [selected, loadTeam]);

  const current = teams.find((t) => t.slug === selected);

  return (
    <div className="space-y-5">
      {/* team selector */}
      <div className="flex flex-wrap gap-2">
        {teams.map((t) => (
          <button
            key={t.slug}
            onClick={() => setSelected(t.slug)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition",
              selected === t.slug
                ? "border-neon/40 bg-neon/10 text-foreground"
                : "border-white/10 bg-white/[0.03] text-muted-foreground hover:border-neon/30 hover:text-foreground"
            )}
          >
            <span>{t.flag}</span>
            {t.name}
          </button>
        ))}
      </div>

      {/* header + refresh */}
      <div className="glass rounded-2xl p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{current?.flag}</span>
            <div>
              <h2 className="text-base font-bold">{current?.name} — recent news</h2>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                {source === "demo" ? (
                  <>
                    <HardDrive className="h-3 w-3" /> Demo news data (sample signals)
                  </>
                ) : (
                  <>
                    <Database className="h-3 w-3" /> Live news
                  </>
                )}
              </span>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-neon/30 hover:text-foreground disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading latest news…
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No recent news found for this team.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((it, i) => (
              <NewsItemCard key={i} item={it} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
