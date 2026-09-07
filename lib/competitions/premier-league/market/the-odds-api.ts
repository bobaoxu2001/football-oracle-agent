/**
 * The Odds API v4 adapter.
 *
 * Official host: https://api.the-odds-api.com
 * Docs: https://the-odds-api.com/liveapi/guides/v4/
 *
 * Phase 2B0 request:
 *   GET /v4/sports/soccer_epl/odds
 *     regions=uk
 *     markets=h2h
 *     oddsFormat=decimal
 *
 * One league-level call. Quota headers:
 *   x-requests-remaining, x-requests-used, x-requests-last
 */

import { redactCredentialText } from "@/lib/competitions/premier-league/ops/secrets";
import type { MarketDataSource, MarketSourceEvent, MarketSourceFetchResult } from "./types";
import { MARKET_SOURCE_THE_ODDS_API, MARKET_TYPE_H2H } from "./types";

export const ODDS_API_HOST = "https://api.the-odds-api.com";
export const ODDS_API_SPORT = "soccer_epl";
export const ODDS_API_REGION = "uk";
export const ODDS_API_TIMEOUT_MS = 8_000;

export function oddsApiConfigured(): boolean {
  return Boolean(process.env.ODDS_API_KEY);
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface RawEvent {
  id?: string;
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: Array<{
    key?: string;
    title?: string;
    last_update?: string;
    markets?: Array<{
      key?: string;
      outcomes?: Array<{ name?: string; price?: number }>;
    }>;
  }>;
}

export class TheOddsApiMarketSource implements MarketDataSource {
  readonly id = MARKET_SOURCE_THE_ODDS_API;

  get configured(): boolean {
    return oddsApiConfigured();
  }

  async fetchH2h(nowIso: string): Promise<MarketSourceFetchResult> {
    const key = process.env.ODDS_API_KEY ?? "";
    if (!key) throw new Error("ODDS_API_KEY is not configured");
    // The Odds API v4 requires apiKey as a query parameter (MISSING_KEY if
    // omitted). Keep it out of diagnostics; see redactCredentialText.
    const url = new URL(`${ODDS_API_HOST}/v4/sports/${ODDS_API_SPORT}/odds`);
    url.searchParams.set("apiKey", key);
    url.searchParams.set("regions", ODDS_API_REGION);
    url.searchParams.set("markets", MARKET_TYPE_H2H);
    url.searchParams.set("oddsFormat", "decimal");
    url.searchParams.set("dateFormat", "iso");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ODDS_API_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "football-oracle-market-recorder",
        },
      });
    } catch (err) {
      throw new Error(
        `the-odds-api request failed: ${redactCredentialText((err as Error).message, [key])}`
      );
    } finally {
      clearTimeout(timer);
    }

    const quota = {
      remaining: headerNumber(res.headers, "x-requests-remaining"),
      used: headerNumber(res.headers, "x-requests-used"),
      lastRequestCost: headerNumber(res.headers, "x-requests-last"),
    };

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const safeBody = body ? redactCredentialText(body.slice(0, 200), [key]) : "";
      throw new Error(`the-odds-api HTTP ${res.status}${safeBody ? `: ${safeBody}` : ""}`);
    }

    const payload = (await res.json()) as RawEvent[];
    if (!Array.isArray(payload)) throw new Error("the-odds-api: expected an event array");

    const events: MarketSourceEvent[] = payload.map((row) => ({
      source: MARKET_SOURCE_THE_ODDS_API,
      sourceEventId: String(row.id ?? ""),
      sportKey: row.sport_key ?? ODDS_API_SPORT,
      homeTeam: String(row.home_team ?? ""),
      awayTeam: String(row.away_team ?? ""),
      commenceTime: row.commence_time ?? null,
      bookmakers: (row.bookmakers ?? []).map((bk) => {
        const h2h = (bk.markets ?? []).find((m) => m.key === MARKET_TYPE_H2H);
        return {
          bookmakerKey: String(bk.key ?? ""),
          bookmakerName: String(bk.title ?? bk.key ?? ""),
          lastUpdate: bk.last_update ?? null,
          outcomes: (h2h?.outcomes ?? [])
            .filter((o) => o.name && typeof o.price === "number")
            .map((o) => ({ name: String(o.name), price: o.price as number })),
        };
      }),
    }));

    return {
      source: MARKET_SOURCE_THE_ODDS_API,
      retrievedAt: nowIso,
      region: ODDS_API_REGION,
      sportKey: ODDS_API_SPORT,
      marketType: MARKET_TYPE_H2H,
      events,
      quota,
    };
  }
}

/** Map bookmaker outcomes by name, never by array order. */
export function extractH2hOdds(
  outcomes: { name: string; price: number }[],
  homeTeam: string,
  awayTeam: string
): { home: number; draw: number; away: number } | null {
  const norm = (s: string) => s.trim().toLowerCase();
  let home: number | null = null;
  let draw: number | null = null;
  let away: number | null = null;
  for (const o of outcomes) {
    const n = norm(o.name);
    if (n === "draw" || n === "tie" || n === "x") draw = o.price;
    else if (n === norm(homeTeam)) home = o.price;
    else if (n === norm(awayTeam)) away = o.price;
  }
  if (home == null || draw == null || away == null) return null;
  return { home, draw, away };
}
