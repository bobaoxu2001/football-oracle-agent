/**
 * Ops persistence backends.
 *
 * FileOpsStore — local JSONL (Phase 2A.2 default; tests).
 * ProductionPersistentOpsStore — MongoDB Atlas (Vercel) or a JSON bundle
 * (isolated durable-contract tests). Never writes the frozen 380-line tape.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMongoDb } from "@/lib/db/mongodb";
import { isCanonicalLiveTapePath, resetSnapshotCache } from "@/lib/snapshots/store";
import { resetSeasonBundleCache } from "../fixture-store";
import { compactPersistedSourceObservations } from "./fixture-sync";
import { resetJobCache } from "./job-ledger";
import { compactPersistedResultObservations } from "./result-feed";
import { resetRatingEventCache } from "./rating-events";
import {
  clubSeasonsPath,
  liveFixturesPath,
  operationalLiveOosPath,
  opsDir,
  predictionJobPath,
  ratingEventPath,
  ratingStateSnapshotPath,
  resultObservationPath,
  resultVerificationPath,
  scheduleRevisionPath,
  seasonManifestPath,
  settlementCorrectionPath,
  sourceObservationPath,
  tickStatePath,
} from "./paths";

export type OpsBackendKind = "file" | "mongo" | "bundle";

const COMMITTED_ROOT = path.resolve(process.cwd(), "data/processed/premier-league");
const BUNDLE_KEYS = [
  "jobs",
  "sourceObservations",
  "scheduleRevisions",
  "resultObservations",
  "resultVerifications",
  "ratingEvents",
  "ratingState",
  "tickState",
  "settlementCorrections",
  "operationalLiveOos",
  "settlements",
  "workingSnapshots",
  "fixturesOverlay",
] as const;

export type DurableBundle = Record<(typeof BUNDLE_KEYS)[number], string>;

export function opsBackend(): OpsBackendKind {
  const forced = process.env.PL_OPS_BACKEND;
  if (forced === "file" || forced === "mongo" || forced === "bundle") return forced;
  if (process.env.VERCEL === "1" && process.env.MONGODB_URI) return "mongo";
  return "file";
}

export function durableWorkDir(): string {
  return process.env.PL_DURABLE_WORK_DIR || path.join(os.tmpdir(), "foa-durable-ops");
}

function emptyBundle(): DurableBundle {
  return {
    jobs: "",
    sourceObservations: "",
    scheduleRevisions: "",
    resultObservations: "",
    resultVerifications: "",
    ratingEvents: "",
    ratingState: "",
    tickState: "",
    settlementCorrections: "",
    operationalLiveOos: "",
    settlements: "",
    workingSnapshots: "",
    fixturesOverlay: "",
  };
}

function readIf(file: string): string {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8");
}

function writeIf(file: string, text: string): void {
  if (!text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function copyCommitted(srcName: string, dest: string): void {
  const src = path.join(COMMITTED_ROOT, srcName);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function assertNotTape(file: string): void {
  if (isCanonicalLiveTapePath(file)) {
    throw new Error("Refusing to use the canonical LIVE_OOS tape as an operational store.");
  }
}

/** Shrink append-only JSONL fields before they are packed into one Mongo document. */
export function compactDurableOpsOnDisk(): void {
  compactPersistedSourceObservations();
  compactPersistedResultObservations();
}

export function captureBundleFromDisk(): DurableBundle {
  compactDurableOpsOnDisk();
  return {
    jobs: readIf(predictionJobPath()),
    sourceObservations: readIf(sourceObservationPath()),
    scheduleRevisions: readIf(scheduleRevisionPath()),
    resultObservations: readIf(resultObservationPath()),
    resultVerifications: readIf(resultVerificationPath()),
    ratingEvents: readIf(ratingEventPath()),
    ratingState: readIf(ratingStateSnapshotPath()),
    tickState: readIf(tickStatePath()),
    settlementCorrections: readIf(settlementCorrectionPath()),
    operationalLiveOos: readIf(operationalLiveOosPath()),
    settlements: readIf(process.env.SETTLEMENT_STORE_PATH || path.join(opsDir(), "settlements.jsonl")),
    workingSnapshots: readIf(process.env.SNAPSHOT_STORE_PATH || path.join(opsDir(), "working-snapshots.jsonl")),
    fixturesOverlay: readIf(liveFixturesPath()),
  };
}

