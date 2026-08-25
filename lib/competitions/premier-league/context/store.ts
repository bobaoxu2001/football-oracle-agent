import fs from "node:fs";
import path from "node:path";
import type { MatchContextSnapshot } from "./types";
import { assertMatchContextIntegrity, cloneFrozenMatchContext } from "./snapshot";

export interface MatchContextInsertResult {
  readonly status: "inserted" | "duplicate";
  readonly snapshot: MatchContextSnapshot;
}

/**
 * Process-local reference store for tests and composition.
 *
 * Contexts are keyed only by their content address. A changed context gets a
 * new id; the prior context remains readable. Durable persistence can later
 * use the same insert-only contract without changing context identity.
 */
export class InMemoryMatchContextStore {
  private readonly byId = new Map<string, MatchContextSnapshot>();

  insert(snapshot: MatchContextSnapshot): MatchContextInsertResult {
    assertMatchContextIntegrity(snapshot);
    const existing = this.byId.get(snapshot.contextId);
    if (existing) return { status: "duplicate", snapshot: cloneFrozenMatchContext(existing) };
    const stored = cloneFrozenMatchContext(snapshot);
    this.byId.set(stored.contextId, stored);
    return { status: "inserted", snapshot: cloneFrozenMatchContext(stored) };
  }

  get(contextId: string): MatchContextSnapshot | null {
    const found = this.byId.get(contextId);
    return found ? cloneFrozenMatchContext(found) : null;
  }

  list(fixtureId?: string): MatchContextSnapshot[] {
    return [...this.byId.values()]
      .filter((snapshot) => !fixtureId || snapshot.fixtureId === fixtureId)
      .sort((a, b) => a.cutoffAt.localeCompare(b.cutoffAt) || a.contextId.localeCompare(b.contextId))
      .map(cloneFrozenMatchContext);
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * Append-only JSONL implementation of the same content-addressed contract.
 * The file path is explicit: this foundation never silently shares the
 * production snapshot tape or any ops bundle.
 */
export class FileMatchContextStore {
  private readonly byId = new Map<string, MatchContextSnapshot>();
  private loaded = false;

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("match context store path must be non-empty");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed: MatchContextSnapshot;
      try {
        parsed = JSON.parse(line) as MatchContextSnapshot;
      } catch {
        throw new Error(`invalid match context JSONL at line ${index + 1}`);
      }
      try {
        assertMatchContextIntegrity(parsed);
      } catch (error) {
        throw new Error(
          `invalid match context at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!this.byId.has(parsed.contextId)) {
        this.byId.set(parsed.contextId, cloneFrozenMatchContext(parsed));
      }
    }
  }

  insert(snapshot: MatchContextSnapshot): MatchContextInsertResult {
    assertMatchContextIntegrity(snapshot);
    this.load();
    const existing = this.byId.get(snapshot.contextId);
    if (existing) return { status: "duplicate", snapshot: cloneFrozenMatchContext(existing) };
    const stored = cloneFrozenMatchContext(snapshot);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
    this.byId.set(stored.contextId, stored);
    return { status: "inserted", snapshot: cloneFrozenMatchContext(stored) };
  }

  get(contextId: string): MatchContextSnapshot | null {
    this.load();
    const found = this.byId.get(contextId);
    return found ? cloneFrozenMatchContext(found) : null;
  }

  list(fixtureId?: string): MatchContextSnapshot[] {
    this.load();
    return [...this.byId.values()]
      .filter((snapshot) => !fixtureId || snapshot.fixtureId === fixtureId)
      .sort((a, b) => a.cutoffAt.localeCompare(b.cutoffAt) || a.contextId.localeCompare(b.contextId))
      .map(cloneFrozenMatchContext);
  }

  get size(): number {
    this.load();
    return this.byId.size;
  }
}
