"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Sparkles,
  Loader2,
  Cpu,
  Lightbulb,
  Film,
  RefreshCw,
  Database,
  Mic,
  Volume2,
  Square,
  Globe,
} from "lucide-react";
import { ReasoningTimeline } from "./reasoning-timeline";
import { PredictionCard } from "./prediction-card";
import { SimulationCenter } from "./simulation-center";
import { ChampionBoard } from "./champion-board";
import { RecentPredictions } from "./recent-predictions";
import { NewsImpact } from "./news-impact";
import { TeamNewsDigest } from "./team-news-digest";
import { DataTransparency } from "./data-transparency";
import { GeminiToolTrace } from "./gemini-tool-trace";
import { IntentBadge } from "./intent-badge";
import { FactorsCard } from "./factors-card";
import { GroupTableCard } from "./group-table-card";
import { TournamentStateBadge } from "./tournament-state-badge";
import { cn } from "@/lib/utils";
import type { AgentResponse, ReasoningStep } from "@/lib/agent/types";
import type { StoredPrediction, PersistMode } from "@/lib/db/mongodb";
import { LANGUAGES, DEFAULT_LANG, isLangCode, type LangCode } from "@/lib/i18n/languages";
import { SUGGESTED_PROMPTS, t } from "@/lib/i18n/prompts";

// Judge-friendly demo rail: one prompt per flagship capability. Each click goes
// through the normal submit() path, so behavior is identical to typing.
const DEMO_PROMPTS: { q: string; hint: string }[] = [
  { q: "谁会赢得世界杯冠军？", hint: "Chinese tournament forecast — DeepSeek narrative" },
  { q: "Can Portugal still win the World Cup?", hint: "Live tournament-state gating (football-data.org)" },
  { q: "How do best third-place teams advance?", hint: "2026 rules explainer" },
  { q: "Compare Argentina and France", hint: "Team comparison — model dimensions" },
  { q: "Brazil locker room conflict", hint: "Contextual news signals (GNews)" },
  { q: "Argentina's path to the final", hint: "Gemini escalation · bracket path reasoning" },
];

// Minimal local typings for the Web Speech API (not in every TS lib version).
interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const THINKING_STEPS = [
  "Understanding your question",
  "Resolving teams & loading data",
  "Pulling recent team news (injuries, squad)",
  "Running 10,000 Monte Carlo simulations",
  "Generating the news-aware report",
];

interface Turn {
  id: number;
  query: string;
  isFollowUp: boolean;
  status: "analyzing" | "done" | "error";
  response?: AgentResponse;
  error?: string;
  progress: number; // 0..THINKING_STEPS.length for the animated thinking state
}

