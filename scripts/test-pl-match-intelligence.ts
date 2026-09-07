/**
 * Premier League Match Intelligence V1.
 * Synthetic inputs are labeled. Champion probabilities must not move.
 */
import assert from "node:assert/strict";
import { deriveMatchIntelligence } from "@/lib/competitions/premier-league/intelligence";
import { getMatchIntelligence } from "@/lib/match-forecast/service";
import { PRODUCTION_MODEL_VERSION } from "@/lib/competitions/premier-league/model-tracks";
import type { DeclaredPlayerProfile, DeclaredTeamArchetype, MatchIntelligenceInput } from "@/lib/competitions/premier-league/intelligence";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const CUTOFF = "2026-09-05T15:00:00.000Z";
const AFTER = "2026-09-05T16:00:00.000Z";

function base(over: Partial<MatchIntelligenceInput> = {}): MatchIntelligenceInput {
  return {
    season: "2026-27",
    fixtureId: "pl-test-intelligence",
    homeSlug: "arsenal",
    awaySlug: "chelsea",
    kickoffAt: "2026-09-06T15:30:00.000Z",
    contextCutoffAt: CUTOFF,
    generatedAt: CUTOFF,
    productionForecastId: "forecast-test",
    contextSnapshot: null,
    sourceAuthorization: "SYNTHETIC_TEST",
    ...over,
  };
}

function player(over: Partial<DeclaredPlayerProfile> & Pick<DeclaredPlayerProfile, "playerId" | "spineRole">): DeclaredPlayerProfile {
  return {
    teamSlug: "arsenal",
    displayName: over.playerId,
    synthetic: true,
    ...over,
  };
}

function evidence(over: {
  entityId: string;
  teamSlug: string;
  availableAt: string;
  availabilityStatus?: string;
  kind?: string;
  sourceName?: string;
  payload?: Record<string, unknown>;
}) {
  return {
    evidenceId: `ev-${over.entityId}-${over.availableAt}`,
    kind: over.kind ?? "SQUAD_AVAILABILITY",
    entityId: over.entityId,
    teamSlug: over.teamSlug,
    observedAt: over.availableAt,
    fetchedAt: over.availableAt,
    availableAt: over.availableAt,
    sourceName: over.sourceName ?? "synthetic-test",
    availabilityStatus: over.availabilityStatus ?? "OUT",
    lineupStatus: null,
    payload: over.payload ?? null,
    usedInForecast: false,
  };
}

async function main() {
await check("empty intelligence does not invent players or probabilities", () => {
  const report = deriveMatchIntelligence(base());
  assert.equal(report.includedInChampionProbability, false);
  assert.equal(report.productionModelVersion, "pl-live-v0.2.0");
  assert.equal(report.availability.length, 0);
  assert.equal(report.lineupState, "LINEUP_UNCERTAIN");
  assert.equal(report.stance, "INSUFFICIENT_EVIDENCE");
  assert.ok(report.disclaimer.includes("not included in the frozen champion"));
});

await check("future availability is excluded from an earlier cutoff", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [player({ playerId: "saka", spineRole: "MAIN_CREATOR", minutesShare: 0.8, replacementGap: 0.7 })],
      contextSnapshot: {
        contextId: "ctx-1",
        cutoffAt: CUTOFF,
        lineupOverall: "NONE",
        evidence: [
          evidence({
            entityId: "saka",
            teamSlug: "arsenal",
            availableAt: AFTER,
            availabilityStatus: "OUT",
          }),
        ],
      },
    })
  );
  assert.equal(report.excludedAfterCutoffCount, 1);
  assert.equal(report.availability[0]?.state, "UNKNOWN");
  assert.equal(report.availability[0]?.absenceImpact, "UNKNOWN");
});

await check("confirmed lineup is a new stage, not an overwrite of EARLY_PREMATCH", () => {
  const early = deriveMatchIntelligence(base({ contextSnapshot: { contextId: "a", cutoffAt: CUTOFF, lineupOverall: "NONE", evidence: [] } }));
  const confirmed = deriveMatchIntelligence(
    base({
      contextCutoffAt: AFTER,
      contextSnapshot: { contextId: "b", cutoffAt: AFTER, lineupOverall: "CONFIRMED", evidence: [] },
    })
  );
  assert.equal(early.contextStage, "EARLY_PREMATCH");
  assert.equal(early.lineupState, "LINEUP_UNCERTAIN");
  assert.equal(confirmed.contextStage, "CONFIRMED_LINEUP");
  assert.equal(confirmed.lineupState, "CONFIRMED");
  assert.notEqual(early.intelligenceId, confirmed.intelligenceId);
});

