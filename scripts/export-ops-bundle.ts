/**
 * Lightweight export / restore of the production ops bundle.
 *
 *   npx tsx scripts/export-ops-bundle.ts
 *   npx tsx scripts/export-ops-bundle.ts --restore path/to/bundle.json
 *
 * Never touches the canonical LIVE_OOS tape.
 */
import fs from "node:fs";
import path from "node:path";
import { getMongoDb } from "@/lib/db/mongodb";

const TAPE = path.resolve("data/processed/premier-league/live-oos-2026-27.jsonl");

function assertNotTape(file: string): void {
  if (path.resolve(file) === TAPE) {
    throw new Error("Refusing to write an ops bundle onto the canonical LIVE_OOS tape.");
  }
}

async function exportBundle(dest: string): Promise<void> {
  assertNotTape(dest);
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
  const doc = await db.collection("pl_ops_bundle").findOne({ _id: "current" as never });
  const payload = {
    exportedAt: new Date().toISOString(),
    database: process.env.MONGODB_DB || "football_oracle",
    collection: "pl_ops_bundle",
    id: "current",
    updatedAt: (doc as { updatedAt?: string } | null)?.updatedAt ?? null,
    bundle: (doc as { bundle?: unknown } | null)?.bundle ?? {},
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`exported ops bundle → ${dest}`);
}

async function restoreBundle(src: string): Promise<void> {
  assertNotTape(src);
  if (!fs.existsSync(src)) throw new Error(`missing backup file: ${src}`);
  const parsed = JSON.parse(fs.readFileSync(src, "utf8")) as { bundle?: unknown };
  if (!parsed.bundle || typeof parsed.bundle !== "object") {
    throw new Error("backup file has no bundle object");
  }
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable — set MONGODB_URI / MONGODB_DB");
  await db.collection("pl_ops_bundle").updateOne(
    { _id: "current" as never },
    { $set: { bundle: parsed.bundle, updatedAt: new Date().toISOString(), restoredFrom: src } },
    { upsert: true }
  );
  console.log(`restored ops bundle from ${src}`);
}

async function main() {
  const restoreIdx = process.argv.indexOf("--restore");
  if (restoreIdx >= 0) {
    const src = process.argv[restoreIdx + 1];
    if (!src) throw new Error("usage: --restore <file>");
    await restoreBundle(src);
    return;
  }
  const dest =
    process.argv[2] ||
    path.resolve(
      process.cwd(),
      "ops-backups",
      `pl-ops-bundle-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
    );
  await exportBundle(dest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
