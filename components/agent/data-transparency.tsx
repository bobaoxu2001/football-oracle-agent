import {
  ShieldCheck,
  Gauge,
  Sigma,
  Dices,
  Newspaper,
  Database,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentResponse } from "@/lib/agent/types";

/**
 * Data transparency card — shows exactly what produced this research answer, with
 * values reflecting the CURRENT runtime state (live vs demo, Mongo vs memory,
 * Gemini vs deterministic). Builds trust that this is not fabricated AI output.
 */
export function DataTransparency({ response }: { response: AgentResponse }) {
  const isMatch = Boolean(response.prediction);

  const news =
    response.newsSource === "api"
      ? { value: `Live · ${response.newsProvider ?? "news API"}`, live: true }
      : response.newsSource === "demo"
        ? { value: "Demo sample signals", live: false }
        : { value: "Not used (tournament-level)", live: false };

  const memory =
    response.persisted === "mongodb"
      ? { value: "MongoDB Atlas", strong: true }
      : response.persisted === "memory"
        ? { value: "In-memory fallback", strong: false }
        : { value: "Not persisted", strong: false };

  const llm =
    response.llmProvider === "gemini"
      ? { value: "Gemini · complex-reasoning escalation", strong: true }
      : response.llmProvider === "deepseek"
        ? { value: "DeepSeek · routine narrative/localization", strong: true }
        : response.llmEnhanced
          ? { value: "LLM-enhanced prose", strong: true }
          : { value: "None · deterministic rules engine", strong: false };

  const rows = [
    { icon: <Gauge className="h-3.5 w-3.5" />, label: "Team strength", value: "Calibrated Elo ratings", strong: true },
    { icon: <Sigma className="h-3.5 w-3.5" />, label: "Match model", value: "Dixon-Coles bivariate Poisson", strong: true },
    {
      icon: <Dices className="h-3.5 w-3.5" />,
      label: "Simulation",
      value: isMatch ? "10,000 seeded Monte Carlo runs" : "10,000-run tournament Monte Carlo",
      strong: true,
    },
    { icon: <Newspaper className="h-3.5 w-3.5" />, label: "News", value: news.value, strong: news.live },
    { icon: <Database className="h-3.5 w-3.5" />, label: "Private storage", value: memory.value, strong: memory.strong },
    { icon: <Cpu className="h-3.5 w-3.5" />, label: "LLM", value: llm.value, strong: llm.strong },
  ];

  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-neon" />
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
          Data used (transparency)
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {r.icon}
              {r.label}
            </span>
            <span
              className={cn(
                "text-right text-xs font-semibold",
                r.strong ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
        Probabilities come from the deterministic statistical engine. The news and LLM layers only
        adjust or explain using transparent, capped rules — never fabricated numbers.
      </p>
    </div>
  );
}
