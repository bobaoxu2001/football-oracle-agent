import Link from "next/link";
import { Activity, ChevronDown, Orbit } from "lucide-react";

const researchLinks = [
  ["Track record", "/accuracy"],
  ["Production ledger", "/live"],
  ["Shadow lab", "/shadow"],
  ["Historical matches", "/matches"],
  ["World Cup archive", "/research/world-cup"],
  ["Data & privacy", "/memory"],
  ["System health", "/health"],
] as const;

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/85 backdrop-blur-xl">
      <div className="container flex min-h-16 items-center justify-between gap-3 py-2">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Football Oracle home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neon text-primary-foreground shadow-glow"><Orbit className="h-5 w-5" aria-hidden="true" /></span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-black tracking-tight">Football <span className="text-neon">Oracle</span></span>
            <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.17em] text-muted-foreground">Auditable forecasts</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
          <NavLink href="/">Forecasts</NavLink><NavLink href="/accuracy">Track record</NavLink>
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">Research <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" /></summary>
            <div className="absolute right-0 mt-2 w-56 rounded-xl border border-white/10 bg-card p-2 shadow-2xl">
              {researchLinks.slice(1).map(([label, href]) => <Link key={href} href={href} className="block rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground">{label}</Link>)}
            </div>
          </details>
          <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-neon/20 bg-neon/[0.06] px-2.5 py-1 text-[10px] font-semibold text-neon"><Activity className="h-3 w-3" /> PL live</span>
        </nav>
        <details className="relative md:hidden">
          <summary className="cursor-pointer list-none rounded-lg border border-white/10 px-3 py-2 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">Menu</summary>
          <div className="absolute right-0 mt-2 w-64 rounded-xl border border-white/10 bg-card p-2 shadow-2xl">
            <Link href="/" className="block rounded-lg px-3 py-2 text-sm font-semibold">Forecasts</Link>
            {researchLinks.map(([label, href]) => <Link key={href} href={href} className="block rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-white/[0.05] hover:text-foreground">{label}</Link>)}
          </div>
        </details>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">{children}</Link>;
}
