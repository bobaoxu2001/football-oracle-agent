"use client";

import { FormEvent, useState } from "react";
import { Bot, LoaderCircle, Send, ShieldCheck } from "lucide-react";
import type { MatchAgentResponse } from "@/lib/match-forecast/agent";

export function MatchRoomAgent({ matchId, home, away }: { matchId: string; home: string; away: string }) {
  const arsenalMatch = /arsenal/i.test(`${home} ${away}`);
  const suggestions = [
    `Who is the model favorite in ${home} vs ${away}?`,
    "What is the probability of over 2.5 goals?",
    "Will both teams score?",
    "What are the five most likely exact scores?",
    "Why does the production model lean this way?",
    "What changed since the previous forecast?",
    arsenalMatch ? "Is Saka expected to play?" : "Is the expected lineup available?",
    arsenalMatch ? "Was Saka's availability known at this forecast cutoff?" : "Was the expected lineup known at this forecast cutoff?",
    arsenalMatch ? "Did the model use Saka's availability?" : "Did the model use the expected lineup?",
    arsenalMatch ? "What if Saka doesn't start?" : "What if a key player doesn't start?",
  ];
  const [question, setQuestion] = useState(suggestions[0]);
  const [response, setResponse] = useState<MatchAgentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const clean = question.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await fetch(`/api/matches/${encodeURIComponent(matchId)}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: clean }),
      });
      const body = (await result.json()) as MatchAgentResponse & { message?: string };
      if (!result.ok) throw new Error(body.message || "The Match Agent is temporarily unavailable.");
      setResponse(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Match Agent is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass p-5 sm:p-6" aria-labelledby="ask-oracle-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon"><Bot className="h-4 w-4" /> Ask Oracle</p>
          <h2 id="ask-oracle-heading" className="mt-1 text-xl font-black">Question this forecast</h2>
          <p className="mt-2 text-sm text-muted-foreground">The agent can explain or retrieve frozen model facts. It cannot edit the forecast.</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:flex lg:overflow-x-auto lg:pb-2" aria-label="Suggested questions">
        {suggestions.map((item) => (
          <button key={item} type="button" onClick={() => setQuestion(item)} className="min-h-11 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[11px] leading-snug text-muted-foreground transition hover:border-neon/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon lg:shrink-0 lg:rounded-full lg:text-center lg:text-xs">{item}</button>
        ))}
      </div>
      <form className="mt-2 flex flex-col gap-2 sm:flex-row" onSubmit={ask}>
        <label className="sr-only" htmlFor="match-question">Question about this match</label>
        <textarea id="match-question" value={question} onChange={(event) => setQuestion(event.target.value.slice(0, 500))} rows={2} maxLength={500} className="min-h-12 flex-1 resize-none rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-neon/50 focus:ring-2 focus:ring-neon/20" placeholder="Ask about the forecast, context, known-at-cutoff evidence or a supported scenario…" />
        <button type="submit" disabled={busy || !question.trim()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-neon px-5 text-sm font-black text-primary-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{busy ? "Checking…" : "Ask"}
        </button>
      </form>
      {error ? <p className="mt-4 rounded-xl border border-red-400/20 bg-red-400/[0.06] p-3 text-sm text-red-200" role="alert">{error}</p> : null}
      {response ? (
        <div className="mt-5 space-y-3" aria-live="polite">
          <div className="grid gap-3 lg:grid-cols-3">
            <AnswerBlock label="Model fact" text={response.sections.modelFact} strong />
            <AnswerBlock label="Evidence" text={response.sections.evidence} />
            <AnswerBlock label="Interpretation" text={response.sections.interpretation} />
          </div>
          {response.narration.mode === "grounded-llm" ? (
            <div className="rounded-xl border border-electric/20 bg-electric/[0.05] p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-electric">Narrative layer · {response.narration.provider}</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{response.answer}</p>
            </div>
          ) : null}
          <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-neon" /> Numeric grounding validated · raw prompt not publicly persisted · production {response.modelVersion}</p>
        </div>
      ) : null}
    </section>
  );
}

function AnswerBlock({ label, text, strong = false }: { label: string; text: string; strong?: boolean }) {
  return <div className={`rounded-xl border p-4 ${strong ? "border-neon/25 bg-neon/[0.05]" : "border-white/10 bg-black/20"}`}><p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${strong ? "text-neon" : "text-muted-foreground"}`}>{label}</p><p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{text}</p></div>;
}
