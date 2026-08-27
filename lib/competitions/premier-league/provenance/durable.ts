import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  provenanceFixtureRevisionPath,
  provenanceManifestPath,
  provenanceModelBundlePath,
  provenanceRatingStatePath,
  provenanceResultCorrectionPath,
  provenanceResultRevisionPath,
  provenanceSeasonMembershipPath,
} from "../ops/paths";
import { canonicalJson, cloneFrozen, requireNonEmpty } from "./canonical";
import {
  assertProvenanceRecordIntegrity,
  provenanceRecordId,
} from "./manifest";
import {
  ImmutableJsonlStore,
  ImmutableRecordCollisionError,
  type ImmutableBatchInsertResult,
  type ImmutableInsertResult,
} from "./store";
import {
  PROVENANCE_RECORD_KINDS,
  type ProvenanceRecord,
  type ProvenanceRecordKind,
} from "./types";

export type ProvenanceFilePathMap = Readonly<Record<ProvenanceRecordKind, string>>;

/** Resolve paths on every call so test and durable-work-directory overrides remain effective. */
export function provenanceFilePaths(): ProvenanceFilePathMap {
  return Object.freeze({
    FIXTURE_REVISION: provenanceFixtureRevisionPath(),
    RESULT_REVISION: provenanceResultRevisionPath(),
    RESULT_CORRECTION: provenanceResultCorrectionPath(),
    SEASON_MEMBERSHIP: provenanceSeasonMembershipPath(),
    RATING_STATE: provenanceRatingStatePath(),
    MODEL_BUNDLE: provenanceModelBundlePath(),
    FORECAST_INPUT_MANIFEST: provenanceManifestPath(),
  });
}

function storeForKind(
  recordKind: ProvenanceRecordKind,
  paths: ProvenanceFilePathMap
): ImmutableJsonlStore<ProvenanceRecordKind> {
  return new ImmutableJsonlStore<ProvenanceRecordKind>(paths[recordKind], recordKind);
}

function recordKindFromUnknown(value: unknown, label: string): ProvenanceRecordKind {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const recordKind = (value as { recordKind?: unknown }).recordKind;
  if (
    typeof recordKind !== "string" ||
    !(PROVENANCE_RECORD_KINDS as readonly string[]).includes(recordKind)
  ) {
    throw new Error(`${label} has an unsupported recordKind: ${String(recordKind)}`);
  }
  return recordKind as ProvenanceRecordKind;
}

function recordIdFromUnknown(
  value: unknown,
  recordKind: ProvenanceRecordKind,
  label: string
): string {
  const object = value as Record<string, unknown>;
  const idField: Record<ProvenanceRecordKind, string> = {
    FIXTURE_REVISION: "fixtureRevisionId",
    RESULT_REVISION: "resultRevisionId",
    RESULT_CORRECTION: "correctionId",
    SEASON_MEMBERSHIP: "seasonMembershipSnapshotId",
    RATING_STATE: "ratingStateId",
    MODEL_BUNDLE: "modelBundleId",
    FORECAST_INPUT_MANIFEST: "manifestId",
  };
  return requireNonEmpty(object[idField[recordKind]], `${label}.${idField[recordKind]}`);
}

interface ParsedRecordRow {
  record: ProvenanceRecord;
  canonical: string;
}

