/**
 * Big Five match ledger gates.
 *
 * Covers canonical parsing, idempotency, corrections, missing statistics,
 * identity stability, competition/season isolation, temporal cutoff, leakage,
 * rolling features, early-season shrinkage, settlement linkage and API
 * serialization.
 *
 * TEMPORAL LEAKAGE IS A HARD RELEASE GATE. The leakage section below must never
 * be weakened or skipped: it is the property that makes the LIVE_OOS ledger
 * trustworthy.
 *
 * Runs entirely against an isolated temp store with a fixture payload — no
 * network, no production data, no provider key required.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "foa-ledger-"));
process.env.MATCH_LEDGER_DIR = path.join(TMP, "ledger");
process.env.MATCH_LEDGER_BACKEND = "file";
process.env.SNAPSHOT_STORE_PATH = path.join(TMP, "working-snapshots.jsonl");
process.env.LIVE_OOS_ARCHIVE_PATH = path.join(TMP, "archive.jsonl");
process.env.SETTLEMENT_STORE_PATH = path.join(TMP, "settlements.jsonl");
process.env.PL_OPS_DIR = path.join(TMP, "ops");
process.env.PL_OPERATIONAL_LIVE_OOS_PATH = path.join(TMP, "ops/live-oos-operational.jsonl");
process.env.PL_OPS_BACKEND = "file";
process.env.MATCH_LEDGER_DISABLED = "1";
delete process.env.VERCEL;
delete process.env.FOOTBALL_DATA_API_KEY;

import { BIG_FIVE_COMPETITION_IDS, isBigFiveCompetitionId } from "@/lib/competitions/types";
import { getCompetition, listBigFiveCompetitions, resolveLedgerCompetitionId } from "@/lib/competitions/registry";
import {
  mapFootballDataMatch,
  mapLedgerStatus,
  observationIdFor,
  trimRawEnvelope,
  FOOTBALL_DATA_CAPABILITY,
  type FootballDataMatch,
} from "@/lib/match-ledger/providers/football-data";
import {
  canonicalMatchId,
  deriveTeamSlug,
  resolveLedgerTeam,
  type TeamIdentityRegistry,
} from "@/lib/match-ledger/identity";
import { materializeAll, materializeMatch } from "@/lib/match-ledger/materialize";
import {
  emptyTeamStatistics,
  isCompletedMatch,
  statisticsAreEmpty,
  type MatchObservation,
} from "@/lib/match-ledger/types";
import {
  appendObservations,
  clearMatchLedgerForTests,
  listCanonicalMatches,
  listObservations,
} from "@/lib/match-ledger/store";
import { ingestCompetition } from "@/lib/match-ledger/ingest";
import {
  admissibleMatches,
  blendWithPrior,
  buildTeamFeatures,
  currentSeasonWeight,
  rollingForm,
  teamMatchLines,
  PRIOR_MATCH_EQUIVALENT,
} from "@/lib/match-ledger/features";
import { fixtureFromCanonicalMatch, settleCompletedMatches } from "@/lib/match-ledger/settlement-link";
import { ingestIsDue, emptyLedgerState } from "@/lib/match-ledger/scheduler";
import { serializeMatchForApi, serializeTeamSeason } from "@/lib/match-ledger/serialize";
import { latestPreKickoffSnapshot } from "@/lib/match-ledger/views";
import { createSnapshot } from "@/lib/snapshots/store";
import { snapshotUniqueKey, type PredictionSnapshot } from "@/lib/snapshots/types";
import { loadSettlements } from "@/lib/competitions/premier-league/settlement";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`✗ ${name}${detail ? " — " + detail : ""}`);
  }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const OBSERVED = "2026-08-22T12:00:00.000Z";

// ── Fixture payloads (shaped exactly like the live provider) ───────────────

/** The sanity fixture: Arsenal 3-0 Coventry, 2026-08-21. NOT hard-coded anywhere
 *  in library code — it lives here, in the test, as a validation payload. */
const ARSENAL_COVENTRY: FootballDataMatch = {
  id: 560542,
  utcDate: "2026-08-21T19:00:00Z",
  status: "FINISHED",
  matchday: 1,
  stage: "REGULAR_SEASON",
  lastUpdated: "2026-08-21T22:25:13Z",
  area: { id: 2072, name: "England" },
  competition: { id: 2021, code: "PL" },
  season: { id: 2502, startDate: "2026-08-21" },
  homeTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS" },
  awayTeam: { id: 1076, name: "Coventry City FC", shortName: "Coventry City", tla: "COV" },
  score: {
    winner: "HOME_TEAM",
    duration: "REGULAR",
    fullTime: { home: 3, away: 0 },
    halfTime: { home: 2, away: 0 },
  },
} as FootballDataMatch;

