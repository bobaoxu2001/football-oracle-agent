/**
 * Authenticated 5-minute ops pinger.
 *
 *   OPS_TICK_URL=https://…/api/ops/tick CRON_SECRET=… npx tsx scripts/ops-scheduler-worker.ts
 *
 * Used when platform cron cannot honor <=5 minutes. Does not invent results.
 */
import { durationMsFromEnv } from "@/lib/config/env";

const url = process.env.OPS_TICK_URL;
const secret = process.env.CRON_SECRET;
// Clamped: a malformed cadence must never become a tight loop against the
// production tick endpoint. Floor 60s, ceiling 1h.
const cadenceMs = durationMsFromEnv("OPS_TICK_CADENCE_MS", 5 * 60 * 1000, {
  min: 60_000,
  max: 60 * 60 * 1000,
});
const once = process.argv.includes("--once");

if (!url) {
  console.error("OPS_TICK_URL is required");
  process.exit(1);
}
if (!secret) {
  console.error("CRON_SECRET is required");
  process.exit(1);
}

async function fire(): Promise<void> {
  const res = await fetch(url as string, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const text = await res.text();
  console.log(JSON.stringify({ at: new Date().toISOString(), status: res.status, body: text.slice(0, 500) }));
}

async function main() {
  await fire();
  if (once) return;
  setInterval(() => {
    void fire().catch((err) => console.error(err));
  }, cadenceMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
