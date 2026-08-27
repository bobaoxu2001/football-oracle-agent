import fs from "node:fs";
import path from "node:path";
import { canonicalJson, cloneFrozen, requireNonEmpty } from "./canonical";
import {
  assertProvenanceRecordIntegrity,
  provenanceRecordId,
} from "./manifest";
import type {
  FixtureRevisionRecord,
  ForecastInputManifest,
  FrozenRatingStateSnapshot,
  ImmutableModelBundle,
  ProvenanceRecord,
  ProvenanceRecordKind,
  ResultCorrectionLink,
  ResultRevisionRecord,
  SeasonMembershipSnapshot,
} from "./types";

export class ImmutableRecordCollisionError extends Error {
  constructor(
    public readonly recordId: string,
    detail = "same immutable record id resolves to different content"
  ) {
    super(`${detail}: ${recordId}`);
    this.name = "ImmutableRecordCollisionError";
  }
}

export interface ImmutableInsertResult<T> {
  readonly status: "inserted" | "duplicate";
  readonly record: T;
}

export interface ImmutableBatchInsertResult<T> {
  readonly inserted: readonly T[];
  readonly duplicates: readonly T[];
}

type RecordOfKind<K extends ProvenanceRecordKind> = Extract<
  ProvenanceRecord,
  { recordKind: K }
>;

/**
 * Strict append-only JSONL store for one provenance record kind.
 *
 * Unlike the operational JSONL reader, this store never skips malformed rows.
 * A corrupt row or an id/content collision blocks the tape until repaired from
 * independently verified evidence.
 */
export class ImmutableJsonlStore<K extends ProvenanceRecordKind> {
  private readonly byId = new Map<string, RecordOfKind<K>>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly expectedKind: K
  ) {
    requireNonEmpty(filePath, "immutable JSONL store path");
  }

  private idFromUnknown(value: unknown, label: string): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be a JSON object`);
    }
    const record = value as Partial<ProvenanceRecord>;
    if (record.recordKind !== this.expectedKind) {
      throw new Error(
        `${label} has recordKind ${String(record.recordKind)}; expected ${this.expectedKind}`
      );
    }
    return provenanceRecordId(record as RecordOfKind<K>);
  }

  private assertRecord(value: unknown, label: string): RecordOfKind<K> {
    const id = this.idFromUnknown(value, label);
    const record = value as RecordOfKind<K>;
    const existing = this.byId.get(id);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) {
      throw new ImmutableRecordCollisionError(id, `${label} conflicts with an earlier row`);
    }
    assertProvenanceRecordIntegrity(record);
    return record;
  }

  private load(): void {
    if (this.loaded) return;
    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }
    try {
      const lines = fs.readFileSync(this.filePath, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`invalid immutable provenance JSONL at line ${index + 1}`);
        }
        const record = this.assertRecord(parsed, `immutable provenance line ${index + 1}`);
        const id = provenanceRecordId(record);
        if (!this.byId.has(id)) this.byId.set(id, cloneFrozen(record));
      }
      this.loaded = true;
    } catch (error) {
      // A failed load must poison neither the validation gate nor the in-memory
      // index. Every later operation retries the complete immutable tape and
      // therefore fails closed until the bytes are independently repaired.
      this.byId.clear();
      this.loaded = false;
      throw error;
    }
  }

  insert(record: RecordOfKind<K>): ImmutableInsertResult<RecordOfKind<K>> {
    this.load();
    const id = this.idFromUnknown(record, "inserted provenance record");
    const existing = this.byId.get(id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new ImmutableRecordCollisionError(id);
      }
      return { status: "duplicate", record: cloneFrozen(existing) };
    }
    const validated = this.assertRecord(record, "inserted provenance record");
    const stored = cloneFrozen(validated);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${canonicalJson(stored)}\n`, "utf8");
    } catch (error) {
      // An append can fail after writing only part of a row. Force the same
      // instance to re-read and validate the complete tape before any retry.
      this.byId.clear();
      this.loaded = false;
      throw error;
    }
    this.byId.set(id, stored);
    return { status: "inserted", record: cloneFrozen(stored) };
  }

  insertMany(records: readonly RecordOfKind<K>[]): ImmutableBatchInsertResult<RecordOfKind<K>> {
    this.load();
    const staged = new Map<string, RecordOfKind<K>>();
    const duplicates: RecordOfKind<K>[] = [];
    for (const record of records) {
      const id = this.idFromUnknown(record, "batched provenance record");
      const existing = this.byId.get(id) ?? staged.get(id);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw new ImmutableRecordCollisionError(id, "batched provenance record conflicts");
        }
        duplicates.push(cloneFrozen(existing));
        continue;
      }
      const validated = this.assertRecord(record, "batched provenance record");
      staged.set(id, cloneFrozen(validated));
    }
    const inserted = [...staged.values()];
    if (inserted.length) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.appendFileSync(
          this.filePath,
          `${inserted.map((record) => canonicalJson(record)).join("\n")}\n`,
          "utf8"
        );
      } catch (error) {
        this.byId.clear();
        this.loaded = false;
        throw error;
      }
      for (const record of inserted) this.byId.set(provenanceRecordId(record), record);
    }
    return {
      inserted: inserted.map(cloneFrozen),
      duplicates,
    };
  }

  get(recordId: string): RecordOfKind<K> | null {
    this.load();
    const found = this.byId.get(recordId);
    return found ? cloneFrozen(found) : null;
  }

  list(): RecordOfKind<K>[] {
    this.load();
    return [...this.byId.values()]
      .sort((a, b) => provenanceRecordId(a).localeCompare(provenanceRecordId(b)))
      .map(cloneFrozen);
  }

  get size(): number {
    this.load();
    return this.byId.size;
  }
}

export const fixtureRevisionStore = (filePath: string) =>
  new ImmutableJsonlStore<"FIXTURE_REVISION">(filePath, "FIXTURE_REVISION");

export const resultRevisionStore = (filePath: string) =>
  new ImmutableJsonlStore<"RESULT_REVISION">(filePath, "RESULT_REVISION");

export const resultCorrectionStore = (filePath: string) =>
  new ImmutableJsonlStore<"RESULT_CORRECTION">(filePath, "RESULT_CORRECTION");

export const seasonMembershipStore = (filePath: string) =>
  new ImmutableJsonlStore<"SEASON_MEMBERSHIP">(filePath, "SEASON_MEMBERSHIP");

export const ratingStateStore = (filePath: string) =>
  new ImmutableJsonlStore<"RATING_STATE">(filePath, "RATING_STATE");

export const modelBundleStore = (filePath: string) =>
  new ImmutableJsonlStore<"MODEL_BUNDLE">(filePath, "MODEL_BUNDLE");

export const forecastInputManifestStore = (filePath: string) =>
  new ImmutableJsonlStore<"FORECAST_INPUT_MANIFEST">(
    filePath,
    "FORECAST_INPUT_MANIFEST"
  );

export type {
  FixtureRevisionRecord,
  ResultRevisionRecord,
  ResultCorrectionLink,
  SeasonMembershipSnapshot,
  FrozenRatingStateSnapshot,
  ImmutableModelBundle,
  ForecastInputManifest,
};