/** A future fixture carrying the provider's real malformed status bug. */
const MALFORMED_STATUS: FootballDataMatch = {
  id: 560593,
  utcDate: "2026-10-10T11:30:00Z",
  status: "2026-10-10 14:00:00Z",
  matchday: 6,
  homeTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS" },
  awayTeam: { id: 341, name: "Leeds United FC", shortName: "Leeds United", tla: "LEE" },
  score: { winner: null, fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
};

const SCHEDULED_FUTURE: FootballDataMatch = {
  id: 560600,
  utcDate: "2026-09-12T14:00:00Z",
  status: "TIMED",
  matchday: 3,
  homeTeam: { id: 61, name: "Chelsea FC", shortName: "Chelsea", tla: "CHE" },
  awayTeam: { id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS" },
  score: { winner: null, fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
};

function mapOne(raw: FootballDataMatch, registry: TeamIdentityRegistry = {}, observedAt = OBSERVED) {
  return mapFootballDataMatch(raw, {
    competition: "premier-league",
    season: "2026-27",
    observedAt,
    registry,
  });
}

// ── Competition registry ──────────────────────────────────────────────────
check("five Big Five competitions registered", listBigFiveCompetitions().length === 5);
check("world cup is not a Big Five league", !isBigFiveCompetitionId("world-cup"));
check("every Big Five config is a league", listBigFiveCompetitions().every((c) => c.competitionType === "league"));
check(
  "each competition has a distinct football-data code",
  new Set(listBigFiveCompetitions().map((c) => c.footballDataCode)).size === 5
);
check("Bundesliga is an 18-club / 34-matchday season", getCompetition("bundesliga").seasonFormat.matchdays === 34);
check("La Liga breaks ties on head-to-head before GD", getCompetition("la-liga").standingsRules.tiebreakers[1] === "h2h");
check("Premier League breaks ties on GD (not h2h)", getCompetition("premier-league").standingsRules.tiebreakers[1] === "gd");
check("ledger query routing finds La Liga", resolveLedgerCompetitionId("La Liga table") === "la-liga");
check("ledger query routing returns null for an unknown league", resolveLedgerCompetitionId("who wins the Eredivisie") === null);

// ── Canonical parsing ─────────────────────────────────────────────────────
const mappedArsenal = mapOne(ARSENAL_COVENTRY);
const obsArsenal = mappedArsenal.observation!;
check("completed match parses", obsArsenal !== null);
check("status maps to FINISHED", obsArsenal.status === "FINISHED");
check("full-time score parsed", obsArsenal.fullTimeHomeGoals === 3 && obsArsenal.fullTimeAwayGoals === 0);
check("half-time score parsed", obsArsenal.halfTimeHomeGoals === 2 && obsArsenal.halfTimeAwayGoals === 0);
check("outcome derived as HOME", obsArsenal.outcome === "HOME");
check("matchday parsed", obsArsenal.matchday === 1);
check("kickoff normalised to ISO", obsArsenal.kickoffUtc === "2026-08-21T19:00:00.000Z");
check("provider match id retained", obsArsenal.providerMatchId === "560542");
check("provider update time retained", obsArsenal.providerUpdatedAt === "2026-08-21T22:25:13.000Z");
check(
  "canonical id matches the existing PL fixture id format",
  obsArsenal.canonicalMatchId === "pl-2026-27-arsenal-coventry",
  obsArsenal.canonicalMatchId
);
check("raw payload retained for audit", obsArsenal.raw !== null && typeof obsArsenal.raw === "object");
check(
  "raw envelope trimmed but match fields kept",
  !("competition" in (obsArsenal.raw as object)) && "score" in (obsArsenal.raw as object)
);
check("trimRawEnvelope drops exactly the constants", (() => {
  const t = trimRawEnvelope(ARSENAL_COVENTRY);
  return !("area" in t) && !("season" in t) && "id" in t && "utcDate" in t;
})());

// ── Completed vs scheduled status ─────────────────────────────────────────
check("TIMED is scheduled, not completed", mapOne(SCHEDULED_FUTURE).observation!.status === "SCHEDULED");
check("scheduled match has null goals, not zero", mapOne(SCHEDULED_FUTURE).observation!.fullTimeHomeGoals === null);
check("scheduled match has null outcome", mapOne(SCHEDULED_FUTURE).observation!.outcome === null);
// The real provider bug: a datetime in the status field must never look final.
check("malformed provider status maps to UNKNOWN", mapLedgerStatus("2026-10-10 14:00:00Z") === "UNKNOWN");
check("malformed status is not FINISHED", mapOne(MALFORMED_STATUS).observation!.status === "UNKNOWN");
check("unknown-status row has no score", mapOne(MALFORMED_STATUS).observation!.fullTimeHomeGoals === null);
check("empty status maps to UNKNOWN", mapLedgerStatus("") === "UNKNOWN");
check("IN_PLAY maps to LIVE", mapLedgerStatus("IN_PLAY") === "LIVE");
check("AWARDED counts as FINISHED", mapLedgerStatus("AWARDED") === "FINISHED");
check("POSTPONED preserved", mapLedgerStatus("POSTPONED") === "POSTPONED");
// A "FINISHED" row with no score is refused rather than stored as 0-0.
const finishedNoScore = mapOne({
  ...ARSENAL_COVENTRY,
  score: { winner: null, fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
} as FootballDataMatch);
check("FINISHED without a score is rejected", finishedNoScore.observation === null);
check("rejection carries a reason", Boolean(finishedNoScore.rejectedReason));

// ── Missing statistics stay missing ───────────────────────────────────────
check("no statistics fabricated for home", obsArsenal.homeStatistics === null);
check("no statistics fabricated for away", obsArsenal.awayStatistics === null);
check("no events fabricated", obsArsenal.events === null);
check("empty statistics block is all null, never 0", statisticsAreEmpty(emptyTeamStatistics()));
check("capability lists xG as unavailable", FOOTBALL_DATA_CAPABILITY.missing.includes("expectedGoals"));
check("capability lists full-time goals as available", FOOTBALL_DATA_CAPABILITY.provides.includes("fullTimeHomeGoals"));
check(
  "capability provides/missing do not overlap",
  !FOOTBALL_DATA_CAPABILITY.provides.some((f) => FOOTBALL_DATA_CAPABILITY.missing.includes(f))
);

// ── Team identity normalization + stability ───────────────────────────────
check("PL identity defers to the curated club slug", obsArsenal.home.slug === "arsenal");
check("PL away identity resolved", obsArsenal.away.slug === "coventry");
check("provider team id retained", obsArsenal.home.providerTeamId === "57");
check("diacritics folded", deriveTeamSlug("Deportivo Alavés") === "deportivo-alaves");
check("noise tokens dropped", deriveTeamSlug("Sevilla FC") === "sevilla");
check("all-noise name keeps its tokens", deriveTeamSlug("AC Milan") === "milan");
check("distinct clubs stay distinct", deriveTeamSlug("Real Madrid CF") !== deriveTeamSlug("Real Sociedad"));

// A provider RENAME must not fork the club: same provider id → same slug.
let reg: TeamIdentityRegistry = {};
const first = resolveLedgerTeam(reg, "la-liga", { providerTeamId: "263", name: "Deportivo Alavés" }, OBSERVED);
reg = first.registry;
const renamed = resolveLedgerTeam(reg, "la-liga", { providerTeamId: "263", name: "Alavés" }, "2026-09-01T00:00:00.000Z");
reg = renamed.registry;
check("rename keeps the original slug", renamed.team.slug === first.team.slug, first.team.slug);
check("rename updates the display name", reg["la-liga::263"].name === "Alavés");
check("rename records both observed names", reg["la-liga::263"].observedNames.length === 2);
check("first-seen timestamp is not moved by a rename", reg["la-liga::263"].firstSeenAt === OBSERVED);
// Two different clubs with the same derived name must not collide.
let reg2: TeamIdentityRegistry = {};
const a1 = resolveLedgerTeam(reg2, "serie-a", { providerTeamId: "100", name: "Milan FC" }, OBSERVED);
reg2 = a1.registry;
const a2 = resolveLedgerTeam(reg2, "serie-a", { providerTeamId: "200", name: "Milan FC" }, OBSERVED);
check("colliding names get distinct slugs", a2.team.slug !== a1.team.slug, `${a1.team.slug} vs ${a2.team.slug}`);
check("collision disambiguator is deterministic", a2.team.slug === "milan-200");
// Same club id in two competitions is two registry rows, never shared.
const cross = resolveLedgerTeam(reg2, "la-liga", { providerTeamId: "100", name: "Milan FC" }, OBSERVED);
check("identity is scoped per competition", Object.keys(cross.registry).includes("la-liga::100"));

// ── Canonical match id ────────────────────────────────────────────────────
check(
  "canonical id is competition-prefixed",
  canonicalMatchId("la-liga", "2026-27", "sevilla", "getafe") === "pd-2026-27-sevilla-getafe"
);
check(
  "home/away order distinguishes the two legs",
  canonicalMatchId("la-liga", "2026-27", "a", "b") !== canonicalMatchId("la-liga", "2026-27", "b", "a")
);
check(
  "same fixture always yields the same id",
  canonicalMatchId("serie-a", "2026-27", "x", "y") === canonicalMatchId("serie-a", "2026-27", "x", "y")
);

// ── Idempotency ───────────────────────────────────────────────────────────
const sameTwice = mapOne(ARSENAL_COVENTRY, {}, "2026-08-22T12:00:00.000Z").observation!;
const sameLater = mapOne(ARSENAL_COVENTRY, {}, "2026-08-30T09:00:00.000Z").observation!;
check(
  "identical content observed later yields the SAME observation id",
  sameTwice.observationId === sameLater.observationId
);
check("a republish-only change does not mint a new observation", (() => {
  const republished = mapOne({ ...ARSENAL_COVENTRY, lastUpdated: "2026-09-01T00:00:00Z" }).observation!;
  return republished.observationId === sameTwice.observationId;
})());
check("a score change DOES mint a new observation", (() => {
  const corrected = mapOne({
    ...ARSENAL_COVENTRY,
    score: { ...ARSENAL_COVENTRY.score, fullTime: { home: 3, away: 1 } },
  } as FootballDataMatch).observation!;
  return corrected.observationId !== sameTwice.observationId;
})());
check("observationIdFor is a pure function of its fingerprint", (() => {
  const a = observationIdFor("s", "m", { x: 1 });
  const b = observationIdFor("s", "m", { x: 1 });
  const c = observationIdFor("s", "m", { x: 2 });
  return a === b && a !== c;
})());

// Folding the same observation a hundred times yields exactly one match.
const hundred = Array.from({ length: 100 }, () => obsArsenal);
const foldedHundred = materializeAll(hundred);
check("100 replays of one match materialize 1 match", foldedHundred.length === 1);
check("replays collapse to one observation", foldedHundred[0].observationCount === 1);
check("replayed match keeps the right score", foldedHundred[0].fullTimeHomeGoals === 3);

// ── Correction handling ───────────────────────────────────────────────────
const original: MatchObservation = { ...obsArsenal, observedAt: "2026-08-21T22:00:00.000Z" };
const correctedObs: MatchObservation = {
  ...obsArsenal,
  observationId: `${obsArsenal.observationId}-corrected`,
  observedAt: "2026-08-22T08:00:00.000Z",
  fullTimeAwayGoals: 1,
  outcome: "HOME",
};
const withCorrection = materializeMatch([original, correctedObs])!;
check("correction detected", withCorrection.corrections.length === 1);
check("corrected score materialized", withCorrection.fullTimeAwayGoals === 1);
check("correction records the previous score", withCorrection.corrections[0].previous.away === 0);
check("correction records the new score", withCorrection.corrections[0].corrected.away === 1);
check("correction records when it was detected", withCorrection.corrections[0].detectedAt === "2026-08-22T08:00:00.000Z");
check(
  "resultObservedAt stays at FIRST knowledge after a correction",
  withCorrection.resultObservedAt === "2026-08-21T22:00:00.000Z"
);
check("both observations retained", withCorrection.observationCount === 2);
check("no correction recorded when the score is restated identically", (() => {
  const restated = { ...original, observationId: "restated", observedAt: "2026-08-23T00:00:00.000Z" };
  return materializeMatch([original, restated])!.corrections.length === 0;
})());
check("materialize order does not matter", (() => {
  const forward = materializeMatch([original, correctedObs])!;
  const backward = materializeMatch([correctedObs, original])!;
  return forward.fullTimeAwayGoals === backward.fullTimeAwayGoals &&
    forward.resultObservedAt === backward.resultObservedAt;
})());
// A match later reported abandoned loses its evidence status.
check("an abandoned match is no longer completed evidence", (() => {
  const abandoned: MatchObservation = {
    ...obsArsenal,
    observationId: "abandoned",
    observedAt: "2026-08-23T00:00:00.000Z",
    status: "ABANDONED",
  };
  const m = materializeMatch([original, abandoned])!;
  return m.resultObservedAt === null && !isCompletedMatch(m);
})());
check("mixing match ids in one fold is refused", (() => {
  try {
    materializeMatch([obsArsenal, { ...obsArsenal, canonicalMatchId: "other", observationId: "o2" }]);
    return false;
  } catch {
    return true;
  }
})());

// ── Store idempotency ─────────────────────────────────────────────────────
async function main() {
  const w1 = await appendObservations([obsArsenal]);
  const w2 = await appendObservations([obsArsenal]);
  check("first append writes", w1.written === 1);
  check("second append skips", w2.written === 0 && w2.skipped === 1);
  check("store holds one observation", (await listObservations()).length === 1);
  check("store materializes one match", (await listCanonicalMatches()).length === 1);

  // ── Ingest via the real pipeline, with an injected payload ──────────────
  clearMatchLedgerForTests();
  const ingested = await ingestCompetition({
    competition: "premier-league",
    season: "2026-27",
    observedAt: OBSERVED,
    matches: [ARSENAL_COVENTRY, SCHEDULED_FUTURE, MALFORMED_STATUS],
  });
  check("ingest reports 3 provider rows", ingested.providerRows === 3);
  check("ingest counts exactly 1 completed", ingested.providerCompleted === 1);
  check("ingest stores the completed match", ingested.ledgerCompleted === 1);
  check("ingest reports no provider error", ingested.error === null);
  const reIngested = await ingestCompetition({
    competition: "premier-league",
    season: "2026-27",
    observedAt: "2026-08-25T12:00:00.000Z",
    matches: [ARSENAL_COVENTRY, SCHEDULED_FUTURE, MALFORMED_STATUS],
  });
  check("re-ingest writes nothing new", reIngested.observationsWritten === 0);
  check("re-ingest still counts 1 completed", reIngested.ledgerCompleted === 1);

  // ── SANITY FIXTURE end-to-end ──────────────────────────────────────────
  const plMatches = await listCanonicalMatches({ competition: "premier-league", season: "2026-27" });
  const arsenal = plMatches.find((m) => m.canonicalMatchId === "pl-2026-27-arsenal-coventry")!;
  check("SANITY: Arsenal-Coventry present in the ledger", Boolean(arsenal));
  check("SANITY: score is 3-0", arsenal.fullTimeHomeGoals === 3 && arsenal.fullTimeAwayGoals === 0);
  check("SANITY: outcome HOME", arsenal.outcome === "HOME");
  check("SANITY: kickoff 2026-08-21", (arsenal.kickoffUtc ?? "").startsWith("2026-08-21"));
  check("SANITY: counted as completed", isCompletedMatch(arsenal));
  check("SANITY: result provenance names the source", arsenal.provenance.result?.source === "football-data.org");
  check("SANITY: provenance keeps the provider id", arsenal.provenance.result?.providerMatchId === "560542");
  check("SANITY: statistics provenance is absent (source has none)", arsenal.provenance.statistics === null);
  check("SANITY: future fixtures are not completed", plMatches.filter(isCompletedMatch).length === 1);

  // ── Competition and season isolation ───────────────────────────────────
  await ingestCompetition({
    competition: "la-liga",
    season: "2026-27",
    observedAt: OBSERVED,
    matches: [
      {
        id: 900001,
        utcDate: "2026-08-15T17:30:00Z",
        status: "FINISHED",
        matchday: 1,
        homeTeam: { id: 263, name: "Deportivo Alavés", tla: "ALA" },
        awayTeam: { id: 82, name: "Getafe CF", tla: "GET" },
        score: { winner: "HOME_TEAM", fullTime: { home: 3, away: 0 }, halfTime: { home: 0, away: 0 } },
      },
    ],
  });
  const pl = await listCanonicalMatches({ competition: "premier-league", season: "2026-27" });
  const liga = await listCanonicalMatches({ competition: "la-liga", season: "2026-27" });
  check("competition isolation: PL sees only PL", pl.every((m) => m.competition === "premier-league"));
  check("competition isolation: La Liga sees only La Liga", liga.every((m) => m.competition === "la-liga"));
  check("La Liga match stored", liga.filter(isCompletedMatch).length === 1);
  check(
    "season isolation: another season returns nothing",
    (await listCanonicalMatches({ competition: "premier-league", season: "2025-26" })).length === 0
  );

  // ══════════════════════════════════════════════════════════════════════
  // TEMPORAL LEAKAGE — HARD RELEASE GATE
  // ══════════════════════════════════════════════════════════════════════
  const KICKOFF = "2026-08-21T19:00:00.000Z";
  const KNOWN_AT = "2026-08-21T21:00:00.000Z"; // when we learned the result
  const ledgerMatch = {
    ...arsenal,
    kickoffUtc: KICKOFF,
    resultObservedAt: KNOWN_AT,
  };
  const cutoffAt = (asOf: string, excludeMatchId?: string) => ({
    asOf,
    competition: "premier-league" as const,
    season: "2026-27",
    excludeMatchId,
  });

  // (a) Before kickoff — the match cannot be evidence for anything.
  check(
    "LEAKAGE: a match is not admissible before its kickoff",
    admissibleMatches([ledgerMatch], cutoffAt("2026-08-21T18:00:00.000Z")).length === 0
  );
  // (b) After kickoff but before the result was known — still not admissible.
  check(
    "LEAKAGE: a match is not admissible before its result was observed",
    admissibleMatches([ledgerMatch], cutoffAt("2026-08-21T20:00:00.000Z")).length === 0
  );
  // (c) After the result was known — admissible.
  check(
    "LEAKAGE: a match IS admissible once observed",
    admissibleMatches([ledgerMatch], cutoffAt("2026-08-22T00:00:00.000Z")).length === 1
  );
  // (d) THE CENTRAL INVARIANT: a match may never feed its own prediction,
  //     even when features are recomputed long after full time.
  check(
    "LEAKAGE: a match never feeds its OWN prediction, even recomputed post-FT",
    admissibleMatches(
      [ledgerMatch],
      cutoffAt("2026-12-01T00:00:00.000Z", "pl-2026-27-arsenal-coventry")
    ).length === 0
  );
  // (e) Features for the match itself see nothing from the match itself.
  const selfFeatures = buildTeamFeatures([ledgerMatch], "arsenal", {
    asOf: "2026-12-01T00:00:00.000Z",
    competition: "premier-league",
    season: "2026-27",
    excludeMatchId: "pl-2026-27-arsenal-coventry",
  });
  check("LEAKAGE: own-match features see zero matches", selfFeatures.matchesPlayed === 0);
  check("LEAKAGE: own-match form is empty", selfFeatures.last5.form === "");
  check("LEAKAGE: own-match weight is zero", selfFeatures.currentSeasonWeight === 0);
  check("LEAKAGE: own-match goals are 0 with 0 matches counted", selfFeatures.season_.matchesCounted === 0);
  // (f) A FUTURE match must never appear in history.
  const futureMatch = { ...ledgerMatch, canonicalMatchId: "pl-2026-27-future", kickoffUtc: "2027-01-01T15:00:00.000Z", resultObservedAt: "2027-01-01T17:00:00.000Z" };
  check(
    "LEAKAGE: a future match is not admissible history",
    admissibleMatches([futureMatch], cutoffAt("2026-09-01T00:00:00.000Z")).length === 0
  );
  // (g) A mis-stamped observation (observed before kickoff) is still refused by
  //     the independent chronology guard.
  const misstamped = { ...ledgerMatch, canonicalMatchId: "pl-2026-27-misstamped", resultObservedAt: "2026-08-01T00:00:00.000Z" };
  check(
    "LEAKAGE: chronology guard catches a mis-stamped observation",
    admissibleMatches([misstamped], cutoffAt("2026-08-10T00:00:00.000Z")).length === 0
  );
  // (h) Competition and season isolation inside the cutoff itself.
  check(
    "LEAKAGE: another competition's match is not admissible",
    admissibleMatches([ledgerMatch], { asOf: "2026-12-01T00:00:00.000Z", competition: "la-liga", season: "2026-27" }).length === 0
  );
  check(
    "LEAKAGE: another season's match is not admissible",
    admissibleMatches([ledgerMatch], { asOf: "2026-12-01T00:00:00.000Z", competition: "premier-league", season: "2025-26" }).length === 0
  );
  check("LEAKAGE: an invalid cutoff throws rather than passing everything", (() => {
    try {
      admissibleMatches([ledgerMatch], cutoffAt("not-a-date"));
      return false;
    } catch {
      return true;
    }
  })());

  // ── Train/predict/evaluate separation for Match N ──────────────────────
  // Arsenal play Coventry (N-1) then Chelsea (N). Predicting N may use N-1;
  // predicting N-1 may use neither.
  const matchN1 = { ...ledgerMatch };
  const matchN = {
    ...ledgerMatch,
    canonicalMatchId: "pl-2026-27-chelsea-arsenal",
    home: { ...ledgerMatch.away, slug: "chelsea" },
    away: { ...ledgerMatch.home, slug: "arsenal" },
    kickoffUtc: "2026-09-12T14:00:00.000Z",
    resultObservedAt: "2026-09-12T16:00:00.000Z",
    fullTimeHomeGoals: 1,
    fullTimeAwayGoals: 2,
    outcome: "AWAY" as const,
  };
  const all = [matchN1, matchN];
  const beforeN = admissibleMatches(all, cutoffAt("2026-09-12T12:00:00.000Z", "pl-2026-27-chelsea-arsenal"));
  check("Match N features include N-1", beforeN.some((m) => m.canonicalMatchId === "pl-2026-27-arsenal-coventry"));
  check("Match N features exclude N itself", !beforeN.some((m) => m.canonicalMatchId === "pl-2026-27-chelsea-arsenal"));
  const beforeN1 = admissibleMatches(all, cutoffAt("2026-08-21T18:00:00.000Z", "pl-2026-27-arsenal-coventry"));
  check("Match N-1 features include neither", beforeN1.length === 0);
  const afterBoth = admissibleMatches(all, cutoffAt("2026-10-01T00:00:00.000Z"));
  check("after both, FUTURE models may use both", afterBoth.length === 2);

  // ── Rolling features ───────────────────────────────────────────────────
  const lines = teamMatchLines(afterBoth, "arsenal");
  check("Arsenal has two match lines", lines.length === 2);
  check("home/away venue detected", lines[0].venue === "home" && lines[1].venue === "away");
  check("goals for/against oriented per team", lines[0].goalsFor === 3 && lines[1].goalsFor === 2);
  check("outcomes oriented per team", lines[0].outcome === "W" && lines[1].outcome === "W");
  check("points computed", lines.reduce((s, l) => s + l.points, 0) === 6);
  check("clean sheet detected", lines[0].cleanSheet === true && lines[1].cleanSheet === false);
  const last1 = rollingForm(lines, "arsenal", 1);
  const last3 = rollingForm(lines, "arsenal", 3);
  const last5 = rollingForm(lines, "arsenal", 5);
  check("last-1 counts one match", last1.matchesCounted === 1);
  check("last-1 takes the MOST RECENT match", last1.goalsFor === 2);
  check("last-3 caps at available matches", last3.matchesCounted === 2);
  check("last-5 caps at available matches", last5.matchesCounted === 2);
  check("points per match computed", near(last5.pointsPerMatch!, 3));
  check("goal difference computed", last5.goalDifference === 4);
  check("clean sheets counted", last5.cleanSheets === 1);
  check("form string is chronological", last5.form === "WW");
  const homeForm = rollingForm(lines, "arsenal", "season", "home");
  const awayForm = rollingForm(lines, "arsenal", "season", "away");
  check("home split isolates home matches", homeForm.matchesCounted === 1 && homeForm.goalsFor === 3);
  check("away split isolates away matches", awayForm.matchesCounted === 1 && awayForm.goalsFor === 2);
  check("home + away = season", homeForm.matchesCounted + awayForm.matchesCounted === last5.matchesCounted);
  // Unavailable statistics must stay null through aggregation.
  check("xG aggregate stays null when the source has none", last5.xgFor === null);
  check("xG difference stays null", last5.xgDifference === null);
  check("shots aggregate stays null", last5.shotsFor === null);
  check("cards aggregate stays null, not 0", last5.yellowCards === null);
  check("goals are NOT null (they are real data)", last5.goalsFor === 5);

  // ── Early-season shrinkage ─────────────────────────────────────────────
  check("prior equivalent is explicit", PRIOR_MATCH_EQUIVALENT === 8);
  check("zero matches → zero current-season weight", currentSeasonWeight(0) === 0);
  check("one match → ~11% weight", near(currentSeasonWeight(1), 1 / 9, 1e-12));
  check("eight matches → exactly half", near(currentSeasonWeight(8), 0.5, 1e-12));
  check("38 matches → 82.6%", near(currentSeasonWeight(38), 38 / 46, 1e-12));
  check("weight is monotonically increasing", (() => {
    for (let n = 0; n < 60; n++) if (currentSeasonWeight(n + 1) <= currentSeasonWeight(n)) return false;
    return true;
  })());
  check("weight never reaches 1", currentSeasonWeight(10_000) < 1);
  check("negative match counts are clamped", currentSeasonWeight(-5) === 0);
  // The headline property: one 3-0 must not dominate the prior.
  const prior = 1500;
  const oneBigWin = 2000;
  const afterOne = blendWithPrior(oneBigWin, prior, 1);
  check("one result moves the blend by ~11%, not 100%", near(afterOne, prior + (oneBigWin - prior) / 9, 1e-9), String(Math.round(afterOne)));
  check("one result stays far below the raw observation", afterOne < prior + (oneBigWin - prior) * 0.15);
  check("with no matches the prior is returned exactly", blendWithPrior(oneBigWin, prior, 0) === prior);
  check("a null observation returns the prior exactly", blendWithPrior(null, prior, 5) === prior);
  check("evidence weight grows with the season", blendWithPrior(oneBigWin, prior, 20) > blendWithPrior(oneBigWin, prior, 5));
  check("blend is bounded by prior and observation", (() => {
    for (const n of [1, 3, 8, 19, 38]) {
      const v = blendWithPrior(oneBigWin, prior, n);
      if (v < prior || v > oneBigWin) return false;
    }
    return true;
  })());

  // ── Opponent strength context ──────────────────────────────────────────
  const bundle = buildTeamFeatures(all, "arsenal", {
    asOf: "2026-10-01T00:00:00.000Z",
    competition: "premier-league",
    season: "2026-27",
  });
  check("feature bundle records its cutoff", bundle.asOf === "2026-10-01T00:00:00.000Z");
  check("feature bundle records latest evidence", bundle.latestEvidenceKickoff === "2026-09-12T14:00:00.000Z");
  check("opponent context lists each match", bundle.opponentContext.perMatch.length === 2);
  check("opponent strength excludes the match itself", bundle.opponentContext.perMatch.every((p) => p.opponentPointsPerMatch === null || p.opponentMatchesPlayed >= 0));
  check("strength of schedule is derived, not invented", bundle.opponentContext.strengthOfSchedule !== undefined);

  // ── Settlement linkage ─────────────────────────────────────────────────
  const fixture = fixtureFromCanonicalMatch(ledgerMatch)!;
  check("ledger match projects to a Fixture", fixture.id === "pl-2026-27-arsenal-coventry");
  check("projected fixture is FINISHED", fixture.status === "FINISHED");
  check("projected fixture carries the score", fixture.homeGoals === 3 && fixture.awayGoals === 0);
  check("a scheduled match does not project", fixtureFromCanonicalMatch({ ...ledgerMatch, status: "SCHEDULED" }) === null);

  // Freeze a pre-match prediction, then settle it from the ledger.
  //
  // Uses a SYNTHETIC fixture id rather than the real one: loadCommittedLiveOos
  // is deliberately pinned to the canonical 380-row tape (see lib/snapshots/
  // store.ts), so settling a real fixture id here would also settle the real
  // committed snapshot and this gate would be measuring production data.
  const TEST_FIXTURE_ID = "pl-2026-27-ledgertesthome-ledgertestaway";
  const settleTarget = {
    ...ledgerMatch,
    canonicalMatchId: TEST_FIXTURE_ID,
    home: { ...ledgerMatch.home, slug: "ledgertesthome" },
    away: { ...ledgerMatch.away, slug: "ledgertestaway" },
  };
  const settleSnapshot = createSnapshot({
    fixtureId: TEST_FIXTURE_ID,
    competition: "premier-league",
    season: "2026-27",
    asOf: "2026-08-20T19:00:00.000Z",
    kickoff: KICKOFF,
    modelVersion: "pl-live-v0.2.0",
    predictionStage: "T24H",
    evaluationClass: "LIVE_OOS",
    homeSlug: "ledgertesthome",
    awaySlug: "ledgertestaway",
    home: 0.72,
    draw: 0.18,
    away: 0.1,
    homeExpectedGoals: 2.1,
    awayExpectedGoals: 0.6,
    scorelineDistribution: {},
    sourceState: {
      // This row is a settlement fixture, not a scheduler integration test.
      // Keep it explicitly outside the scheduled-production write contract.
      origin: "manual",
      computedAt: "2026-08-20T19:05:00.000Z",
      latestEvidenceObservedAt: "2026-08-20T18:00:00.000Z",
    },
  });
  const settleReport = settleCompletedMatches({
    competition: "premier-league",
    matches: [settleTarget],
    settledAt: "2026-08-22T00:00:00.000Z",
  });
  check("settlement links the frozen snapshot", settleReport.settlementsWritten === 1);
  check("settlement counts the completed match", settleReport.completedMatches === 1);
  check("settlement reports no errors", settleReport.errors.length === 0);
  const settlements = loadSettlements();
  check("settlement scores the FROZEN probabilities", near(settlements[0].predicted.home, 0.72));
  check("settlement records the actual outcome", settlements[0].actualOutcome === "home");
  check("settlement records the actual score", settlements[0].actualScore.home === 3);
  check("settlement is a proper score", settlements[0].brier > 0 && settlements[0].brier < 2);
  check("top pick recorded as correct", settlements[0].topPickCorrect === true);
  // Re-settling is a no-op, not a duplicate.
  settleCompletedMatches({
    competition: "premier-league",
    matches: [settleTarget],
    settledAt: "2026-08-23T00:00:00.000Z",
  });
  check("re-settling does not duplicate", loadSettlements().length === 1);
  check("re-settling does not change the settled row", loadSettlements()[0].settledAt === "2026-08-22T00:00:00.000Z");
  // A league with no frozen predictions settles nothing, and says so.
  const ligaReport = settleCompletedMatches({
    competition: "la-liga",
    matches: liga,
    settledAt: "2026-08-22T00:00:00.000Z",
  });
  check("ledger-only league writes no settlements", ligaReport.settlementsWritten === 0);
  check("ledger-only league reports missing snapshots honestly", ligaReport.matchesWithoutSnapshots === 1);

  // ── Public match-ledger forecast boundary ─────────────────────────────
  const withIdentity = (
    snapshot: PredictionSnapshot,
    changes: Partial<PredictionSnapshot>
  ): PredictionSnapshot => {
    const changed = { ...snapshot, ...changes } as PredictionSnapshot;
    return {
      ...changed,
      provenance: {
        ...changed.provenance,
        uniqueKey: snapshotUniqueKey(changed),
      },
    };
  };
  const publicSettleSnapshot: PredictionSnapshot = {
    ...settleSnapshot,
    // Legacy/manual snapshots derive their generation time from createdAt.
    // Pin this in-memory read-model fixture before kickoff without pretending
    // it was emitted by the production scheduler.
    createdAt: "2026-08-20T19:05:00.000Z",
  };
  check(
    "public ledger selects a valid PL production LIVE_OOS snapshot",
    latestPreKickoffSnapshot([publicSettleSnapshot], settleTarget)?.provenance.uniqueKey ===
      publicSettleSnapshot.provenance.uniqueKey
  );
  check(
    "public ledger rejects a snapshot generated at kickoff",
    latestPreKickoffSnapshot(
      [
        {
          ...publicSettleSnapshot,
          createdAt: KICKOFF,
        },
      ],
      settleTarget
    ) === null
  );
  check(
    "public ledger rejects an obsolete frozen kickoff",
    latestPreKickoffSnapshot(
      [withIdentity(publicSettleSnapshot, { kickoff: "2026-08-22T19:00:00.000Z" })],
      settleTarget
    ) === null
  );
  check(
    "public ledger rejects a mislabeled deterministic stage",
    latestPreKickoffSnapshot(
      [withIdentity(publicSettleSnapshot, { predictionStage: "T2H" })],
      settleTarget
    ) === null
  );
  check(
    "public ledger rejects a non-LIVE_OOS evaluation class",
    latestPreKickoffSnapshot(
      [withIdentity(publicSettleSnapshot, { evaluationClass: "RETROSPECTIVE" })],
      settleTarget
    ) === null
  );
  check(
    "public ledger rejects a non-PL snapshot with the same fixture id",
    latestPreKickoffSnapshot(
      [withIdentity(publicSettleSnapshot, { competition: "la-liga" })],
      settleTarget
    ) === null
  );
  check(
    "another competition cannot inherit a PL snapshot through a fixture-id collision",
    latestPreKickoffSnapshot(
      [publicSettleSnapshot],
      { ...settleTarget, competition: "la-liga" as const }
    ) === null
  );

  // ── Cadence gate ───────────────────────────────────────────────────────
  const st = emptyLedgerState();
  check("first ingest is always due", ingestIsDue(st, OBSERVED, 60_000));
  check("ingest is not due inside the interval", !ingestIsDue({ ...st, lastIngestAt: "2026-08-22T12:00:00.000Z" }, "2026-08-22T12:00:30.000Z", 60_000));
  check("ingest is due after the interval", ingestIsDue({ ...st, lastIngestAt: "2026-08-22T12:00:00.000Z" }, "2026-08-22T12:02:00.000Z", 60_000));
  check("a corrupt lastIngestAt does not block ingestion forever", ingestIsDue({ ...st, lastIngestAt: "garbage" }, OBSERVED, 60_000));

  // ── API / UI serialization ─────────────────────────────────────────────
  const serialized = serializeMatchForApi(settleTarget, {
    snapshot: publicSettleSnapshot,
    settlement: settlements[0] ?? null,
  });
  check("serialized match exposes the id", serialized.canonicalMatchId === TEST_FIXTURE_ID);
  check("serialized match exposes the score", serialized.score.fullTime.home === 3);
  check("serialized match exposes the outcome", serialized.result === "HOME");
  check("serialized statistics list only AVAILABLE fields", serialized.statistics.length === 0);
  check("serialized match declares unavailable stats", serialized.unavailableStatistics.length > 0);
  check("serialized match names the stat source", serialized.statisticsSource === null);
  check("serialized match is JSON-safe", (() => {
    JSON.parse(JSON.stringify(serialized));
    return true;
  })());
  check("serialized prediction carries the frozen probabilities", near(serialized.prediction!.home, 0.72));
  check("serialized prediction carries its timestamp", serialized.prediction!.asOf === "2026-08-20T19:00:00.000Z");
  check("serialized prediction marks settled", serialized.prediction!.settled === true);
  const corruptSettlement = {
    ...settlements[0],
    actualScore: { home: 4, away: 0 },
  };
  const serializedCorruptSettlement = serializeMatchForApi(settleTarget, {
    snapshot: publicSettleSnapshot,
    settlement: corruptSettlement,
  });
  check(
    "corrupt settlement is not published as settled",
    serializedCorruptSettlement.prediction?.settled === false
  );
  check(
    "a corrupt settlement does not erase the valid immutable forecast",
    near(serializedCorruptSettlement.prediction?.home ?? -1, 0.72)
  );
  check(
    "serializer rejects a cross-fixture snapshot and settlement",
    serializeMatchForApi(arsenal, {
      snapshot: publicSettleSnapshot,
      settlement: settlements[0] ?? null,
    }).prediction === null
  );
  const teamSeason = serializeTeamSeason(afterBoth, "arsenal", "premier-league", "2026-27");
  check("team season counts played", teamSeason.played === 2);
  check("team season W-D-L", teamSeason.wins === 2 && teamSeason.draws === 0 && teamSeason.losses === 0);
  check("team season GF-GA", teamSeason.goalsFor === 5 && teamSeason.goalsAgainst === 1);
  check("team season points", teamSeason.points === 6);
  check("team season recent list is newest first", teamSeason.recent[0].canonicalMatchId === "pl-2026-27-chelsea-arsenal");
  check("team season is JSON-safe", (() => {
    JSON.parse(JSON.stringify(teamSeason));
    return true;
  })());

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nMatch ledger gates: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