await check("conflicting availability is surfaced and not silently chosen", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [player({ playerId: "saka", spineRole: "MAIN_CREATOR" })],
      contextSnapshot: {
        contextId: "ctx-c",
        cutoffAt: CUTOFF,
        lineupOverall: "EXPECTED",
        evidence: [
          evidence({ entityId: "saka", teamSlug: "arsenal", availableAt: "2026-09-05T12:00:00.000Z", availabilityStatus: "OUT", sourceName: "rumour" }),
          evidence({ entityId: "saka", teamSlug: "arsenal", availableAt: "2026-09-05T13:00:00.000Z", availabilityStatus: "AVAILABLE", sourceName: "official-premier-league" }),
        ],
      },
    })
  );
  assert.equal(report.conflicts.length >= 1, true);
  assert.equal(report.availability[0]?.state, "UNKNOWN");
});

await check("famous player with deep replacement is not automatically structural", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [
        player({
          playerId: "star",
          spineRole: "PRIMARY_FINISHER",
          minutesShare: 0.7,
          attackingRole: 0.9,
          roleScarcity: 0.2,
          replacementGap: 0.2,
          samePositionalArchetype: true,
          formationCanRemain: true,
        }),
      ],
      contextSnapshot: {
        contextId: "ctx-d",
        cutoffAt: CUTOFF,
        lineupOverall: "EXPECTED",
        evidence: [evidence({ entityId: "star", teamSlug: "arsenal", availableAt: "2026-09-05T12:00:00.000Z", availabilityStatus: "OUT" })],
      },
    })
  );
  const row = report.availability[0];
  assert.ok(row);
  assert.notEqual(row.absenceImpact, "STRUCTURAL");
  assert.equal(row.replacement?.systemDisruption === "STRUCTURAL", false);
});

await check("less famous DM with no replacement can be structural", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [
        player({
          playerId: "holder",
          displayName: "Holding midfielder",
          spineRole: "DEFENSIVE_MIDFIELDER",
          minutesShare: 0.85,
          startShare: 0.9,
          defensiveRole: 0.9,
          progressionRole: 0.6,
          roleScarcity: 0.95,
          replacementGap: 0.95,
          formationCanRemain: false,
          anotherKeyPlayerForcedRoleChange: true,
        }),
      ],
      contextSnapshot: {
        contextId: "ctx-e",
        cutoffAt: CUTOFF,
        lineupOverall: "EXPECTED",
        evidence: [evidence({ entityId: "holder", teamSlug: "arsenal", availableAt: "2026-09-05T12:00:00.000Z", availabilityStatus: "OUT" })],
      },
    })
  );
  assert.equal(report.availability[0]?.occupiesSpine, true);
  assert.equal(report.availability[0]?.replacement?.systemDisruption, "STRUCTURAL");
  assert.ok(["HIGH", "STRUCTURAL"].includes(report.availability[0]?.absenceImpact ?? ""));
});

await check("two CBs missing disrupt the CB unit", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [
        player({ playerId: "cb1", teamSlug: "arsenal", spineRole: "CENTER_BACK", minutesShare: 0.8, replacementGap: 0.8 }),
        player({ playerId: "cb2", teamSlug: "arsenal", spineRole: "CENTER_BACK", minutesShare: 0.8, replacementGap: 0.8 }),
      ],
      contextSnapshot: {
        contextId: "ctx-f",
        cutoffAt: CUTOFF,
        lineupOverall: "EXPECTED",
        evidence: [
          evidence({ entityId: "cb1", teamSlug: "arsenal", availableAt: "2026-09-05T12:00:00.000Z", availabilityStatus: "OUT" }),
          evidence({ entityId: "cb2", teamSlug: "arsenal", availableAt: "2026-09-05T12:00:00.000Z", availabilityStatus: "OUT" }),
        ],
      },
    })
  );
  const unit = report.units.find((row) => row.kind === "CB_PAIR" && row.teamSlug === "arsenal");
  assert.equal(unit?.state, "STRUCTURALLY_DISRUPTED");
});

const highLineHome: DeclaredTeamArchetype = {
  teamSlug: "arsenal",
  archetypes: ["HIGH_DEFENSIVE_LINE"],
  lineHeight: "HIGH",
  recoverySpeed: "LOW",
  pressIntensity: "HIGH",
  pressResistance: "MODERATE",
  chanceCreation: "HIGH",
  sterilePossessionRisk: true,
  wideThreatLeft: "HIGH",
  wideThreatRight: "MODERATE",
  centralControl: "HIGH",
  aerialAttack: "MODERATE",
  aerialDefence: "LOW",
  setPieceDelivery: "MODERATE",
  transitionAttack: "MODERATE",
  restDefence: "LOW",
  boxThreat: "HIGH",
  finishing: "HIGH",
  compactness: "LOW",
  synthetic: true,
};
const paceAway: DeclaredTeamArchetype = {
  teamSlug: "chelsea",
  archetypes: ["DIRECT_TRANSITION"],
  lineHeight: "MODERATE",
  recoverySpeed: "HIGH",
  pressIntensity: "LOW",
  pressResistance: "LOW",
  chanceCreation: "MODERATE",
  sterilePossessionRisk: false,
  wideThreatLeft: "LOW",
  wideThreatRight: "LOW",
  centralControl: "LOW",
  aerialAttack: "HIGH",
  aerialDefence: "LOW",
  setPieceDelivery: "HIGH",
  transitionAttack: "HIGH",
  restDefence: "MODERATE",
  boxThreat: "MODERATE",
  finishing: "MODERATE",
  compactness: "HIGH",
  synthetic: true,
};