export function routeDurablePaths(work = durableWorkDir()): void {
  const ops = path.join(work, "ops");
  process.env.PL_OPS_DIR = ops;
  process.env.PL_SEASON_MANIFEST_PATH = path.join(work, "season-2026-27.json");
  process.env.PL_CLUB_SEASONS_PATH = path.join(work, "club-seasons-2026-27.json");
  process.env.PL_FIXTURES_PATH = path.join(work, "fixtures-2026-27.json");
  process.env.PL_FIXTURE_REVISIONS_PATH = path.join(ops, "fixture-revisions.jsonl");
  process.env.SNAPSHOT_STORE_PATH = path.join(ops, "working-snapshots.jsonl");
  process.env.SETTLEMENT_STORE_PATH = path.join(ops, "settlements.jsonl");
  process.env.LIVE_OOS_ARCHIVE_PATH = path.join(ops, "live-oos-operational.jsonl");
  assertNotTape(process.env.SNAPSHOT_STORE_PATH);
  assertNotTape(process.env.LIVE_OOS_ARCHIVE_PATH);
  copyCommitted("season-2026-27.json", process.env.PL_SEASON_MANIFEST_PATH);
  copyCommitted("club-seasons-2026-27.json", process.env.PL_CLUB_SEASONS_PATH);
  if (!fs.existsSync(process.env.PL_FIXTURES_PATH)) {
    copyCommitted("fixtures-2026-27.json", process.env.PL_FIXTURES_PATH);
  }
}

export function applyBundleToDisk(bundle: DurableBundle): void {
  routeDurablePaths();
  writeIf(predictionJobPath(), bundle.jobs);
  writeIf(sourceObservationPath(), bundle.sourceObservations);
  writeIf(scheduleRevisionPath(), bundle.scheduleRevisions);
  writeIf(resultObservationPath(), bundle.resultObservations);
  writeIf(resultVerificationPath(), bundle.resultVerifications);
  writeIf(ratingEventPath(), bundle.ratingEvents);
  writeIf(ratingStateSnapshotPath(), bundle.ratingState);
  writeIf(tickStatePath(), bundle.tickState);
  writeIf(settlementCorrectionPath(), bundle.settlementCorrections);
  writeIf(operationalLiveOosPath(), bundle.operationalLiveOos);
  writeIf(process.env.SETTLEMENT_STORE_PATH!, bundle.settlements);
  writeIf(process.env.SNAPSHOT_STORE_PATH!, bundle.workingSnapshots);
  if (bundle.fixturesOverlay.trim()) writeIf(liveFixturesPath(), bundle.fixturesOverlay);
  resetJobCache();
  resetRatingEventCache();
  resetSeasonBundleCache();
  resetSnapshotCache();
}

function bundlePath(): string {
  return process.env.PL_OPS_BUNDLE_PATH || path.join(durableWorkDir(), "ops-bundle.json");
}

async function loadMongoBundle(): Promise<DurableBundle> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  const doc = await db.collection("pl_ops_bundle").findOne({ _id: "current" as never });
  if (!doc?.bundle) return emptyBundle();
  return { ...emptyBundle(), ...(doc.bundle as DurableBundle) };
}

async function saveMongoBundle(bundle: DurableBundle): Promise<void> {
  const db = await getMongoDb();
  if (!db) throw new Error("MongoDB unavailable for durable ops store");
  await db.collection("pl_ops_bundle").updateOne(
    { _id: "current" as never },
    { $set: { bundle, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

function loadFileBundle(): DurableBundle {
  const file = bundlePath();
  if (!fs.existsSync(file)) return emptyBundle();
  return { ...emptyBundle(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as DurableBundle) };
}

function saveFileBundle(bundle: DurableBundle): void {
  writeIf(bundlePath(), JSON.stringify(bundle));
}

const g = globalThis as unknown as {
  __foaDurable?: { hydrated: boolean; lastHydratedAt: string | null; lastFlushAt: string | null; backend: OpsBackendKind };
};

function meta() {
  if (!g.__foaDurable) {
    g.__foaDurable = { hydrated: false, lastHydratedAt: null, lastFlushAt: null, backend: opsBackend() };
  }
  return g.__foaDurable;
}

export function durableStatus(): {
  backend: OpsBackendKind;
  durable: boolean;
  hydrated: boolean;
  lastHydratedAt: string | null;
  lastFlushAt: string | null;
} {
  const m = meta();
  const backend = opsBackend();
  return {
    backend,
    durable: backend !== "file",
    hydrated: m.hydrated,
    lastHydratedAt: m.lastHydratedAt,
    lastFlushAt: m.lastFlushAt,
  };
}

export async function hydrateDurableOps(): Promise<void> {
  const backend = opsBackend();
  meta().backend = backend;
  if (backend === "file") {
    meta().hydrated = true;
    return;
  }
  try {
    const bundle = backend === "mongo" ? await loadMongoBundle() : loadFileBundle();
    applyBundleToDisk(bundle);
    compactDurableOpsOnDisk();
    meta().hydrated = true;
    meta().lastHydratedAt = new Date().toISOString();
  } catch (err) {
    console.warn("[ops-durable] hydrate failed, continuing on local work dir:", (err as Error).message);
    routeDurablePaths();
    meta().hydrated = false;
    meta().lastHydratedAt = null;
  }
}

export async function flushDurableOps(): Promise<void> {
  const backend = opsBackend();
  if (backend === "file") return;
  const bundle = captureBundleFromDisk();
  if (backend === "mongo") await saveMongoBundle(bundle);
  else saveFileBundle(bundle);
  meta().lastFlushAt = new Date().toISOString();
}

export function resetDurableMetaForTests(): void {
  g.__foaDurable = { hydrated: false, lastHydratedAt: null, lastFlushAt: null, backend: opsBackend() };
}