function ingestJsonl(
  text: string,
  sourceLabel: string,
  byId: Map<string, ParsedRecordRow>
): void {
  if (typeof text !== "string") throw new Error(`${sourceLabel} must be a string`);
  for (const [index, rawLine] of text.split("\n").entries()) {
    const json = rawLine.trim();
    if (!json) continue;
    const lineLabel = `${sourceLabel} line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(`${lineLabel} contains invalid JSON`);
    }
    const recordKind = recordKindFromUnknown(parsed, lineLabel);
    const recordId = recordIdFromUnknown(parsed, recordKind, lineLabel);
    let normalized: string;
    try {
      normalized = canonicalJson(parsed);
    } catch (error) {
      throw new Error(
        `${lineLabel} is not canonical-JSON compatible: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    const existing = byId.get(recordId);
    if (existing) {
      if (existing.canonical !== normalized) {
        throw new ImmutableRecordCollisionError(
          recordId,
          `${lineLabel} conflicts with another provenance row`
        );
      }
      continue;
    }
    const record = parsed as ProvenanceRecord;
    try {
      assertProvenanceRecordIntegrity(record);
    } catch (error) {
      throw new Error(
        `${lineLabel} failed provenance integrity validation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    byId.set(recordId, { record: cloneFrozen(record), canonical: normalized });
  }
}

function kindOrder(recordKind: ProvenanceRecordKind): number {
  return PROVENANCE_RECORD_KINDS.indexOf(recordKind);
}

function sortRecords(records: readonly ProvenanceRecord[]): ProvenanceRecord[] {
  return records
    .slice()
    .sort(
      (left, right) =>
        kindOrder(left.recordKind) - kindOrder(right.recordKind) ||
        provenanceRecordId(left).localeCompare(provenanceRecordId(right))
    )
    .map(cloneFrozen);
}

function validatedUniqueRecords(
  records: readonly ProvenanceRecord[],
  sourceLabel: string
): ProvenanceRecord[] {
  if (!Array.isArray(records)) throw new Error(`${sourceLabel} must be an array`);
  const jsonl = records.map((record) => canonicalJson(record)).join("\n");
  return parseProvenanceRecordsJsonl(jsonl, sourceLabel);
}

/** Strictly parse, integrity-check, de-duplicate, and deterministically order mixed-kind JSONL. */
export function parseProvenanceRecordsJsonl(
  text: string,
  sourceLabel = "provenance JSONL"
): ProvenanceRecord[] {
  const byId = new Map<string, ParsedRecordRow>();
  ingestJsonl(text, sourceLabel, byId);
  return sortRecords([...byId.values()].map((row) => row.record));
}

/** Serialize validated records in stable kind/id order with one trailing newline. */
export function serializeProvenanceRecordsJsonl(
  records: readonly ProvenanceRecord[] = listAllProvenanceRecords()
): string {
  const validated = validatedUniqueRecords(records, "serialized provenance records");
  return validated.length
    ? `${validated.map((record) => canonicalJson(record)).join("\n")}\n`
    : "";
}

/** Read all exact per-kind tapes. Each store fails closed on corrupt rows or collisions. */
export function listAllProvenanceRecords(
  paths: ProvenanceFilePathMap = provenanceFilePaths()
): ProvenanceRecord[] {
  const records: ProvenanceRecord[] = [];
  for (const recordKind of PROVENANCE_RECORD_KINDS) {
    records.push(...storeForKind(recordKind, paths).list());
  }
  return sortRecords(records);
}

/** Merge mixed-kind captures; identical IDs de-duplicate and differing bytes fail closed. */
export function mergeProvenanceRecordsJsonl(...sources: readonly string[]): string {
  const byId = new Map<string, ParsedRecordRow>();
  for (const [index, source] of sources.entries()) {
    ingestJsonl(source, `provenance source ${index + 1}`, byId);
  }
  return serializeProvenanceRecordsJsonl([...byId.values()].map((row) => row.record));
}

interface StagedReplacement {
  target: string;
  temporary: string;
}

function assertDistinctPaths(paths: ProvenanceFilePathMap): void {
  const resolved = PROVENANCE_RECORD_KINDS.map((kind) =>
    path.resolve(requireNonEmpty(paths[kind], `provenance path ${kind}`))
  );
  if (new Set(resolved).size !== resolved.length) {
    throw new Error("provenance record kinds must use distinct files");
  }
}

function stageReplacement(target: string, text: string): StagedReplacement {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`
  );
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original staging error; the caller has not touched targets.
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
  return { target, temporary };
}

/**
 * Validate the complete capture before touching disk, then atomically replace
 * every exact per-kind file via same-directory rename. The seven renames are
 * individually atomic; the caller remains responsible for its outer Mongo/CAS
 * transaction when coordinating multiple server instances.
 */
export function replaceProvenanceRecordsFromJsonl(
  text: string,
  paths: ProvenanceFilePathMap = provenanceFilePaths()
): ProvenanceRecord[] {
  const records = parseProvenanceRecordsJsonl(text, "replacement provenance JSONL");
  assertDistinctPaths(paths);
  const byKind = new Map<ProvenanceRecordKind, ProvenanceRecord[]>();
  for (const recordKind of PROVENANCE_RECORD_KINDS) byKind.set(recordKind, []);
  for (const record of records) byKind.get(record.recordKind)?.push(record);

  const staged: StagedReplacement[] = [];
  try {
    for (const recordKind of PROVENANCE_RECORD_KINDS) {
      staged.push(
        stageReplacement(
          paths[recordKind],
          serializeProvenanceRecordsJsonl(byKind.get(recordKind) ?? [])
        )
      );
    }
    for (const replacement of staged) {
      fs.renameSync(replacement.temporary, replacement.target);
    }
  } finally {
    for (const replacement of staged) {
      if (fs.existsSync(replacement.temporary)) fs.unlinkSync(replacement.temporary);
    }
  }
  return records.map(cloneFrozen);
}

/** Validate the full batch before routing immutable inserts to per-kind tapes. */
export function insertProvenanceRecords(
  records: readonly ProvenanceRecord[],
  paths: ProvenanceFilePathMap = provenanceFilePaths()
): ImmutableBatchInsertResult<ProvenanceRecord> {
  const validated = validatedUniqueRecords(records, "inserted provenance records");
  assertDistinctPaths(paths);
  const inserted: ProvenanceRecord[] = [];
  const duplicates: ProvenanceRecord[] = [];
  for (const recordKind of PROVENANCE_RECORD_KINDS) {
    const forKind = validated.filter((record) => record.recordKind === recordKind);
    if (!forKind.length) continue;
    const result = storeForKind(recordKind, paths).insertMany(forKind);
    inserted.push(...result.inserted);
    duplicates.push(...result.duplicates);
  }
  return {
    inserted: sortRecords(inserted),
    duplicates: sortRecords(duplicates),
  };
}

export function insertProvenanceRecord(
  record: ProvenanceRecord,
  paths: ProvenanceFilePathMap = provenanceFilePaths()
): ImmutableInsertResult<ProvenanceRecord> {
  const result = insertProvenanceRecords([record], paths);
  if (result.inserted[0]) return { status: "inserted", record: result.inserted[0] };
  if (result.duplicates[0]) return { status: "duplicate", record: result.duplicates[0] };
  throw new Error("provenance insert produced no result");
}
