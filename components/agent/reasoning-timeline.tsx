import { Check, Loader2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReasoningStep } from "@/lib/agent/types";

interface Props {
  steps: ReasoningStep[];
  /** When true, the last non-completed step pulses as "running". */
  live?: boolean;
}

/** The research system's visible workflow — a vertical timeline of reasoning steps. */
export function ReasoningTimeline({ steps }: Props) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
          Research trace
        </span>
        <span className="chip text-[10px]">{steps.length} steps</span>
      </div>

      <ol className="relative space-y-5">
        {steps.map((s, i) => {
          const isLast = i === steps.length - 1;
          return (
            <li key={s.id} className="relative flex gap-4">
              {/* connector line */}
              {!isLast && (
                <span className="absolute left-[15px] top-8 h-[calc(100%+4px)] w-px bg-gradient-to-b from-neon/40 to-white/5" />
              )}
              {/* status dot */}
              <span
                className={cn(
                  "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                  s.status === "completed" && "border-neon/40 bg-neon/10 text-neon",
                  s.status === "running" && "border-electric/40 bg-electric/10 text-electric",
                  s.status === "pending" && "border-white/10 bg-white/[0.03] text-muted-foreground"
                )}
              >
                {s.status === "completed" && <Check className="h-4 w-4" strokeWidth={3} />}
                {s.status === "running" && <Loader2 className="h-4 w-4 animate-spin" />}
                {s.status === "pending" && <Circle className="h-3 w-3" />}
              </span>

              <div className="flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">
                    Step {i + 1}: {s.title}
                  </p>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      s.status === "completed" && "bg-neon/15 text-neon",
                      s.status === "running" && "bg-electric/15 text-electric",
                      s.status === "pending" && "bg-white/5 text-muted-foreground"
                    )}
                  >
                    {s.status}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{s.description}</p>
                {s.detail && (
                  <p className="mt-1 rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs text-muted-foreground/90">
                    {s.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