await check("Case A high line vs elite pace flags transition vulnerability", () => {
  const report = deriveMatchIntelligence(base({ archetypes: [highLineHome, paceAway] }));
  const row = report.matchups.find((item) => item.id === "HIGH_LINE_VS_PACE");
  assert.equal(row?.level, "HIGH");
  assert.equal(row?.favors, "away");
});

await check("Case B low block vs sterile possession flags sterile-possession risk", () => {
  const report = deriveMatchIntelligence(base({ archetypes: [highLineHome, paceAway] }));
  const row = report.matchups.find((item) => item.id === "LOW_BLOCK_VS_CHANCE_CREATION");
  assert.equal(row?.sterilePossessionRisk, true);
});

await check("Case C high press vs poor buildup favors the press", () => {
  const report = deriveMatchIntelligence(base({ archetypes: [highLineHome, paceAway] }));
  const row = report.matchups.find((item) => item.id === "PRESS_VS_BUILD_UP");
  assert.equal(row?.level, "HIGH");
  assert.equal(row?.favors, "home");
});

await check("Case D weak aerial defence vs set-piece threat is flagged", () => {
  const report = deriveMatchIntelligence(base({ archetypes: [highLineHome, paceAway] }));
  const row = report.matchups.find((item) => item.id === "AERIAL_SET_PIECE");
  assert.ok(row && row.level !== "UNKNOWN");
});

await check("Case E elite winger vs weak flank is flagged", () => {
  const report = deriveMatchIntelligence(base({ archetypes: [highLineHome, paceAway] }));
  const row = report.matchups.find((item) => item.id === "WIDE_LEFT");
  assert.equal(row?.level, "HIGH");
  assert.equal(row?.favors, "home");
});

await check("missing stats are not fabricated into importance", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [player({ playerId: "unknown-kid", spineRole: "OTHER" })],
    })
  );
  assert.equal(report.availability[0]?.importance?.importanceScore, null);
  assert.equal(report.availability[0]?.importance?.evidenceCompleteness, 0);
  assert.equal(report.availability[0]?.importance?.confidence, "LOW");
});

await check("speculation is not treated as verified absence", () => {
  const report = deriveMatchIntelligence(
    base({
      players: [player({ playerId: "saka", spineRole: "MAIN_CREATOR" })],
      contextSnapshot: {
        contextId: "ctx-g",
        cutoffAt: CUTOFF,
        lineupOverall: "NONE",
        evidence: [
          evidence({
            entityId: "saka",
            teamSlug: "arsenal",
            availableAt: "2026-09-05T12:00:00.000Z",
            availabilityStatus: "OUT",
            sourceName: "twitter-rumour",
          }),
        ],
      },
    })
  );
  assert.equal(report.availability[0]?.evidence.sourceTier, "SPECULATION");
  assert.equal(report.availability[0]?.evidence.verification, "SPECULATIVE");
});

await check("production Match Room 1X2 is unchanged after intelligence attachment", async () => {
  const data = await getMatchIntelligence("pl-2026-27-arsenal-chelsea", new Date("2026-08-25T00:00:00Z"));
  assert.equal(data.forecast.modelVersion, PRODUCTION_MODEL_VERSION);
  assert.ok(Math.abs(data.forecast.result.homeWin - 0.6134875203) < 1e-8);
  assert.ok(Math.abs(data.forecast.result.draw - 0.2236346278) < 1e-8);
  assert.ok(Math.abs(data.forecast.result.awayWin - 0.1628778518) < 1e-8);
  assert.equal(data.matchIntelligence.includedInChampionProbability, false);
  assert.equal(data.matchIntelligence.productionForecastId, data.forecast.provenance.immutableForecastId);
  assert.equal(data.audit.contextEvidenceCounts.usedInForecast, 0);
  assert.equal(data.forecast.modelRole, "production");
});

await check("missing production snapshot still fails closed independently of intelligence", async () => {
  await assert.rejects(() => getMatchIntelligence("pl-does-not-exist"), /Unknown Premier League match/);
});

console.log(`\nPL Match Intelligence V1: ${passed} passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
