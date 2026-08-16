/**
 * Local live-ops tick. Recommended cadence: every 5 minutes.
 *
 *   PATH="/usr/local/opt/node@22/bin:$PATH" npm run ops:tick
 */
import { runGuardedLiveOpsTick } from "@/lib/competitions/premier-league/ops/tick";

const now = process.argv[2];
runGuardedLiveOpsTick(now ? { now } : {})
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (result.skipped) process.exitCode = 3;
    else if (result.errors.length) process.exitCode = 2;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
