import Link from "next/link";
import { ArrowRight, ClipboardList, Sparkles } from "lucide-react";
import { getManualDailyNews, type ManualDailyNewsTag } from "@/lib/seed/manual-daily-news";
import { getTeam } from "@/lib/seed/world-cup-2026-groups";
import { VerificationBadge } from "@/components/news/news-badges";

/** Tag chip styling per editorial tag (matches the site's neon/dark badges). */
const TAG_STYLE: Record<ManualDailyNewsTag, string> = {
  Result: "border-neon/30 text-neon",
  Standings: "border-electric/30 text-electric",
  "Match Preview": "border-sky-400/30 text-sky-300",
  "Press Conference": "border-teal-400/30 text-teal-300",
  "Team News": "border-white/15 text-foreground/80",
  Injury: "border-red-400/30 text-red-300",
  Prediction: "border-purple-400/30 text-purple-300",
  Tournament: "border-amber-400/30 text-amber-300",
};

function fmtBriefDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(+d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function teamChip(slug: string): string | null {
  try {
    const t = getTeam(slug);
    return `${t.flag} ${t.name}`;
  } catch {
    return null; // unknown slug in the seed file — skip rather than crash
  }
}

/**
 * Daily Brief — the editor-controlled narrative layer that sits ABOVE the live
 * GNews browser. Content is maintained in lib/seed/manual-daily-news.ts.
 */
export function DailyBrief({ limit = 4 }: { limit?: number }) {
  const items = getManualDailyNews(limit);
  if (!items.length) return null;
  const latestDate = items[0].date;

  return (
    <section className="glass mb-8 rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ClipboardList className="h-4 w-4 text-neon" />
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
          Daily Brief — {fmtBriefDate(latestDate)}
        </h2>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((it) => (
          <article
            key={it.id}
            className="flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition hover:border-neon/20"
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TAG_STYLE[it.tag]}`}
              >
                {it.tag}
              </span>
              <VerificationBadge provenance={it} />
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {fmtBriefDate(it.date)}
              </span>
            </div>

            <p className="text-sm font-semibold leading-snug">{it.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{it.summary}</p>

            {(it.relatedTeams?.length || it.prompt) && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] pt-2">
                {it.relatedTeams?.map((slug) => {
                  const label = teamChip(slug);
                  return label ? (
                    <span key={slug} className="text-[10px] text-muted-foreground">
                      {label}
                    </span>
                  ) : null;
                })}
                {it.prompt && (
                  <Link
                    href={`/research/world-cup?q=${encodeURIComponent(it.prompt)}`}
                    className="ml-auto inline-flex items-center gap-1 rounded-full border border-neon/25 bg-neon/[0.06] px-2.5 py-1 text-[10px] font-semibold text-neon transition hover:border-neon/50 hover:bg-neon/[0.12]"
                  >
                    <Sparkles className="h-3 w-3" /> Ask the Oracle
                  </Link>
                )}
              </div>
            )}
          </article>
        ))}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground/60">
        Editorial brief, updated daily. Source-attributed news continues below.
      </p>
    </section>
  );
}

/**
 * Compact homepage variant — "Today's World Cup Brief". Same seed source,
 * trimmed to 3 tight cards so it sits above the Agent Chat without pushing
 * it below the fold.
 */
export function DailyBriefCompact({ limit = 3 }: { limit?: number }) {
  const items = getManualDailyNews(limit);
  if (!items.length) return null;

  return (
    <section className="glass mb-8 rounded-2xl p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ClipboardList className="h-3.5 w-3.5 text-neon" />
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neon">
          Today&apos;s World Cup Brief
        </h2>
        <Link
          href="/news"
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
        >
          All briefs &amp; live news <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-3">
        {items.map((it) => (
          <article
            key={it.id}
            className="flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition hover:border-neon/20"
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <span
                className={`inline-block rounded-full border px-2 py-0.5 text-[9px] font-semibold ${TAG_STYLE[it.tag]}`}
              >
                {it.tag}
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {fmtBriefDate(it.date)}
              </span>
            </div>
            <p className="line-clamp-2 text-[13px] font-semibold leading-snug">{it.title}</p>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
              {it.summary}
            </p>
            {it.prompt && (
              <Link
                href={`/research/world-cup?q=${encodeURIComponent(it.prompt)}`}
                className="mt-2 inline-flex w-fit items-center gap-1 rounded-full border border-neon/25 bg-neon/[0.06] px-2.5 py-1 text-[10px] font-semibold text-neon transition hover:border-neon/50 hover:bg-neon/[0.12]"
              >
                <Sparkles className="h-3 w-3" /> Ask Oracle
              </Link>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
