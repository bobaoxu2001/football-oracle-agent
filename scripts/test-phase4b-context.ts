/** Phase 4B match-context temporal, identity, immutability, and diff gates. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileMatchContextStore,
  InMemoryMatchContextStore,
  assembleMatchContext,
  assertMatchContextIntegrity,
  diffMatchContexts,
  type AssembleMatchContextInput,
  type MatchContextEvidenceInput,
} from "@/lib/competitions/premier-league/context";

const FIXTURE = "premier-league-2026-27-arsenal-chelsea-2026-09-12";
const HOME = "arsenal";
const AWAY = "chelsea";
const KICKOFF = "2026-09-12T20:00:00.000Z";
const CUTOFF = "2026-09-12T17:00:00.000Z";
const GENERATED = "2026-09-12T17:00:05.000Z";
const FORECAST_KEY = "premier-league::2026-27::fixture::champion-v1::T2H::cutoff";

function evidenceMeta(
  entityId: string,
  availableAt: string,
  digestCharacter: string,
  confidence = 0.9
): Pick<
  MatchContextEvidenceInput,
  "entityId" | "observedAt" | "fetchedAt" | "availableAt" | "confidence" | "rawEvidenceHash"
> {
  const availableMs = Date.parse(availableAt);
  return {
    entityId,
    observedAt: new Date(availableMs - 2_000).toISOString(),
    fetchedAt: new Date(availableMs - 1_000).toISOString(),
    availableAt,
    confidence,
    rawEvidenceHash: `sha256:${digestCharacter.repeat(64)}`,
  };
}

function buildInput(
  evidence: readonly MatchContextEvidenceInput[],
  overrides: Partial<Omit<AssembleMatchContextInput, "evidence">> = {}
): AssembleMatchContextInput {
  return {
    season: "2026-27",
    fixtureId: FIXTURE,
    homeSlug: HOME,
    awaySlug: AWAY,
    kickoffAt: KICKOFF,
    cutoffAt: CUTOFF,
    generatedAt: GENERATED,
    forecastSnapshotKey: FORECAST_KEY,
    evidence,
    ...overrides,
  };
}

const homePredicted: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "LINEUP",
  teamSlug: HOME,
  ...evidenceMeta(HOME, "2026-09-12T15:00:00.000Z", "a"),
  source: { name: "lineup-provider", recordId: "arsenal-predicted-1", url: "https://example.test/a" },
  payload: { formation: "4-3-3", players: ["a", "b"] },
  usedInForecast: false,
  lineupStatus: "EXPECTED",
};

const news: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "TEAM_NEWS",
  teamSlug: HOME,
  ...evidenceMeta(HOME, "2026-09-12T16:00:00.000Z", "b", 0.8),
  source: { name: "club-feed", recordId: "news-17", url: "https://example.test/news-17" },
  payload: { category: "availability", title: "Training update" },
  usedInForecast: false,
};

const fixtureAtCutoff: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "FIXTURE",
  teamSlug: null,
  ...evidenceMeta(FIXTURE, CUTOFF, "c", 1),
  source: { name: "fixture-provider", recordId: "fixture-version-33" },
  payload: { certainty: "CONFIRMED", kickoffAt: KICKOFF, status: "SCHEDULED" },
  usedInForecast: false,
};

const awayConfirmedAfterCutoff: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "LINEUP",
  teamSlug: AWAY,
  ...evidenceMeta(AWAY, "2026-09-12T17:00:00.001Z", "d"),
  source: { name: "lineup-provider", recordId: "chelsea-confirmed-1" },
  payload: { formation: "4-2-3-1", players: ["c", "d"] },
  usedInForecast: false,
  lineupStatus: "CONFIRMED",
};

const homeConfirmedLater: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "LINEUP",
  teamSlug: HOME,
  ...evidenceMeta(HOME, "2026-09-12T17:30:00.000Z", "e"),
  source: { name: "lineup-provider", recordId: "arsenal-confirmed-1" },
  payload: { formation: "4-3-3", players: ["a", "z"] },
  usedInForecast: false,
  lineupStatus: "CONFIRMED",
};

const homeDoubtful: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "SQUAD_AVAILABILITY",
  teamSlug: HOME,
  ...evidenceMeta("player-a", "2026-09-12T16:30:00.000Z", "f", 0.85),
  source: { name: "availability-provider", recordId: "player-a-update-1" },
  payload: { detail: "Late fitness test" },
  usedInForecast: false,
  availabilityStatus: "DOUBTFUL",
};

const homeOutLater: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "SQUAD_AVAILABILITY",
  teamSlug: HOME,
  ...evidenceMeta("player-a", "2026-09-12T17:30:01.000Z", "1", 0.95),
  source: { name: "availability-provider", recordId: "player-a-update-2" },
  payload: { detail: "Ruled out" },
  usedInForecast: false,
  availabilityStatus: "OUT",
};

const awayExpectedAvailable: MatchContextEvidenceInput = {
  fixtureId: FIXTURE,
  kind: "SQUAD_AVAILABILITY",
  teamSlug: AWAY,
  ...evidenceMeta("player-b", "2026-09-12T16:45:00.000Z", "2", 0.7),
  source: { name: "availability-provider", recordId: "player-b-update-1" },
  payload: { detail: "Expected to pass assessment" },
  usedInForecast: false,
  availabilityStatus: "EXPECTED_AVAILABLE",
};

function main(): void {
  const candidates = [
    awayConfirmedAfterCutoff,
    fixtureAtCutoff,
    homePredicted,
    fixtureAtCutoff,
    news,
    homeConfirmedLater,
    homeDoubtful,
    homeOutLater,
    awayExpectedAvailable,
  ];
  const early = assembleMatchContext(buildInput(candidates));

  // Inclusive cutoff admission, strict exclusion after cutoff, and no future-id leakage.
  assert.equal(early.diagnostics.candidateEvidenceCount, 9);
  assert.equal(early.diagnostics.admittedEvidenceCount, 5);
  assert.equal(early.diagnostics.excludedAfterCutoffEvidenceIds.length, 3);
  assert.equal(early.diagnostics.duplicateEvidenceIds.length, 1);
  assert.equal(early.snapshot.evidence.some((item) => item.availableAt === CUTOFF), true);
  assert.equal(
    early.snapshot.evidence.every((item) => Date.parse(item.availableAt) <= Date.parse(CUTOFF)),
    true
  );
  for (const futureId of early.diagnostics.excludedAfterCutoffEvidenceIds) {
    assert.equal(JSON.stringify(early.snapshot).includes(futureId), false);
  }
  assert.deepEqual(early.snapshot.usedInForecastEvidenceIds, []);
  assert.equal(early.snapshot.evidence.every((item) => item.usedInForecast === false), true);
  assert.equal(early.snapshot.lineup.home.status, "EXPECTED");
  assert.equal(early.snapshot.lineup.away.status, "NONE");
  assert.equal(early.snapshot.lineup.overall, "PARTIAL");
  assert.equal(early.snapshot.availability.home.entities[0].entityId, "player-a");
  assert.equal(early.snapshot.availability.home.entities[0].status, "DOUBTFUL");
  assert.equal(early.snapshot.availability.home.statusCounts.DOUBTFUL, 1);
  assert.equal(early.snapshot.availability.away.entities[0].status, "EXPECTED_AVAILABLE");
  assert.match(early.snapshot.contextId, /^pl-match-context-v1:sha256:[a-f0-9]{64}$/);
  assertMatchContextIntegrity(early.snapshot);

  // Candidate order, duplicate delivery, object-key order, and future-only candidates
  // do not alter the canonical snapshot or its content address.
  const fixtureWithDifferentKeyOrder: MatchContextEvidenceInput = {
    ...fixtureAtCutoff,
    payload: { status: "SCHEDULED", kickoffAt: KICKOFF, certainty: "CONFIRMED" },
  };
  const deterministic = assembleMatchContext(
    buildInput([awayExpectedAvailable, homeDoubtful, news, fixtureWithDifferentKeyOrder, homePredicted])
  );
  assert.equal(deterministic.snapshot.contextId, early.snapshot.contextId);
  assert.equal(JSON.stringify(deterministic.snapshot), JSON.stringify(early.snapshot));

  // usedInForecast is explicit forecast-relative metadata, not evidence identity.
  const newsUsed = { ...news, usedInForecast: true } satisfies MatchContextEvidenceInput;
  const usageChanged = assembleMatchContext(
    buildInput([homePredicted, newsUsed, fixtureAtCutoff, homeDoubtful, awayExpectedAvailable])
  ).snapshot;
  const earlyNews = early.snapshot.evidence.find((item) => item.kind === "TEAM_NEWS")!;
  const usedNews = usageChanged.evidence.find((item) => item.kind === "TEAM_NEWS")!;
  assert.equal(earlyNews.evidenceId, usedNews.evidenceId);
  assert.notEqual(early.snapshot.contextId, usageChanged.contextId);
  assert.deepEqual(usageChanged.usedInForecastEvidenceIds, [usedNews.evidenceId]);
  const usageDiff = diffMatchContexts(early.snapshot, usageChanged);
  assert.equal(usageDiff.addedEvidence.length, 0);
  assert.equal(usageDiff.removedEvidence.length, 0);
  assert.deepEqual(usageDiff.forecastUsageChanges, [
    { evidenceId: usedNews.evidenceId, kind: "TEAM_NEWS", before: false, after: true },
  ]);
  assert.equal(usageDiff.causalAttribution, "not-established");

  assert.throws(
    () => assembleMatchContext(buildInput([newsUsed], { forecastSnapshotKey: null })),
    /forecastSnapshotKey is required/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...awayConfirmedAfterCutoff, usedInForecast: true }])),
    /after cutoff cannot be marked usedInForecast/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, usedInForecast: undefined } as unknown as MatchContextEvidenceInput])),
    /explicit boolean/
  );

  // A later cutoff admits only evidence actually available by then and derives
  // the newest lineup state independently for each side.
  const later = assembleMatchContext(
    buildInput(candidates, {
      cutoffAt: "2026-09-12T18:00:00.000Z",
      generatedAt: "2026-09-12T18:00:05.000Z",
    })
  ).snapshot;
  assert.equal(later.evidence.length, 8);
  assert.equal(later.lineup.home.status, "CONFIRMED");
  assert.equal(later.lineup.away.status, "CONFIRMED");
  assert.equal(later.lineup.overall, "CONFIRMED");
  assert.equal(later.availability.home.entities[0].status, "OUT");
  const temporalDiff = diffMatchContexts(early.snapshot, later);
  assert.equal(temporalDiff.addedEvidence.length, 3);
  assert.equal(temporalDiff.removedEvidence.length, 0);
  assert.deepEqual(temporalDiff.lineupChanges.map((change) => change.side), ["home", "away"]);
  assert.deepEqual(temporalDiff.availabilityChanges.map((change) => change.entityId), ["player-a"]);
  assert.match(temporalDiff.causalNote, /does not establish/);
  assert.throws(() => diffMatchContexts(later, early.snapshot), /must not precede/);

  const rescheduled = assembleMatchContext(
    buildInput([homePredicted, news, fixtureAtCutoff, homeDoubtful, awayExpectedAvailable], {
      kickoffAt: "2026-09-12T21:00:00.000Z",
    })
  ).snapshot;
  const rescheduleDiff = diffMatchContexts(early.snapshot, rescheduled);
  assert.deepEqual(rescheduleDiff.kickoffChanged, { before: KICKOFF, after: "2026-09-12T21:00:00.000Z" });
  assert.notEqual(rescheduled.contextId, early.snapshot.contextId);

  // Runtime immutability and hash verification reject attempts to rewrite history.
  assert.equal(Object.isFrozen(early.snapshot), true);
  assert.equal(Object.isFrozen(early.snapshot.evidence), true);
  assert.equal(Object.isFrozen(early.snapshot.evidence[0].payload), true);
  assert.throws(() => {
    (early.snapshot as unknown as { cutoffAt: string }).cutoffAt = "2026-01-01T00:00:00.000Z";
  });
  const tampered = structuredClone(early.snapshot) as unknown as {
    evidence: Array<{ payload: Record<string, unknown> }>;
  };
  tampered.evidence[0].payload.tampered = true;
  assert.throws(
    () => assertMatchContextIntegrity(tampered as unknown as typeof early.snapshot),
    /evidence integrity mismatch/
  );

  // Both store implementations are first-write-wins. A new context appends;
  // retrying the same content address is byte-idempotent across restart.
  const memoryStore = new InMemoryMatchContextStore();
  assert.equal(memoryStore.insert(early.snapshot).status, "inserted");
  assert.equal(memoryStore.insert(early.snapshot).status, "duplicate");
  assert.equal(memoryStore.insert(later).status, "inserted");
  assert.equal(memoryStore.size, 2);
  assert.equal(memoryStore.get(early.snapshot.contextId)?.contextId, early.snapshot.contextId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "foa-phase4b-context-"));
  const storePath = path.join(tempDir, "contexts.jsonl");
  const fileStore = new FileMatchContextStore(storePath);
  assert.equal(fileStore.insert(early.snapshot).status, "inserted");
  const bytesAfterFirst = fs.readFileSync(storePath, "utf8");
  assert.equal(fileStore.insert(early.snapshot).status, "duplicate");
  assert.equal(fs.readFileSync(storePath, "utf8"), bytesAfterFirst);
  assert.equal(fileStore.insert(later).status, "inserted");
  assert.equal(fs.readFileSync(storePath, "utf8").trim().split("\n").length, 2);
  const restartedStore = new FileMatchContextStore(storePath);
  assert.equal(restartedStore.size, 2);
  assert.equal(restartedStore.get(early.snapshot.contextId)?.contextId, early.snapshot.contextId);
  assert.equal(Object.isFrozen(restartedStore.get(early.snapshot.contextId)), true);

  // Fail closed on malformed timestamps, wrong fixture/team scope, invalid lineup
  // semantics, post-kickoff cutoffs, and non-JSON payloads.
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, availableAt: "not-a-date" }])),
    /ISO timestamp/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, fixtureId: "other-fixture" }])),
    /does not match/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, teamSlug: "liverpool" }])),
    /not part of fixture/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, lineupStatus: "CONFIRMED" }])),
    /only valid for LINEUP/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([news], { cutoffAt: KICKOFF })),
    /strictly before kickoff/
  );
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, payload: { bad: Number.NaN } }])),
    /non-finite/
  );

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(
    () => assembleMatchContext(buildInput([{ ...news, payload: cyclic as never }])),
    /cycle/
  );

  console.log("Phase 4B context tests passed");
}

main();
