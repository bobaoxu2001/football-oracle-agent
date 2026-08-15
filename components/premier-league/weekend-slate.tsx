import Link from "next/link";
import { currentPremierLeagueField, lastCompletedSeason } from "@/lib/competitions/premier-league/season";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { loadPremierLeagueParams } from "@/lib/prediction-engine/model-params";
import { PRESEASON_BASELINE_CAVEAT, isPreseasonBaseline } from "@/lib/competitions/premier-league/honesty";

const FEATURED: [string, string][] = [
  ["arsenal", "liverpool"],
  ["manchester-city", "manchester-united"],
  ["chelsea", "tottenham"],
  ["newcastle", "aston-villa"],
];

export function PremierLeagueSlate() {
  const params = loadPremierLeagueParams();
  const field = currentPremierLeagueField();
  const season = lastCompletedSeason();
  const pairs = FEATURED.filter(([h, a]) => field.includes(h) && field.includes(a));

  return (
    <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Premier League · {params.modelVersion}
          </p>
          <h2 className="text-lg font-bold tracking-tight">Featured Premier League matchups</h2>
        </div>
        <Link
          href="/?q=Who%20is%20most%20likely%20to%20win%20the%20Premier%20League%3F"
          className="text-xs font-medium text-neon hover:underline"
        >
          Title odds →
        </Link>
      </div>
      <p className="mb-4 text-sm text-amber-200/90">
        {isPreseasonBaseline()
          ? PRESEASON_BASELINE_CAVEAT
          : `Official fixtures for the current season. Last completed field on file: ${season} (${field.length} clubs).`}
      </p>
      <p className="mb-4 text-xs text-muted-foreground">
        These are example home/away orientations, not this weekend&apos;s official fixture list.
        Each row opens a model prediction.
      </p>
      <ul className="space-y-2">
        {pairs.map(([home, away]) => {
          const h = getClub(home);
          const a = getClub(away);
          const q = encodeURIComponent(`Who wins ${h.name} vs ${a.name}?`);
          return (
            <li key={`${home}-${away}`}>
              <Link
                href={`/?q=${q}`}
                className="flex items-center justify-between rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm transition hover:border-neon/30"
              >
                <span>
                  <span className="font-semibold">{h.shortName}</span>
                  <span className="mx-2 text-muted-foreground">vs</span>
                  <span className="font-semibold">{a.shortName}</span>
                </span>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Predict
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
