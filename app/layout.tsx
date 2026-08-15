import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/site/navbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: "Football Oracle — Premier League forecasts + World Cup plugin",
  description:
    "An AI agent that forecasts Premier League matches with walk-forward Elo and Dixon-Coles, and still runs the preserved World Cup 2026 plugin.",
  keywords: [
    "World Cup 2026",
    "AI agent",
    "predictions",
    "Monte Carlo",
    "Elo",
    "Dixon-Coles",
    "Gemini",
    "MongoDB",
  ],
  openGraph: {
    title: "WorldCup Oracle Agent",
    description:
      "AI agent that analyzes World Cup matchups, runs simulations, explains predictions, and answers follow-ups in real time.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="stadium-bg min-h-screen font-sans">
        <div className="relative flex min-h-screen flex-col">
          <Navbar />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-white/5 py-8 text-center text-xs text-muted-foreground">
            <p>
              Football Oracle · Premier League baseline + World Cup plugin · Elo + Dixon-Coles.
            </p>
            <p className="mt-1">
              Predictions are model estimates for entertainment & informational use only.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
