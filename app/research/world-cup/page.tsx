import type { Metadata } from "next";
import { AgentChat } from "@/components/agent/agent-chat";
import { geminiAgentEnabled } from "@/lib/llm/geminiAgent";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "World Cup research archive · Football Oracle",
  description: "Archived World Cup agent research, separated from Premier League production forecasting.",
};

export default async function WorldCupResearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const initialQuery = typeof q === "string" && q.trim() ? q.trim().slice(0, 300) : undefined;
  return (
    <div className="container py-8 md:py-12">
      <section className="mx-auto mb-8 max-w-3xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Research archive · separate evidence track</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">World Cup research archive</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          This archived research system is not the Premier League production product. Its displayed walk-forward results and reconstructed analysis stay on their own track and must not be read as live Premier League performance.
        </p>
        <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-3 text-xs text-amber-100">
          Privacy: questions and answers are never published in a global recent-session feed. Private storage is operational infrastructure, not a consumer feature.
        </p>
      </section>
      <AgentChat initialQuery={initialQuery} geminiTools={geminiAgentEnabled()} />
    </div>
  );
}
