import Link from "next/link";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { loadProductionParams } from "@/lib/competitions/premier-league/model-tracks";
import { currentHonestyText } from "@/lib/competitions/premier-league/honesty";
import { evaluateDataGate, upcomingLiveFixtures } from "@/lib/competitions/premier-league/data-gate";
import { utcIsoToLondonLocal } from "@/lib/competitions/premier-league/timezone";

function formatKickoff(utc: string | null | undefined, date: string): string {
  if (!utc) return date;
  try {
    const local = utcIsoToLondonLocal(utc);
    return `${local.date} ${local.time} UK`;
  } catch {
    return date;
  }
}

export function PremierLeagueSlate() {
  const params = loadProductionParams();
  const gate = evaluateDataGate();
  const upcoming = upcomingLiveFixtures().slice(0, 8);

  return (
    <section className="mx-auto mb-8 max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Premier League · {params.modelVersion} · {gate.status}
          </p>
          <h2 className="text-lg font-bold tracking-tight">Upcoming Premier League fixtures</h2>
        </div>
        <Link
          href="/?q=Who%20is%20most%20likely%20to%20win%20the%20Premier%20League%3F"
          className="text-xs font-medium text-neon hover:underline"
        >
          Title odds →
        </Link>
      </div>
      <p className="mb-4 text-sm text-amber-200/90">{currentHonestyText()}</p>
      {upcoming.length === 0 ? (
        <p className="text-sm text-muted-foreground">No upcoming official fixtures are loaded.</p>
      ) : (
        <ul className="space-y-2">
          {upcoming.map((f) => {
            const h = getClub(f.homeSlug);
            const a = getClub(f.awaySlug);
            const q = encodeURIComponent(`Who wins ${h.name} vs ${a.name}?`);
            return (
              <li key={f.id}>
                <Link
                  href={`/?q=${q}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-sm transition hover:border-neon/30"
                >
                  <span>
                    <span className="font-semibold">{h.shortName}</span>
                    <span className="mx-2 text-muted-foreground">vs</span>
                    <span className="font-semibold">{a.shortName}</span>
                    <span className="ml-3 text-[11px] text-muted-foreground">
                      {formatKickoff(f.kickoffUtc ?? f.kickoff, f.date)}
                    </span>
                  </span>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {params.modelVersion}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-right text-[11px] text-muted-foreground">
        <Link href="/live" className="hover:text-foreground">
          Live out-of-sample ledger →
        </Link>
      </p>
    </section>
  );
}