export function AgentChat({
  initialRecent,
  initialQuery,
  geminiTools = false,
}: {
  initialRecent: { items: StoredPrediction[]; source: PersistMode };
  /** Deep-linked question (/?q=…) — auto-submitted once on mount. */
  initialQuery?: string;
  /** Server-checked flag: the Gemini function-calling tool loop is available. */
  geminiTools?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [recent, setRecent] = useState(initialRecent);
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState<LangCode>(DEFAULT_LANG);
  const [listening, setListening] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // Restore the chosen language; detect speech-recognition support (client only).
  useEffect(() => {
    const timer = window.setTimeout(() => {
    try {
      const saved = localStorage.getItem("wcoa-lang");
      if (saved && isLangCode(saved)) setLang(saved);
    } catch {
      /* ignore */
    }
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    setSpeechSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const changeLang = useCallback((code: LangCode) => {
    setLang(code);
    setVoiceMsg(null);
    try {
      localStorage.setItem("wcoa-lang", code);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/predictions/recent?limit=6", { cache: "no-store" });
      const data = await res.json();
      setRecent({ items: data.items, source: data.source });
    } catch {
      /* ignore — memory rail is best-effort */
    }
  }, []);

  const lastContextTeams = useCallback((): string[] | undefined => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const r = turns[i].response;
      if (r?.prediction) return [r.prediction.teamA.slug, r.prediction.teamB.slug];
    }
    return undefined;
  }, [turns]);

  const submit = useCallback(
    async (rawQuery: string, isFollowUp = false) => {
      const query = rawQuery.trim();
      if (!query || busy) return;
      setBusy(true);
      setInput("");

      const id = nextId.current++;
      const contextTeams = isFollowUp ? lastContextTeams() : undefined;
      setTurns((t) => [...t, { id, query, isFollowUp, status: "analyzing", progress: 0 }]);

      // Animated "thinking" — advance the placeholder steps for demo drama.
      const startedAt = Date.now();
      const interval = setInterval(() => {
        setTurns((t) =>
          t.map((tn) =>
            tn.id === id && tn.status === "analyzing"
              ? { ...tn, progress: Math.min(tn.progress + 1, THINKING_STEPS.length) }
              : tn
          )
        );
      }, 480);

      try {
        const res = await fetch("/api/agent/predict", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, isFollowUp, contextTeams, language: lang }),
        });
        const data = (await res.json()) as AgentResponse & { error?: string };

        // Keep the thinking animation visible for a minimum beat.
        const elapsed = Date.now() - startedAt;
        if (elapsed < 1900) await new Promise((r) => setTimeout(r, 1900 - elapsed));
        clearInterval(interval);

        if (data.error) {
          setTurns((t) =>
            t.map((tn) => (tn.id === id ? { ...tn, status: "error", error: data.error } : tn))
          );
        } else {
          setTurns((t) =>
            t.map((tn) =>
              tn.id === id ? { ...tn, status: "done", response: data } : tn
            )
          );
          refreshRecent();
        }
      } catch {
        clearInterval(interval);
        setTurns((t) =>
          t.map((tn) =>
            tn.id === id
              ? { ...tn, status: "error", error: "Network error — please try again." }
              : tn
          )
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, lang, lastContextTeams, refreshRecent]
  );

  // Deep-linked question (/?q=… from Schedule rows / Daily Brief chips):
  // auto-submit through the normal submit() path. Tracking the last submitted
  // query (not a boolean) lets a SECOND brief chip clicked from the homepage
  // fire too, while never re-submitting the same query twice.
  const lastAutoQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!initialQuery || lastAutoQuery.current === initialQuery) return;
    lastAutoQuery.current = initialQuery;
    submit(initialQuery);
  }, [initialQuery, submit]);

  // ── Voice input (Web Speech API · native, no dependency) ──────────────────
  const startVoice = useCallback(() => {
    if (busy) return;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setVoiceMsg(t(lang, "voiceUnsupported"));
      return;
    }
    try {
      const rec = new SR();
      rec.lang = lang;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = () => {
        setListening(true);
        setVoiceMsg(t(lang, "listening"));
      };
      rec.onresult = (e: SpeechRecognitionEventLike) => {
        const transcript = e.results?.[0]?.[0]?.transcript ?? "";
        setVoiceMsg(null);
        if (transcript.trim()) {
          setInput(transcript);
          submit(transcript);
        }
      };
      rec.onerror = (e: { error?: string }) => {
        setListening(false);
        setVoiceMsg(
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? t(lang, "micDenied")
            : t(lang, "voiceError")
        );
      };
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      rec.start();
    } catch {
      setListening(false);
      setVoiceMsg(t(lang, "voiceError"));
    }
  }, [busy, lang, submit]);

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const hasPrediction = turns.some((t) => t.response?.prediction);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      {/* ── main column ── */}
      <div className="space-y-6">
        {/* empty state / hero prompt */}
        {turns.length === 0 && (
          <div className="glass rounded-2xl p-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-neon to-electric text-2xl shadow-glow">
              ⚽
            </div>
            <h2 className="text-lg font-bold">Ask the Oracle anything about the 2026 World Cup</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              I&apos;ll plan the analysis, resolve the teams, run 10,000 Monte Carlo simulations,
              explain my reasoning, and remember the result.
            </p>

            {/* judge-friendly demo rail — one click per flagship capability */}
            <div className="mt-4 border-t border-white/[0.06] pt-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-neon">
                Try these
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {DEMO_PROMPTS.map((p) => (
                  <button
                    key={p.q}
                    onClick={() => submit(p.q)}
                    disabled={busy}
                    title={p.hint}
                    className="rounded-full border border-neon/20 bg-neon/[0.05] px-3.5 py-1.5 text-xs font-medium text-foreground transition hover:border-neon/50 hover:bg-neon/[0.1] disabled:opacity-50"
                  >
                    {p.q}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground/60">
                Routine answers use <span className="text-foreground/80">DeepSeek</span>. Complex path, group, and
                multi-step reasoning escalates to <span className="text-foreground/80">Gemini</span>. Deterministic
                engines own probabilities and rules.
              </p>
            </div>
          </div>
        )}

        {/* conversation transcript */}
        {turns.map((turn) => (
          <div key={turn.id} className="space-y-4">
            {/* user query bubble */}
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-neon/20 bg-neon/[0.06] px-4 py-2.5 text-sm font-medium">
                {turn.isFollowUp && (
                  <span className="mr-1.5 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-neon">
                    <RefreshCw className="h-3 w-3" /> follow-up
                  </span>
                )}
                {turn.query}
              </div>
            </div>

            {/* agent response */}
            {turn.status === "analyzing" && <ThinkingPanel progress={turn.progress} />}

            {turn.status === "error" && (
              <div className="glass rounded-2xl border-red-500/20 p-4 text-sm text-red-300">
                {turn.error}
              </div>
            )}

            {turn.status === "done" && turn.response && (
              <AgentAnswer
                response={turn.response}
                query={turn.query}
                geminiTools={geminiTools}
                onFollowUp={(q) => submit(q, true)}
                isLatest={turn.id === turns[turns.length - 1].id}
                busy={busy}
              />
            )}
          </div>
        ))}

        {/* suggested prompts (localized display, English canonical query) */}
        {(!hasPrediction || turns.length === 0) && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS[lang].map((s) => (
              <button
                key={s.display}
                onClick={() => submit(s.query)}
                disabled={busy}
                className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-neon/30 hover:text-foreground disabled:opacity-50"
              >
                {s.display}
              </button>
            ))}
          </div>
        )}

        {/* input + Global Voice Mode controls */}
        <div className="sticky bottom-4 z-30 space-y-2">
          {/* Global Voice Mode bar */}
          <div className="glass flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold text-neon">
              <Globe className="h-3.5 w-3.5" /> Global Voice Mode
            </span>
            <label className="inline-flex items-center gap-1.5">
              <span className="sr-only">{t(lang, "language")}</span>
              <select
                value={lang}
                onChange={(e) => changeLang(e.target.value as LangCode)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-medium text-foreground outline-none transition hover:border-neon/30"
                aria-label={t(lang, "language")}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-background text-foreground">
                    {l.flag} {l.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-muted-foreground">
              {voiceMsg ?? t(lang, "voiceHelper")}
            </span>
          </div>

          {/* input row */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <div className="glass flex items-center gap-2 rounded-2xl p-2 shadow-glow">
              <Sparkles className="ml-2 h-4 w-4 shrink-0 text-neon" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t(lang, "placeholder")}
                // A placeholder is not a reliable accessible name, so the field
                // is labelled explicitly. maxLength mirrors the 300-character
                // limit /api/agent/predict enforces, so an over-long question
                // is stopped at the keyboard instead of coming back as a 400.
                aria-label={t(lang, "placeholder")}
                maxLength={300}
                className="flex-1 bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground/70"
                disabled={busy}
              />
              {speechSupported && (
                <button
                  type="button"
                  onClick={listening ? stopVoice : startVoice}
                  disabled={busy}
                  aria-label={listening ? "Stop voice input" : "Start voice input"}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-xl border transition disabled:opacity-40",
                    listening
                      ? "border-red-500/40 bg-red-500/15 text-red-300 animate-pulse"
                      : "border-white/10 bg-white/[0.04] text-muted-foreground hover:border-neon/30 hover:text-foreground"
                  )}
                >
                  <Mic className="h-4 w-4" />
                </button>
              )}
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-neon to-electric text-background transition hover:opacity-90 disabled:opacity-40"
                aria-label="Send"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </form>
        </div>

        <div ref={bottomRef} />
      </div>

      {/* ── side rail ── */}
      <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
        <RecentPredictions items={recent.items} source={recent.source} />
        <PipelineCard />
      </aside>
    </div>
  );
}

