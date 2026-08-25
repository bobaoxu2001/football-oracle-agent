import { createHash } from "node:crypto";
import {
  AVAILABILITY_STATUSES,
  LINEUP_STATUSES,
  MATCH_CONTEXT_EVIDENCE_KINDS,
  MATCH_CONTEXT_SCHEMA_VERSION,
  MATCH_CONTEXT_TEMPORAL_RULE,
  type AssembleMatchContextInput,
  type AvailabilityStatus,
  type EntityAvailabilityContext,
  type JsonValue,
  type LineupEvidenceStatus,
  type MatchAvailabilityContext,
  type MatchContextBuildResult,
  type MatchContextEvidence,
  type MatchContextEvidenceInput,
  type MatchContextSnapshot,
  type MatchLineupContext,
  type OverallLineupStatus,
  type TeamAvailabilityContext,
  type TeamLineupContext,
} from "./types";

const EVIDENCE_ID_PREFIX = `${MATCH_CONTEXT_SCHEMA_VERSION}:evidence:sha256:`;
const CONTEXT_ID_PREFIX = `${MATCH_CONTEXT_SCHEMA_VERSION}:sha256:`;
const EVIDENCE_KINDS = new Set<string>(MATCH_CONTEXT_EVIDENCE_KINDS);
const INGESTIBLE_LINEUP_STATUSES = new Set<string>(
  LINEUP_STATUSES.filter((status) => status !== "NONE")
);
const INGESTIBLE_AVAILABILITY_STATUSES = new Set<string>(AVAILABILITY_STATUSES);
const SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/i;

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(millis).toISOString();
}

function normalizedSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a SHA-256 digest`);
  const match = SHA256_PATTERN.exec(value.trim());
  if (!match) throw new Error(`${label} must be a SHA-256 digest`);
  return `sha256:${match[1].toLowerCase()}`;
}

function confidenceOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("evidence.confidence must be between 0 and 1");
  }
  return value;
}

/** Validate JSON data and return a key-sorted, detached value. */
function normalizeJson(value: unknown, label: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`${label} must contain JSON values only`);
  if (ancestors.has(value)) throw new Error(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJson(item, `${label}[${index}]`, ancestors));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${label} must contain plain JSON objects only`);
    }
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeJson((value as Record<string, unknown>)[key], `${label}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON encoding: object keys are sorted recursively; array order is semantic. */
export function canonicalMatchContextJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalMatchContextJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalMatchContextJson(value[key])}`)
    .join(",")}}`;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalMatchContextJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sourceOf(input: MatchContextEvidenceInput): MatchContextEvidence["source"] {
  if (!input.source || typeof input.source !== "object") {
    throw new Error("evidence.source is required");
  }
  const url = input.source.url == null ? null : nonEmpty(input.source.url, "evidence.source.url");
  return {
    name: nonEmpty(input.source.name, "evidence.source.name"),
    recordId: nonEmpty(input.source.recordId, "evidence.source.recordId"),
    url,
  };
}

function evidenceIdentityValue(evidence: Omit<MatchContextEvidence, "evidenceId" | "usedInForecast">): JsonValue {
  return normalizeJson(
    {
      fixtureId: evidence.fixtureId,
      kind: evidence.kind,
      entityId: evidence.entityId,
      teamSlug: evidence.teamSlug,
      observedAt: evidence.observedAt,
      fetchedAt: evidence.fetchedAt,
      availableAt: evidence.availableAt,
      confidence: evidence.confidence,
      rawEvidenceHash: evidence.rawEvidenceHash,
      source: evidence.source,
      payload: evidence.payload,
      lineupStatus: evidence.lineupStatus,
      availabilityStatus: evidence.availabilityStatus,
    },
    "evidence identity"
  );
}

function evidenceIdOf(evidence: Omit<MatchContextEvidence, "evidenceId" | "usedInForecast">): string {
  return `${EVIDENCE_ID_PREFIX}${hashJson(evidenceIdentityValue(evidence))}`;
}

function normalizeEvidence(
  input: MatchContextEvidenceInput,
  fixture: { fixtureId: string; homeSlug: string; awaySlug: string }
): MatchContextEvidence {
  if (!input || typeof input !== "object") throw new Error("evidence must be an object");
  const fixtureId = nonEmpty(input.fixtureId, "evidence.fixtureId");
  if (fixtureId !== fixture.fixtureId) {
    throw new Error(`evidence fixture ${fixtureId} does not match context fixture ${fixture.fixtureId}`);
  }
  if (!EVIDENCE_KINDS.has(String(input.kind))) {
    throw new Error(`unsupported evidence kind: ${String(input.kind)}`);
  }
  const entityId = nonEmpty(input.entityId, "evidence.entityId");
  const teamSlug = input.teamSlug == null ? null : nonEmpty(input.teamSlug, "evidence.teamSlug");
  if (teamSlug !== null && teamSlug !== fixture.homeSlug && teamSlug !== fixture.awaySlug) {
    throw new Error(`evidence team ${teamSlug} is not part of fixture ${fixture.fixtureId}`);
  }
  if (typeof input.usedInForecast !== "boolean") {
    throw new Error("evidence.usedInForecast must be an explicit boolean");
  }

  const observedAt = normalizedIso(input.observedAt, "evidence.observedAt");
  const fetchedAt = normalizedIso(input.fetchedAt, "evidence.fetchedAt");
  const availableAt = normalizedIso(input.availableAt, "evidence.availableAt");
  if (Date.parse(observedAt) > Date.parse(fetchedAt)) {
    throw new Error("evidence.observedAt must not be after fetchedAt");
  }
  if (Date.parse(fetchedAt) > Date.parse(availableAt)) {
    throw new Error("evidence.availableAt must not precede fetchedAt");
  }

  let lineupStatus: LineupEvidenceStatus | null = null;
  if (input.kind === "LINEUP") {
    if (!teamSlug) throw new Error("LINEUP evidence must identify home or away teamSlug");
    if (!INGESTIBLE_LINEUP_STATUSES.has(String(input.lineupStatus))) {
      throw new Error("LINEUP evidence requires EXPECTED or CONFIRMED status");
    }
    lineupStatus = input.lineupStatus as LineupEvidenceStatus;
  } else if (input.lineupStatus != null) {
    throw new Error("lineupStatus is only valid for LINEUP evidence");
  }

  let availabilityStatus: AvailabilityStatus | null = null;
  if (input.kind === "SQUAD_AVAILABILITY") {
    if (!teamSlug) throw new Error("SQUAD_AVAILABILITY evidence must identify home or away teamSlug");
    if (!INGESTIBLE_AVAILABILITY_STATUSES.has(String(input.availabilityStatus))) {
      throw new Error("SQUAD_AVAILABILITY evidence requires an explicit availabilityStatus");
    }
    availabilityStatus = input.availabilityStatus as AvailabilityStatus;
  } else if (input.availabilityStatus != null) {
    throw new Error("availabilityStatus is only valid for SQUAD_AVAILABILITY evidence");
  }

  const base = {
    fixtureId,
    kind: input.kind,
    entityId,
    teamSlug,
    observedAt,
    fetchedAt,
    availableAt,
    confidence: confidenceOf(input.confidence),
    rawEvidenceHash: normalizedSha256(input.rawEvidenceHash, "evidence.rawEvidenceHash"),
    source: sourceOf(input),
    payload: normalizeJson(input.payload, "evidence.payload"),
    lineupStatus,
    availabilityStatus,
  } satisfies Omit<MatchContextEvidence, "evidenceId" | "usedInForecast">;

  return {
    evidenceId: evidenceIdOf(base),
    ...base,
    usedInForecast: input.usedInForecast,
  };
}

function compareEvidence(a: MatchContextEvidence, b: MatchContextEvidence): number {
  return (
    a.availableAt.localeCompare(b.availableAt) ||
    a.kind.localeCompare(b.kind) ||
    (a.teamSlug ?? "").localeCompare(b.teamSlug ?? "") ||
    a.evidenceId.localeCompare(b.evidenceId)
  );
}

function missingLineup(teamSlug: string): TeamLineupContext {
  return {
    teamSlug,
    status: "NONE",
    evidenceId: null,
    availableAt: null,
    usedInForecast: false,
  };
}

function newerLineup(
  current: MatchContextEvidence | null,
  candidate: MatchContextEvidence
): MatchContextEvidence {
  if (!current) return candidate;
  const timeOrder = candidate.availableAt.localeCompare(current.availableAt);
  if (timeOrder > 0) return candidate;
  if (timeOrder === 0 && candidate.evidenceId.localeCompare(current.evidenceId) > 0) return candidate;
  return current;
}

export function deriveLineupContext(
  evidence: readonly MatchContextEvidence[],
  homeSlug: string,
  awaySlug: string
): MatchLineupContext {
  let homeEvidence: MatchContextEvidence | null = null;
  let awayEvidence: MatchContextEvidence | null = null;
  for (const item of evidence) {
    if (item.kind !== "LINEUP") continue;
    if (item.teamSlug === homeSlug) homeEvidence = newerLineup(homeEvidence, item);
    if (item.teamSlug === awaySlug) awayEvidence = newerLineup(awayEvidence, item);
  }
  const state = (teamSlug: string, item: MatchContextEvidence | null): TeamLineupContext =>
    item
      ? {
          teamSlug,
          status: item.lineupStatus as LineupEvidenceStatus,
          evidenceId: item.evidenceId,
          availableAt: item.availableAt,
          usedInForecast: item.usedInForecast,
        }
      : missingLineup(teamSlug);
  const home = state(homeSlug, homeEvidence);
  const away = state(awaySlug, awayEvidence);
  const overall: OverallLineupStatus = home.status === away.status ? home.status : "PARTIAL";
  return { home, away, overall };
}

function newerAvailability(
  current: MatchContextEvidence | null,
  candidate: MatchContextEvidence
): MatchContextEvidence {
  if (!current) return candidate;
  const timeOrder = candidate.availableAt.localeCompare(current.availableAt);
  if (timeOrder > 0) return candidate;
  if (timeOrder === 0 && candidate.evidenceId.localeCompare(current.evidenceId) > 0) return candidate;
  return current;
}

function availabilityTeam(
  evidence: readonly MatchContextEvidence[],
  teamSlug: string
): TeamAvailabilityContext {
  const latestByEntity = new Map<string, MatchContextEvidence>();
  for (const item of evidence) {
    if (item.kind !== "SQUAD_AVAILABILITY" || item.teamSlug !== teamSlug) continue;
    latestByEntity.set(
      item.entityId,
      newerAvailability(latestByEntity.get(item.entityId) ?? null, item)
    );
  }
  const entities: EntityAvailabilityContext[] = [...latestByEntity.values()]
    .sort((a, b) => a.entityId.localeCompare(b.entityId))
    .map((item) => ({
      entityId: item.entityId,
      status: item.availabilityStatus as AvailabilityStatus,
      evidenceId: item.evidenceId,
      availableAt: item.availableAt,
      confidence: item.confidence,
      usedInForecast: item.usedInForecast,
    }));
  const statusCounts = Object.fromEntries(
    AVAILABILITY_STATUSES.map((status) => [status, 0])
  ) as Record<AvailabilityStatus, number>;
  for (const entity of entities) statusCounts[entity.status] += 1;
  return {
    teamSlug,
    entities,
    statusCounts,
    latestAvailableAt: entities.reduce<string | null>(
      (latest, item) => !latest || item.availableAt > latest ? item.availableAt : latest,
      null
    ),
  };
}

export function deriveAvailabilityContext(
  evidence: readonly MatchContextEvidence[],
  homeSlug: string,
  awaySlug: string
): MatchAvailabilityContext {
  return {
    home: availabilityTeam(evidence, homeSlug),
    away: availabilityTeam(evidence, awaySlug),
  };
}

type ContextIdentity = Omit<MatchContextSnapshot, "contextId" | "generatedAt">;

function contextIdentityValue(snapshot: ContextIdentity): JsonValue {
  return normalizeJson(snapshot, "match context");
}

function contextIdOf(snapshot: ContextIdentity): string {
  return `${CONTEXT_ID_PREFIX}${hashJson(contextIdentityValue(snapshot))}`;
}

function assertIsoIsCanonical(value: string, label: string): void {
  if (normalizedIso(value, label) !== value) throw new Error(`${label} must be normalized UTC ISO`);
}

function assertEvidenceIntegrity(evidence: MatchContextEvidence): void {
  if (!EVIDENCE_KINDS.has(String(evidence.kind))) throw new Error("unsupported evidence kind");
  nonEmpty(evidence.entityId, "evidence.entityId");
  nonEmpty(evidence.fixtureId, "evidence.fixtureId");
  nonEmpty(evidence.source?.name, "evidence.source.name");
  nonEmpty(evidence.source?.recordId, "evidence.source.recordId");
  if (evidence.source?.url !== null) nonEmpty(evidence.source?.url, "evidence.source.url");
  if (typeof evidence.usedInForecast !== "boolean") {
    throw new Error("evidence.usedInForecast must be an explicit boolean");
  }
  assertIsoIsCanonical(evidence.observedAt, "evidence.observedAt");
  assertIsoIsCanonical(evidence.fetchedAt, "evidence.fetchedAt");
  assertIsoIsCanonical(evidence.availableAt, "evidence.availableAt");
  if (Date.parse(evidence.observedAt) > Date.parse(evidence.fetchedAt)) {
    throw new Error("evidence.observedAt must not be after fetchedAt");
  }
  if (Date.parse(evidence.fetchedAt) > Date.parse(evidence.availableAt)) {
    throw new Error("evidence.availableAt must not precede fetchedAt");
  }
  confidenceOf(evidence.confidence);
  if (normalizedSha256(evidence.rawEvidenceHash, "evidence.rawEvidenceHash") !== evidence.rawEvidenceHash) {
    throw new Error("evidence.rawEvidenceHash must be normalized");
  }
  if (evidence.kind === "LINEUP") {
    if (!evidence.teamSlug || !INGESTIBLE_LINEUP_STATUSES.has(String(evidence.lineupStatus))) {
      throw new Error("invalid LINEUP evidence semantics");
    }
  } else if (evidence.lineupStatus !== null) {
    throw new Error("non-LINEUP evidence carries lineupStatus");
  }
  if (evidence.kind === "SQUAD_AVAILABILITY") {
    if (!evidence.teamSlug || !INGESTIBLE_AVAILABILITY_STATUSES.has(String(evidence.availabilityStatus))) {
      throw new Error("invalid SQUAD_AVAILABILITY evidence semantics");
    }
  } else if (evidence.availabilityStatus !== null) {
    throw new Error("non-SQUAD_AVAILABILITY evidence carries availabilityStatus");
  }
  const { evidenceId, usedInForecast: _used, ...identity } = evidence;
  const expected = evidenceIdOf(identity);
  if (evidenceId !== expected) throw new Error(`evidence integrity mismatch: ${evidenceId}`);
}

/** Verify content address, cutoff safety, ordering, derived usage, and lineup state. */
export function assertMatchContextIntegrity(snapshot: MatchContextSnapshot): void {
  if (snapshot.schemaVersion !== MATCH_CONTEXT_SCHEMA_VERSION) {
    throw new Error(`unsupported match context schema: ${String(snapshot.schemaVersion)}`);
  }
  if (snapshot.competition !== "premier-league") throw new Error("invalid context competition");
  if (snapshot.temporalRule !== MATCH_CONTEXT_TEMPORAL_RULE) throw new Error("invalid temporal rule");
  assertIsoIsCanonical(snapshot.cutoffAt, "cutoffAt");
  assertIsoIsCanonical(snapshot.kickoffAt, "kickoffAt");
  assertIsoIsCanonical(snapshot.generatedAt, "generatedAt");
  if (Date.parse(snapshot.cutoffAt) >= Date.parse(snapshot.kickoffAt)) {
    throw new Error("context cutoffAt must be strictly before kickoffAt");
  }
  if (Date.parse(snapshot.generatedAt) < Date.parse(snapshot.cutoffAt)) {
    throw new Error("context generatedAt must not precede cutoffAt");
  }
  if (Date.parse(snapshot.generatedAt) >= Date.parse(snapshot.kickoffAt)) {
    throw new Error("context generatedAt must be strictly before kickoffAt");
  }

  const ids = new Set<string>();
  for (const item of snapshot.evidence) {
    assertEvidenceIntegrity(item);
    if (item.fixtureId !== snapshot.fixtureId) throw new Error("context contains evidence for another fixture");
    if (item.teamSlug && item.teamSlug !== snapshot.homeSlug && item.teamSlug !== snapshot.awaySlug) {
      throw new Error("context contains evidence for another team");
    }
    if (Date.parse(item.availableAt) > Date.parse(snapshot.cutoffAt)) {
      throw new Error(`evidence after cutoff entered context: ${item.evidenceId}`);
    }
    if (ids.has(item.evidenceId)) throw new Error(`duplicate evidence in context: ${item.evidenceId}`);
    ids.add(item.evidenceId);
    if (item.usedInForecast && snapshot.forecastSnapshotKey === null) {
      throw new Error("observational context cannot claim evidence was used in a forecast");
    }
  }

  const sorted = [...snapshot.evidence].sort(compareEvidence);
  if (canonicalMatchContextJson(normalizeJson(sorted, "sorted evidence")) !==
      canonicalMatchContextJson(normalizeJson(snapshot.evidence, "stored evidence"))) {
    throw new Error("context evidence is not in canonical order");
  }

  const expectedUsed = snapshot.evidence.filter((item) => item.usedInForecast).map((item) => item.evidenceId);
  if (canonicalMatchContextJson(normalizeJson(expectedUsed, "expected usage")) !==
      canonicalMatchContextJson(normalizeJson(snapshot.usedInForecastEvidenceIds, "stored usage"))) {
    throw new Error("usedInForecastEvidenceIds does not match evidence flags");
  }
  const expectedLineup = deriveLineupContext(snapshot.evidence, snapshot.homeSlug, snapshot.awaySlug);
  if (canonicalMatchContextJson(normalizeJson(expectedLineup, "expected lineup")) !==
      canonicalMatchContextJson(normalizeJson(snapshot.lineup, "stored lineup"))) {
    throw new Error("lineup context does not match admitted evidence");
  }
  const expectedAvailability = deriveAvailabilityContext(
    snapshot.evidence,
    snapshot.homeSlug,
    snapshot.awaySlug
  );
  if (canonicalMatchContextJson(normalizeJson(expectedAvailability, "expected availability")) !==
      canonicalMatchContextJson(normalizeJson(snapshot.availability, "stored availability"))) {
    throw new Error("availability context does not match admitted evidence");
  }

  const { contextId, generatedAt: _generatedAt, ...identity } = snapshot;
  const expectedContextId = contextIdOf(identity);
  if (contextId !== expectedContextId) throw new Error(`context integrity mismatch: ${contextId}`);
}

/**
 * Assemble an immutable, content-addressed context at one exact cutoff.
 * Future candidates are reported separately and cannot affect contextId.
 */
export function assembleMatchContext(input: AssembleMatchContextInput): MatchContextBuildResult {
  if (!input || typeof input !== "object") throw new Error("match context input is required");
  const season = nonEmpty(input.season, "season");
  const fixtureId = nonEmpty(input.fixtureId, "fixtureId");
  const homeSlug = nonEmpty(input.homeSlug, "homeSlug");
  const awaySlug = nonEmpty(input.awaySlug, "awaySlug");
  if (homeSlug === awaySlug) throw new Error("homeSlug and awaySlug must differ");
  const kickoffAt = normalizedIso(input.kickoffAt, "kickoffAt");
  const cutoffAt = normalizedIso(input.cutoffAt, "cutoffAt");
  const generatedAt = normalizedIso(input.generatedAt, "generatedAt");
  if (Date.parse(cutoffAt) >= Date.parse(kickoffAt)) {
    throw new Error("context cutoffAt must be strictly before kickoffAt");
  }
  if (Date.parse(generatedAt) < Date.parse(cutoffAt)) {
    throw new Error("context generatedAt must not precede cutoffAt");
  }
  if (Date.parse(generatedAt) >= Date.parse(kickoffAt)) {
    throw new Error("context generatedAt must be strictly before kickoffAt");
  }
  const forecastSnapshotKey = input.forecastSnapshotKey === null
    ? null
    : nonEmpty(input.forecastSnapshotKey, "forecastSnapshotKey");
  if (!Array.isArray(input.evidence)) throw new Error("evidence must be an array");

  const normalized = input.evidence.map((item) =>
    normalizeEvidence(item, { fixtureId, homeSlug, awaySlug })
  );
  const cutoffMs = Date.parse(cutoffAt);
  const future = normalized.filter((item) => Date.parse(item.availableAt) > cutoffMs);
  const futureClaimedUsed = future.find((item) => item.usedInForecast);
  if (futureClaimedUsed) {
    throw new Error(`evidence after cutoff cannot be marked usedInForecast: ${futureClaimedUsed.evidenceId}`);
  }

  const byId = new Map<string, MatchContextEvidence>();
  const duplicateIds = new Set<string>();
  for (const item of normalized.filter((candidate) => Date.parse(candidate.availableAt) <= cutoffMs)) {
    const existing = byId.get(item.evidenceId);
    if (!existing) {
      byId.set(item.evidenceId, item);
      continue;
    }
    duplicateIds.add(item.evidenceId);
    if (existing.usedInForecast !== item.usedInForecast) {
      throw new Error(`duplicate evidence has conflicting usedInForecast flags: ${item.evidenceId}`);
    }
  }
  const evidence = [...byId.values()].sort(compareEvidence);
  if (forecastSnapshotKey === null && evidence.some((item) => item.usedInForecast)) {
    throw new Error("forecastSnapshotKey is required when any evidence is marked usedInForecast");
  }
  const lineup = deriveLineupContext(evidence, homeSlug, awaySlug);
  const availability = deriveAvailabilityContext(evidence, homeSlug, awaySlug);
  const identity: ContextIdentity = {
    schemaVersion: MATCH_CONTEXT_SCHEMA_VERSION,
    competition: "premier-league",
    season,
    fixtureId,
    homeSlug,
    awaySlug,
    kickoffAt,
    cutoffAt,
    forecastSnapshotKey,
    temporalRule: MATCH_CONTEXT_TEMPORAL_RULE,
    evidence,
    usedInForecastEvidenceIds: evidence
      .filter((item) => item.usedInForecast)
      .map((item) => item.evidenceId),
    lineup,
    availability,
  };
  const snapshot = deepFreeze({ contextId: contextIdOf(identity), ...identity, generatedAt });
  assertMatchContextIntegrity(snapshot);
  const diagnostics = deepFreeze({
    candidateEvidenceCount: normalized.length,
    admittedEvidenceCount: evidence.length,
    excludedAfterCutoffEvidenceIds: future.map((item) => item.evidenceId).sort(),
    duplicateEvidenceIds: [...duplicateIds].sort(),
  });
  return deepFreeze({ snapshot, diagnostics });
}

export function cloneFrozenMatchContext(snapshot: MatchContextSnapshot): MatchContextSnapshot {
  return deepFreeze(structuredClone(snapshot));
}
