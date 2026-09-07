import type { ResearchMatchForecast } from "@/lib/competitions/big-five";

const TIMEZONES = {
  "la-liga": "Europe/Madrid",
  bundesliga: "Europe/Berlin",
  "serie-a": "Europe/Rome",
  "ligue-1": "Europe/Paris",
} as const;

function kickoffLabel(iso: string, competition: ResearchMatchForecast["competition"]): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONES[competition],
    timeZoneName: "short",
  }).format(new Date(iso));
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function evidenceCopy(level: ResearchMatchForecast["evidence"]["evidenceLevel"]): string {
  if (level === "PRIOR_ONLY") return "Unfitted prior only";
  if (level === "THIN") return "Thin current-season evidence";
  return "Current-season results in use; parameters still unfitted";
}

export function BigFiveForecastCard({ forecast }: { forecast: ResearchMatchForecast }) {
  const rows: [string, number][] = [
    [forecast.home.shortName ?? forecast.home.name, forecast.probabilities.home],
    ["Draw", forecast.probabilities.draw],
    [forecast.away.shortName ?? forecast.away.name, forecast.probabilities.away],
  ];
  const favorite = rows.reduce((best, row) => (row[1] > best[1] ? row : best));

  return (
    <article className="flex h-full flex-col rounded-2xl border border-amber-300/15 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{kickoffLabel(forecast.kickoffUtc, forecast.competition)}</span>
        <span className="text-amber-200/90">{evidenceCopy(forecast.evidence.evidenceLevel)}</span>
      </div>
      <h3 className="mt-4 text-lg font-black tracking-tight">
        {forecast.home.name} <span className="font-medium text-muted-foreground">vs</span> {forecast.away.name}
      </h3>
      {forecast.matchday !== null ? (
        <p className="mt-1 text-[11px] text-muted-foreground">Matchweek {forecast.matchday}</p>
      ) : null}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className={`rounded-xl border px-2 py-3 ${
              label === favorite[0]
                ? "border-amber-300/30 bg-amber-300/[0.08]"
                : "border-white/10 bg-black/20"
            }`}
          >
            <p className="truncate text-[10px] text-muted-foreground">{label}</p>
            <p className="mt-1 text-lg font-black tabular-nums">{pct(value)}</p>
          </div>
        ))}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div>
          <dt>Model xG</dt>
          <dd className="font-medium text-foreground">
            {forecast.expectedGoals.home.toFixed(2)} – {forecast.expectedGoals.away.toFixed(2)}
          </dd>
        </div>
        <div>
          <dt>Most likely score</dt>
          <dd className="font-medium text-foreground">{forecast.mostLikelyScoreline}</dd>
        </div>
        <div>
          <dt>Elo (as of cutoff)</dt>
          <dd className="font-medium text-foreground">
            {Math.round(forecast.home.elo)} – {Math.round(forecast.away.elo)}
          </dd>
        </div>
        <div>
          <dt>Results used</dt>
          <dd className="font-medium text-foreground">{forecast.evidence.completedMatchesUsed}</dd>
        </div>
      </dl>
      <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">
        {forecast.modelVersion} · computed on read · not a frozen production snapshot
      </p>
    </article>
  );
}
