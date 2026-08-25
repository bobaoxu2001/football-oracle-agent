"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Activity, ChevronDown, Orbit } from "lucide-react";

const primaryLinks = [
  ["Forecasts", "/"],
  ["Track record", "/accuracy"],
  ["Production ledger", "/live"],
] as const;

const researchLinks = [
  ["Shadow evaluation", "/shadow"],
  ["Historical data", "/matches"],
  ["World Cup research archive", "/research/world-cup"],
] as const;

const operationsLinks = [
  ["System health", "/health"],
  ["Market observations", "/market"],
] as const;

export function Navbar() {
  const pathname = usePathname();
  const desktopMenu = useRef<HTMLDetailsElement>(null);
  const mobileMenu = useRef<HTMLDetailsElement>(null);

  const closeDesktopMenu = () => desktopMenu.current?.removeAttribute("open");
  const closeMobileMenu = () => mobileMenu.current?.removeAttribute("open");

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-background/85 backdrop-blur-xl">
      <div className="container flex min-h-16 items-center justify-between gap-3 py-2">
        <Link href="/" className="group flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon" aria-label="Football Oracle home">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neon text-primary-foreground shadow-glow"><Orbit className="h-5 w-5" aria-hidden="true" /></span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-black tracking-tight">Football <span className="text-neon">Oracle</span></span>
            <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.17em] text-muted-foreground">Auditable forecasts</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary navigation">
          {primaryLinks.map(([label, href]) => <NavLink key={href} href={href} pathname={pathname}>{label}</NavLink>)}
          <details ref={desktopMenu} className="group relative">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">More <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden="true" /></summary>
            <div className="absolute right-0 mt-2 w-64 rounded-xl border border-white/10 bg-card p-2 shadow-2xl">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Research & evaluation</p>
              {researchLinks.map(([label, href]) => <MenuLink key={href} href={href} pathname={pathname} onSelect={closeDesktopMenu}>{label}</MenuLink>)}
              <p className="mt-2 border-t border-white/10 px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Operations</p>
              {operationsLinks.map(([label, href]) => <MenuLink key={href} href={href} pathname={pathname} onSelect={closeDesktopMenu}>{label}</MenuLink>)}
            </div>
          </details>
          <span className="ml-2 inline-flex items-center gap-1.5 rounded-full border border-neon/20 bg-neon/[0.06] px-2.5 py-1 text-[10px] font-semibold text-neon" aria-label="Premier League production forecasts active"><Activity className="h-3 w-3" aria-hidden="true" /> PL production</span>
        </nav>
        <details ref={mobileMenu} className="relative md:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-lg border border-white/10 px-3 py-2 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon">Menu</summary>
          <div className="absolute right-0 mt-2 max-h-[calc(100vh-5rem)] w-72 overflow-y-auto rounded-xl border border-white/10 bg-card p-2 shadow-2xl">
            <nav aria-label="Mobile navigation">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Product & evidence</p>
              {primaryLinks.map(([label, href]) => <MenuLink key={href} href={href} pathname={pathname} onSelect={closeMobileMenu}>{label}</MenuLink>)}
              <p className="mt-2 border-t border-white/10 px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Research & evaluation</p>
              {researchLinks.map(([label, href]) => <MenuLink key={href} href={href} pathname={pathname} onSelect={closeMobileMenu}>{label}</MenuLink>)}
              <p className="mt-2 border-t border-white/10 px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Operations</p>
              {operationsLinks.map(([label, href]) => <MenuLink key={href} href={href} pathname={pathname} onSelect={closeMobileMenu}>{label}</MenuLink>)}
            </nav>
          </div>
        </details>
      </div>
    </header>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/match/");
  if (href === "/matches") return pathname.startsWith("/matches") || pathname.startsWith("/team/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ href, pathname, children }: { href: string; pathname: string; children: React.ReactNode }) {
  const active = isActive(pathname, href);
  return <Link href={href} aria-current={active ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{children}</Link>;
}

function MenuLink({ href, pathname, onSelect, children }: { href: string; pathname: string; onSelect: () => void; children: React.ReactNode }) {
  const active = isActive(pathname, href);
  return <Link href={href} aria-current={active ? "page" : undefined} onClick={onSelect} className={`flex min-h-11 items-center rounded-lg px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon ${active ? "bg-white/[0.05] font-semibold text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"}`}>{children}</Link>;
}
