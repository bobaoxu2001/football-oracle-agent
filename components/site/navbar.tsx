import Link from "next/link";

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-background/70 backdrop-blur-xl">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-neon to-electric text-lg shadow-glow">
            🔮
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-bold tracking-tight">
              Football <span className="neon-text">Oracle</span>
            </span>
            <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              PL · World Cup
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/"
            className="rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground sm:px-3"
          >
            Agent
          </Link>
          <Link
            href="/schedule"
            className="rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground sm:px-3"
          >
            Schedule
          </Link>
          <Link
            href="/accuracy"
            className="rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground sm:px-3"
          >
            <span className="hidden sm:inline">Track </span>Record
          </Link>
          <Link
            href="/news"
            className="rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground sm:px-3"
          >
            <span className="hidden sm:inline">Daily </span>News
          </Link>
          <Link
            href="/memory"
            className="rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground sm:px-3"
          >
            Memory
          </Link>
          <a
            href="https://github.com/bobaoxu2001/worldcup-oracle-agent"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-neon/30 hover:text-foreground sm:inline-block"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
