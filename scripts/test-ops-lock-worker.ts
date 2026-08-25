import fs from "node:fs";
import {
  acquireObserverLock,
  releaseObserverLock,
} from "@/lib/competitions/premier-league/ops/tick-lock";

const startPath = process.env.FOA_LOCK_RACE_START;
if (!startPath) throw new Error("FOA_LOCK_RACE_START is required");

async function main(): Promise<void> {
  process.stdout.write("READY\n");
  while (!fs.existsSync(startPath!)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const lock = await acquireObserverLock(`race-${process.pid}`);
  process.stdout.write(`RESULT:${lock.ok ? "won" : "lost"}\n`);
  if (lock.ok) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await releaseObserverLock(lock.leaseId);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
