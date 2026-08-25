"use client";

export default function MatchRoomError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="container py-16"><div className="mx-auto max-w-lg rounded-2xl border border-red-400/20 bg-red-400/[0.05] p-6"><h2 className="text-xl font-black">Match Room could not load</h2><p className="mt-2 text-sm text-muted-foreground">The forecast was not replaced with a client-side estimate. Retry the canonical backend.</p><button onClick={reset} className="mt-5 min-h-11 rounded-xl bg-neon px-4 text-sm font-bold text-primary-foreground">Try again</button></div></div>;
}
