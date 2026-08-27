/** Phase 4A4: production membership authority must fail closed. */

import assert from "node:assert/strict";

import { liveCompetitionSeason } from "@/lib/competitions/premier-league/fixture-store";
import {
  assertSeasonMembershipIntegrity,
  assertVerifiedSeasonMembershipSnapshot,
  buildSeasonMembershipSnapshot,
  buildSourceObservationReference,
} from "@/lib/competitions/premier-league/provenance";
import { assertProductionMembershipCaptureReady } from "@/lib/competitions/premier-league/provenance/production";
import type { CompetitionSeason } from "@/lib/identity/types";

let passed = 0;

function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const loadedLiveSeason = liveCompetitionSeason();
if (!loadedLiveSeason) {
  throw new Error("the production season manifest must be present for this gate suite");
}
const live: CompetitionSeason = loadedLiveSeason;

function season(overrides: Partial<CompetitionSeason> = {}): CompetitionSeason {
  return {
    ...live,
    clubIds: [...live.clubIds],
    verifiedAgainst: [...(live.verifiedAgainst ?? [])],
    ...overrides,
  };
}

const blocked = /complete independently verified season field/;

check("M1 current live membership carries explicit independent verification", () => {
  assert.equal(live.verificationStatus, "VERIFIED");
  assert.equal(live.clubIds.length, live.expectedClubCount);
  assert.ok((live.verifiedAgainst?.length ?? 0) > 0);
  assert.ok(live.verificationArtifact);
  assert.doesNotThrow(() => assertProductionMembershipCaptureReady(live));
});

check("M2 a complete 20-club SOURCE_CONFLICT field is rejected", () => {
  assert.throws(
    () =>
      assertProductionMembershipCaptureReady(
        season({ verificationStatus: "SOURCE_CONFLICT" })
      ),
    blocked
  );
});

check("M3 a complete 20-club PROVISIONAL field is rejected", () => {
  assert.throws(
    () =>
      assertProductionMembershipCaptureReady(
        season({ verificationStatus: "PROVISIONAL" })
      ),
    blocked
  );
});

check("M4 a complete 20-club STALE field is rejected", () => {
  assert.throws(
    () =>
      assertProductionMembershipCaptureReady(season({ verificationStatus: "STALE" })),
    blocked
  );
});

check("M5 VERIFIED without independent comparison sources is rejected", () => {
  assert.throws(
    () => assertProductionMembershipCaptureReady(season({ verifiedAgainst: [] })),
    blocked
  );
});

check("M6 VERIFIED without its audit artifact is rejected", () => {
  assert.throws(
    () => assertProductionMembershipCaptureReady(season({ verificationArtifact: "" })),
    blocked
  );
});

check("M7 duplicate club identities cannot satisfy the expected count", () => {
  const duplicated = [...live.clubIds];
  duplicated[duplicated.length - 1] = duplicated[0];
  assert.equal(duplicated.length, live.expectedClubCount);
  assert.throws(
    () => assertProductionMembershipCaptureReady(season({ clubIds: duplicated })),
    blocked
  );
});

check("M8 an incomplete VERIFIED field is rejected", () => {
  assert.throws(
    () =>
      assertProductionMembershipCaptureReady(
        season({ clubIds: live.clubIds.slice(0, -1) })
      ),
    blocked
  );
});

check("M9 membership verification remains independent of schedule completeness", () => {
  assert.doesNotThrow(() =>
    assertProductionMembershipCaptureReady(
      season({ scheduleCompleteness: "partial" })
    )
  );
});

check("M10 a missing season fails closed", () => {
  assert.throws(() => assertProductionMembershipCaptureReady(null), blocked);
});

const legacyAt = "2026-08-01T00:00:00.000Z";
const legacySource = buildSourceObservationReference({
  sourceType: "season-membership",
  sourceId: "legacy-membership",
  sourceVersion: "v1",
  observationId: "legacy-membership:v1",
  publishedAt: legacyAt,
  availableAt: legacyAt,
  retrievedAt: legacyAt,
  payload: { teams: ["arsenal", "chelsea"] },
});
const legacySnapshot = buildSeasonMembershipSnapshot({
  season: "2026-27",
  teamSlugs: ["chelsea", "arsenal"],
  sourceObservations: [legacySource],
});

check("M11 legacy membership bytes and content address remain unchanged", () => {
  assert.equal(
    legacySnapshot.seasonMembershipSnapshotId,
    "pl-season-membership:sha256:b9135735c52ffe8b5483534935655537b1637d0e7e45845b3d8fe161c4913833"
  );
  assert.equal(legacySnapshot.verificationStatus, undefined);
  assert.doesNotThrow(() => assertSeasonMembershipIntegrity(legacySnapshot));
});

check("M12 readable legacy membership is not production-verifiable", () => {
  assert.throws(
    () => assertVerifiedSeasonMembershipSnapshot(legacySnapshot),
    /lacks complete VERIFIED proof/
  );
});

const verifiedSnapshot = buildSeasonMembershipSnapshot({
  season: "2026-27",
  teamSlugs: ["chelsea", "arsenal"],
  sourceObservations: [legacySource],
  verificationStatus: "VERIFIED",
  verifiedAt: legacyAt,
  verifiedAgainst: ["source-b", "source-a"],
  verificationArtifact: "membership-audit.json",
});

check("M13 new membership freezes canonical verification proof", () => {
  assert.notEqual(
    verifiedSnapshot.seasonMembershipSnapshotId,
    legacySnapshot.seasonMembershipSnapshotId
  );
  assert.equal(verifiedSnapshot.verificationStatus, "VERIFIED");
  assert.equal(verifiedSnapshot.verifiedAt, legacyAt);
  assert.deepEqual(verifiedSnapshot.verifiedAgainst, ["source-a", "source-b"]);
  assert.equal(verifiedSnapshot.verificationArtifact, "membership-audit.json");
  assert.doesNotThrow(() => assertVerifiedSeasonMembershipSnapshot(verifiedSnapshot));
});

check("M14 verification proof is part of the immutable content address", () => {
  const tampered = {
    ...verifiedSnapshot,
    verificationArtifact: "different-audit.json",
  };
  assert.throws(
    () => assertSeasonMembershipIntegrity(tampered),
    /season membership integrity mismatch/
  );
});

check("M15 partial verification proof cannot be serialized", () => {
  assert.throws(
    () =>
      buildSeasonMembershipSnapshot({
        season: "2026-27",
        teamSlugs: ["arsenal", "chelsea"],
        sourceObservations: [legacySource],
        verificationStatus: "VERIFIED",
      }),
    /membership.verifiedAt/
  );
});

console.log(`\nPhase 4A4 membership gate: ${passed}/15 passed`);
