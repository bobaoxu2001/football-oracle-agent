import {
  assembleMatchContext,
  FileMatchContextStore,
  type AssembleMatchContextInput,
  type MatchContextBuildResult,
  type MatchContextSnapshot,
} from "../context";
import { contextSnapshotPath } from "./paths";

let cached: { path: string; store: FileMatchContextStore } | null = null;

function store(): FileMatchContextStore {
  const file = contextSnapshotPath();
  if (!cached || cached.path !== file) {
    cached = { path: file, store: new FileMatchContextStore(file) };
  }
  return cached.store;
}

/** Assemble and insert one immutable context. Same content is a no-op. */
export function freezeMatchContext(
  input: AssembleMatchContextInput
): MatchContextBuildResult & { insertStatus: "inserted" | "duplicate" } {
  const built = assembleMatchContext(input);
  const inserted = store().insert(built.snapshot);
  return {
    ...built,
    snapshot: inserted.snapshot,
    insertStatus: inserted.status,
  };
}

export function getFrozenMatchContext(contextId: string): MatchContextSnapshot | null {
  return store().get(contextId);
}

export function listFrozenMatchContexts(fixtureId?: string): MatchContextSnapshot[] {
  return store().list(fixtureId);
}

export function resetContextSnapshotStoreCache(): void {
  cached = null;
}