/* ───────────────────────── sub-components ───────────────────────── */

function ThinkingPanel({ progress }: { progress: number }) {
  const steps: ReasoningStep[] = THINKING_STEPS.map((title, i) => ({
    id: `thinking-${i}`,
    title,
    description:
      i < progress
        ? "Done."
        : i === progress
          ? "Working…"
          : "Queued.",
    status: i < progress ? "completed" : i === progress ? "running" : "pending",
  }));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-neon">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="font-medium">Analyzing…</span>
      </div>
      <ReasoningTimeline steps={steps} live />
    </div>
  );
}

function AgentAnswer({
  response,
  query,
  geminiTools,
  onFollowUp,
  isLatest,
  busy,
}: {
  response: AgentResponse;
  /** The user's original question — replayed through the Gemini tool loop on demand. */
  query: string;
  geminiTools: boolean;
  onFollowUp: (q: string) => void;
  isLatest: boolean;
  busy: boolean;
}) {
  const { prediction, simulation, champions, newsImpact, teamNews } = response;
  const answerLang: LangCode = isLangCode(response.language) ? response.language : "en-US";
  const speakText = response.localizedSummary || plainText(response.explanation);
  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <IntentBadge intent={response.intent} />
      </div>

      <ReasoningTimeline steps={response.reasoningSteps} />

      {prediction && <PredictionCard p={prediction} />}
      {newsImpact && <NewsImpact report={newsImpact} provider={response.newsProvider} />}
      {prediction && simulation && (
        <SimulationCenter sim={simulation} teamA={prediction.teamA} teamB={prediction.teamB} />
      )}
      {response.groupTable && <GroupTableCard table={response.groupTable} />}
      {response.structured && !prediction && <FactorsCard structured={response.structured} />}
      {teamNews && (
        <TeamNewsDigest view={teamNews} source={response.newsSource} provider={response.newsProvider} />
      )}
      {champions && <ChampionBoard c={champions} />}

      {response.tournamentState && <TournamentStateBadge state={response.tournamentState} />}

      {(prediction || champions) && <DataTransparency response={response} />}

      {/* Live Gemini function-calling: replay this question through the tool
          loop and show which tools Gemini chose. Only rendered when a Gemini
          key is configured (server-checked); on-demand, so zero added latency. */}
      {geminiTools && (prediction || champions) && <GeminiToolTrace query={query} />}

      {/* concise uncertainty disclaimer on every probability-bearing answer */}
      {(prediction || champions || response.structured?.probabilities) && (
        <p className="px-1 text-[10px] leading-relaxed text-muted-foreground/60">
          ⚖️ Probabilities are model estimates, not guarantees. They combine historical strength,
          simulations, live tournament state, and capped news signals.
        </p>
      )}

      {response.persisted !== "none" && <MemoryBadge persisted={response.persisted} />}

      {/* Why? explanation */}
      <div className="glass rounded-2xl p-5">
        <div className="mb-2 flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-neon" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
            {t(answerLang, "why")}
          </span>
          <span
            className={cn(
              "chip text-[10px]",
              response.llmEnhanced ? "text-neon" : "text-muted-foreground"
            )}
          >
            <Cpu className="h-3 w-3" />
            {response.llmProvider === "gemini"
              ? "Gemini escalation · complex multi-step reasoning"
              : response.llmProvider === "deepseek"
                ? "DeepSeek-enhanced"
                : response.llmEnhanced
                  ? "LLM-enhanced"
                  : "Deterministic engine"}
          </span>
          <span className="ml-auto">
            <SpeakButton text={speakText} lang={answerLang} listenLabel={t(answerLang, "listen")} stopLabel={t(answerLang, "stop")} />
          </span>
        </div>

        {/* localized result headline (in the selected language; also spoken) */}
        {response.localizedSummary && (
          <p className="mb-3 rounded-xl border border-neon/20 bg-neon/[0.05] px-4 py-2.5 text-sm font-semibold">
            {response.localizedSummary}
          </p>
        )}

        <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
          {response.explanation.split("\n").map((line, i) =>
            line.trim() ? (
              <p key={i} dangerouslySetInnerHTML={{ __html: mdLite(line) }} />
            ) : null
          )}
        </div>

        {/* fan insight */}
        <div className="mt-4 rounded-xl border border-electric/20 bg-electric/[0.05] px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-electric">
            {t(answerLang, "fanInsight")}
          </p>
          <p className="mt-1 text-sm">{response.fanInsight}</p>
        </div>

        {/* tiktok script */}
        {response.tiktokScript && (
          <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Film className="h-3.5 w-3.5" /> TikTok-style preview
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {response.tiktokScript}
            </pre>
          </div>
        )}
      </div>

      {/* follow-up affordance (only on the latest turn) */}
      {isLatest && (prediction || teamNews) && (
        <div className="glass rounded-2xl p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t(answerLang, "followUp")}
          </p>
          <div className="flex flex-wrap gap-2">
            {(prediction
              ? buildMatchFollowUps(response)
              : teamNewsFollowUps(teamNews!.team.name)
            ).map((q) => (
              <button
                key={q}
                onClick={() => onFollowUp(q)}
                disabled={busy}
                className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-neon/30 hover:text-foreground disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineCard() {
  const stages = [
    "User Query",
    "Agent Planner",
    "Match Resolver",
    "Daily News Resolver",
    "Injury / Squad Analyzer",
    "Prediction Engine",
    "Monte Carlo Simulator",
    "Explanation Generator",
    "MongoDB Memory",
  ];
  return (
    <div className="glass rounded-2xl p-5">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-neon">
        Agent pipeline
      </span>
      <ol className="mt-3 space-y-1.5">
        {stages.map((s, i) => (
          <li key={s} className="flex items-center gap-2 text-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/[0.05] text-[10px] font-bold text-neon">
              {i + 1}
            </span>
            <span className="text-foreground/85">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Text-to-speech toggle for an answer (browser SpeechSynthesis; never autoplay). */
function SpeakButton({
  text,
  lang,
  listenLabel,
  stopLabel,
}: {
  text: string;
  lang: LangCode;
  listenLabel: string;
  stopLabel: string;
}) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSupported(typeof window !== "undefined" && "speechSynthesis" in window),
      0
    );
    return () => {
      window.clearTimeout(timer);
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, []);

  if (!supported || !text) return null;

  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-medium transition",
        speaking
          ? "border-neon/40 bg-neon/10 text-neon"
          : "border-white/10 bg-white/[0.03] text-muted-foreground hover:border-neon/30 hover:text-foreground"
      )}
      aria-label={speaking ? stopLabel : listenLabel}
    >
      {speaking ? <Square className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
      {speaking ? stopLabel : listenLabel}
    </button>
  );
}

/** Strip light markdown/bullets so text-to-speech reads cleanly. */
function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[#*_`>]/g, "")
    .replace(/^[•\-]\s?/gm, "")
    .replace(/\n+/g, ". ")
    .trim();
}

/** Memory-saved indicator — makes the MongoDB memory layer visible in the flow. */
function MemoryBadge({ persisted }: { persisted: "mongodb" | "memory" }) {
  const mongo = persisted === "mongodb";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-xs">
      <Database className={cn("h-3.5 w-3.5", mongo ? "text-neon" : "text-muted-foreground")} />
      <span className="text-muted-foreground">
        Saved to agent memory ·{" "}
        <span className={cn("font-semibold", mongo ? "text-neon" : "text-foreground")}>
          {mongo ? "MongoDB Atlas" : "In-memory fallback"}
        </span>
        {" "}— this session, its probabilities and news context are now recallable.
      </span>
    </div>
  );
}

/** Context-aware follow-ups: leads with an injury-return what-if when relevant. */
function buildMatchFollowUps(r: AgentResponse): string[] {
  const a = r.prediction!.teamA.name;
  const b = r.prediction!.teamB.name;
  const list: string[] = [];
  const injuryReturn = r.newsImpact ? injuryReturnPrompt(r.newsImpact) : null;
  if (injuryReturn) list.push(injuryReturn);
  list.push("Does the latest injury news change the prediction?");
  list.push(`What if ${a} are in great form?`);
  list.push(`Give me a TikTok-style preview for ${a} vs ${b}`);
  return Array.from(new Set(list)).slice(0, 4);
}

/** "What if {Team}'s injured {role} returns?" from the top negative injury item. */
function injuryReturnPrompt(report: NonNullable<AgentResponse["newsImpact"]>): string | null {
  type Cand = { team: string; role: string; w: number };
  let best: Cand | null = null;
  for (const tv of [report.teamA, report.teamB]) {
    for (const it of tv.items) {
      const bad = it.direction === "negative" && (it.category === "injury" || it.category === "suspension");
      if (!bad || it.impactLevel === "low") continue;
      const w = it.impactLevel === "high" ? 2 : 1;
      if (!best || w > best.w) {
        best = { team: tv.team.name, role: roleFromTitle(it.title), w };
      }
    }
  }
  return best ? `What if ${best.team}'s injured ${best.role} returns?` : null;
}

function roleFromTitle(title: string): string {
  const m = title.match(
    /\b(goalkeeper|keeper|defender|fullback|full-back|midfielder|winger|forward|striker)\b/i
  );
  return m ? m[1].toLowerCase() : "key player";
}

function teamNewsFollowUps(name: string): string[] {
  const opps = ["France", "Brazil", "Germany", "Spain"].filter((o) => o !== name);
  return [
    `Who will win ${name} vs ${opps[0]} based on latest team news?`,
    `Predict ${name} vs ${opps[1]} and include news impact`,
  ];
}

/** Tiny markdown: **bold** only. Input is model-generated, not user HTML. */
function mdLite(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic emphasis — used by the deterministic honesty notes (betting
    // disclaimer, fixture caveat, data-freshness footnote). Runs after bold so
    // the two never collide. Without this they render as literal "_underscores_".
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/^•\s?/, "<span class='text-neon'>•</span> ");
}
