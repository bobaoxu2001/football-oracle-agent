import type { ReactNode } from "react";
import type { PremierLeagueMatchIntelligenceReport } from "@/lib/competitions/premier-league/intelligence";

export function MatchIntelligencePanel({
  report,
  homeName,
  awayName,
}: {
  report: PremierLeagueMatchIntelligenceReport;
  homeName: string;
  awayName: string;
}) {
  return (
    <section className="mt-5 glass p-5 sm:p-6" aria-labelledby="match-intelligence-heading">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">Research layer · not production</p>
      <h2 id="match-intelligence-heading" className="mt-1 text-xl font-black">Match Intelligence V1</h2>
      <p className="mt-2 max-w-3xl text-sm text-amber-100/90">{report.disclaimer}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <IntelStat label="Context stage" value={report.contextStage.replaceAll("_", " ")} />
        <IntelStat label="Lineup" value={report.lineupState.replaceAll("_", " ")} />
        <IntelStat label="Stance vs champion" value={report.stance.replaceAll("_", " ")} />
        <IntelStat label="Intelligence confidence" value={report.intelligenceConfidence} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Champion remains <span className="font-mono text-foreground">pl-live-v0.2.0</span>. Included in champion probability:{" "}
        <span className="font-mono text-foreground">{String(report.includedInChampionProbability)}</span>. Source authorization:{" "}
        {report.sourceAuthorization.replaceAll("_", " ")}.
      </p>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <IntelBlock title="Availability">
          {report.availability.length === 0 ? (
            <p>No legally available player-availability evidence at this cutoff.</p>
          ) : (
            <ul className="space-y-1">
              {report.availability.slice(0, 8).map((player) => (
                <li key={player.playerId}>
                  {player.displayName} · {player.state.replaceAll("_", " ")} · impact {player.absenceImpact}
                  {player.occupiesSpine ? " · spine" : ""}
                </li>
              ))}
            </ul>
          )}
        </IntelBlock>
        <IntelBlock title="Unit integrity">
          {report.units.filter((unit) => unit.state !== "UNKNOWN" && unit.state !== "INTACT").length === 0 ? (
            <p>No structural unit disruption is evidenced.</p>
          ) : (
            <ul className="space-y-1">
              {report.units
                .filter((unit) => unit.state !== "UNKNOWN")
                .slice(0, 8)
                .map((unit) => (
                  <li key={`${unit.teamSlug}-${unit.kind}`}>
                    {unit.teamSlug} {unit.kind.replaceAll("_", " ")} · {unit.state.replaceAll("_", " ")}
                  </li>
                ))}
            </ul>
          )}
        </IntelBlock>
        <IntelBlock title="Tactical matchups">
          {report.matchups.every((row) => row.level === "UNKNOWN") ? (
            <p>No declared tactical archetypes. Matchup dimensions remain UNKNOWN.</p>
          ) : (
            <ul className="space-y-1">
              {report.matchups
                .filter((row) => row.level !== "UNKNOWN")
                .map((row) => (
                  <li key={row.id}>
                    {row.id.replaceAll("_", " ")} · {row.level}
                    {row.favors !== "unknown" && row.favors !== "neither" ? ` · favors ${row.favors === "home" ? homeName : awayName}` : ""}
                    {row.sterilePossessionRisk ? " · sterile-possession risk" : ""}
                  </li>
                ))}
            </ul>
          )}
        </IntelBlock>
        <IntelBlock title="Kill vs resistance">
          <ul className="space-y-1">
            {report.killResistance.map((row) => (
              <li key={row.teamSlug}>
                {row.teamSlug} · kill {row.killIndex ?? "UNKNOWN"} · resistance {row.resistanceIndex ?? "UNKNOWN"}
              </li>
            ))}
          </ul>
          <p className="mt-2">{report.killResistance[0]?.caveat}</p>
        </IntelBlock>
      </div>
      {report.conflicts.length ? (
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-xs">
          <p className="font-semibold">Source conflicts</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {report.conflicts.map((conflict) => (
              <li key={`${conflict.subjectId}-${conflict.field}`}>
                {conflict.subjectId} {conflict.field}: {conflict.left} vs {conflict.right}. {conflict.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function IntelStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-bold">{value}</p>
    </div>
  );
}

function IntelBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <p className="text-xs font-semibold">{title}</p>
      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
