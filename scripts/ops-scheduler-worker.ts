/**
 * Authenticated 5-minute ops pinger.
 *
 *   OPS_TICK_URL=https://…/api/ops/tick CRON_SECRET=… npx tsx scripts/ops-scheduler-worker.ts
 *
 * Matches GitHub Actions: forecast-core (`?core=1`) and observers are separate
 * requests so a 60s Vercel tick cannot be killed mid-observer poll.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { durationMsFromEnv } from "@/lib/config/env";

export function appendQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

export function coreTickUrl(tickUrl: string, options: { backup?: boolean } = {}): string {
  const params: Record<string, string> = { core: "1" };
  if (options.backup) params.backup = "1";
  return appendQuery(tickUrl, params);
}

export function observersUrl(tickUrl: string, explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const parsed = new URL(tickUrl);
  parsed.pathname = parsed.pathname.replace(/\/tick\/?$/, "/observers");
  parsed.search = "";
  return parsed.toString();
}

export async function fireOpsCadence(options: {
  tickUrl: string;
  observerUrl?: string | null;
  secret: string;
  backup?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  core: { url: string; status: number; body: string };
  observers: { url: string; status: number; body: string };
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${options.secret}` };
  const coreUrl = coreTickUrl(options.tickUrl, { backup: options.backup });
  const observerUrl = observersUrl(options.tickUrl, options.observerUrl);
  const coreRes = await fetchImpl(coreUrl, { method: "GET", headers });
  const coreBody = await coreRes.text();
  const observerRes = await fetchImpl(observerUrl, { method: "GET", headers });
  const observerBody = await observerRes.text();
  return {
    core: { url: coreUrl, status: coreRes.status, body: coreBody.slice(0, 500) },
    observers: { url: observerUrl, status: observerRes.status, body: observerBody.slice(0, 500) },
  };
}

export function launchedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

async function fire(): Promise<void> {
  const url = process.env.OPS_TICK_URL;
  const secret = process.env.CRON_SECRET;
  if (!url) {
    console.error("OPS_TICK_URL is required");
    process.exit(1);
  }
  if (!secret) {
    console.error("CRON_SECRET is required");
    process.exit(1);
  }
  const result = await fireOpsCadence({
    tickUrl: url,
    observerUrl: process.env.OPS_OBSERVER_URL,
    secret,
  });
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      core: { url: result.core.url, status: result.core.status, body: result.core.body },
      observers: {
        url: result.observers.url,
        status: result.observers.status,
        body: result.observers.body,
      },
    })
  );
}

async function main() {
  const cadenceMs = durationMsFromEnv("OPS_TICK_CADENCE_MS", 5 * 60 * 1000, {
    min: 60_000,
    max: 60 * 60 * 1000,
  });
  const once = process.argv.includes("--once");
  await fire();
  if (once) return;
  setInterval(() => {
    void fire().catch((err) => console.error(err));
  }, cadenceMs);
}

if (launchedAsScript()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
