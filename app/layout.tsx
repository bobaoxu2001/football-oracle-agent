import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/site/navbar";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const SITE_NAME = "Football Oracle";
const SITE_TITLE = "Football Oracle · Auditable Premier League production forecasts";
const SITE_DESCRIPTION =
  "Auditable Premier League match probabilities, exact-score distributions and grounded model explanations from immutable production forecasts.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "Premier League",
    "pre-match forecasts",
    "probability distributions",
    "production ledger",
    "forecast audit",
    "expected goals",
    "Dixon-Coles",
  ],
  openGraph: {
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="stadium-bg min-h-screen font-sans">
        <a href="#main-content" className="sr-only left-3 top-3 z-50 rounded-lg bg-neon px-4 py-2 text-sm font-bold text-primary-foreground focus:not-sr-only focus:fixed focus:outline-none focus:ring-2 focus:ring-white">
          Skip to main content
        </a>
        <div className="relative flex min-h-screen flex-col">
          <Navbar />
          <main id="main-content" tabIndex={-1} className="flex-1">{children}</main>
          <footer className="border-t border-white/5 py-8 text-center text-xs text-muted-foreground">
            <p>
              Football Oracle · Auditable Premier League production forecasts · Elo + Dixon-Coles.
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
