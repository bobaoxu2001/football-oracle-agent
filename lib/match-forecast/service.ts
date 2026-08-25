import type { Fixture } from "@/lib/identity/types";
import { getClub } from "@/lib/competitions/premier-league/clubs";
import { liveFixtures } from "@/lib/competitions/premier-league/fixture-store";
import { listLiveSnapshots } from "@/lib/competitions/premier-league/ops/live-snapshot-reader";
import { hydrateDurableOps } from "@/lib/competitions/premier-league/ops/durable-store";
import { productionModelVersion } from "@/lib/competitions/premier-league/shadow/track";
import { getTeamNews } from "@/lib/news/teamNewsStore";
import type { TeamNewsItem } from "@/lib/news/types";
import type { PredictionSnapshot } from "@/lib/snapshots/types";
import { assertForecastInvariants, deriveForecastMath, scoreMatrixFromSnapshot } from "./derive";
import type {
  ForecastComparison,
  ForecastTimelinePoint,
  MatchForecast,
  MatchIntelligence,
  ForecastFreshness,
  UpcomingMatchForecast,
} from "./types";

export class MatchForecastError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_MATCH" | "NO_PRODUCTION_FORECAST" | "FORECAST_INTEGRITY",
    public readonly status: number
  ) {
    super(message);
  }
}

export function resolvePremierLeagueFixture(matchId: string): Fixture {
  const fixture = liveFixtures().find((candidate) => candidate.id === matchId);
  if (!fixture) {
    throw new MatchForecastError(`Unknown Premier League match: ${matchId}.`, "UNKNOWN_MATCH", 404);
  }
  if (!fixture.kickoffUtc) {
    throw new MatchForecastError(`Match ${matchId} has no auditable kickoff timestamp.`, "NO_PRODUCTION_FORECAST", 409);
  }
  return fixture;
}

export function isProductionForecastSnapshot(snapshot: PredictionSnapshot): boolean {
  return (
    snapshot.competition === "premier-league" &&
    snapshot.evaluationClass === "LIVE_OOS" &&
    snapshot.modelVersion === productionModelVersion()
  );
}

export function productionSnapshotsForMatch(
  matchId: string,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: matchId })
): PredictionSnapshot[] {
  return snapshots
    .filter((snapshot) => snapshot.fixtureId === matchId && isProductionForecastSnapshot(snapshot))
    .sort(
      (a, b) =>
        a.asOf.localeCompare(b.asOf) ||
        snapshotGeneratedAt(a).localeCompare(snapshotGeneratedAt(b)) ||
        a.provenance.uniqueKey.localeCompare(b.provenance.uniqueKey)
    );
}

function snapshotGeneratedAt(snapshot: PredictionSnapshot): string {
  const computedAt = snapshot.sourceState?.computedAt;
  const origin = snapshot.sourceState?.origin;
  return origin === "scheduled" && typeof computedAt === "string"
    ? computedAt
    : snapshot.createdAt;
}

function snapshotIsValidBeforeKickoff(
  snapshot: PredictionSnapshot,
  kickoffMs: number
): boolean {
  const cutoffMs = Date.parse(snapshot.asOf);
  const generatedMs = Date.parse(snapshotGeneratedAt(snapshot));
  return (
    Number.isFinite(cutoffMs) &&
    Number.isFinite(generatedMs) &&
    Number.isFinite(kickoffMs) &&
    cutoffMs < kickoffMs &&
    generatedMs < kickoffMs
  );
}

function snapshotMatchesKickoff(snapshot: PredictionSnapshot, kickoffMs: number): boolean {
  if (!snapshot.kickoff) return true;
  const frozenKickoffMs = Date.parse(snapshot.kickoff);
  return Number.isFinite(frozenKickoffMs) && frozenKickoffMs === kickoffMs;
}

export function selectProductionSnapshot(
  fixture: Fixture,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: fixture.id })
): PredictionSnapshot {
  const kickoffMs = Date.parse(fixture.kickoffUtc ?? "");
  const eligible = productionSnapshotsForMatch(fixture.id, snapshots).filter(
    (snapshot) =>
      snapshotIsValidBeforeKickoff(snapshot, kickoffMs) &&
      snapshotMatchesKickoff(snapshot, kickoffMs)
  );
  const selected = eligible[eligible.length - 1];
  if (!selected) {
    throw new MatchForecastError(
      `No immutable production forecast exists before kickoff for ${fixture.id}.`,
      "NO_PRODUCTION_FORECAST",
      404
    );
  }
  return selected;
}

function trainingWindow(snapshot: PredictionSnapshot): { from: string; to: string } | null {
  const value = snapshot.modelParameters?.trainingWindow;
  if (!value || typeof value !== "object") return null;
  const from = (value as { from?: unknown }).from;
  const to = (value as { to?: unknown }).to;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

function sourceStateForApi(snapshot: PredictionSnapshot): Record<string, unknown> {
  const source = snapshot.sourceState ?? {};
  const allow = [
    "eloHome",
    "eloAway",
    "fixturesUsed",
    "ratingStateAsOf",
    "computedAt",
    "ratingEventsUsed",
    "ratingEventIds",
    "latestRatingEventAppliedAt",
    "kickoffCertaintyAtFreeze",
    "fixtureRetrievedAt",
    "fixtureDataVersion",
    "seasonInitVersion",
    "origin",
    "featureCutoff",
    "evidenceMatchIdsHome",
    "evidenceMatchIdsAway",
    "latestEvidenceKickoff",
  ];
  return Object.fromEntries(
    allow
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, source[key]])
  );
}

export function buildMatchForecast(
  fixture: Fixture,
  snapshot: PredictionSnapshot
): MatchForecast {
  if (!isProductionForecastSnapshot(snapshot)) {
    throw new MatchForecastError(
      `Refusing non-production forecast ${snapshot.modelVersion}.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  if (snapshot.fixtureId !== fixture.id) {
    throw new MatchForecastError(
      `Forecast ${snapshot.provenance.uniqueKey} belongs to another match.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  if (Date.parse(snapshot.asOf) >= Date.parse(fixture.kickoffUtc ?? "")) {
    throw new MatchForecastError(
      `Forecast cutoff ${snapshot.asOf} is not before kickoff.`,
      "FORECAST_INTEGRITY",
      409
    );
  }
  const generatedAt = snapshotGeneratedAt(snapshot);
  const generatedAtMs = Date.parse(generatedAt);
  const kickoffMs = Date.parse(fixture.kickoffUtc ?? "");
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(kickoffMs) || generatedAtMs >= kickoffMs) {
    throw new MatchForecastError(
      `Forecast generation ${generatedAt} is not before kickoff.`,
      "FORECAST_INTEGRITY",
      409
    );
  }

  const { matrix, artifact } = scoreMatrixFromSnapshot(snapshot);
  const math = deriveForecastMath(matrix);
  const storedResult = [snapshot.homeProbability, snapshot.drawProbability, snapshot.awayProbability];
  const derivedResult = [math.result.homeWin, math.result.draw, math.result.awayWin];
  if (storedResult.some((probability, index) => Math.abs(probability - derivedResult[index]) > 1e-8)) {
    throw new MatchForecastError(
      `Frozen 1X2 disagrees with the canonical score distribution for ${snapshot.provenance.uniqueKey}.`,
      "FORECAST_INTEGRITY",
      409
    );
  }

  const safeSourceState = sourceStateForApi(snapshot);
  const ratingStateAsOf =
    typeof safeSourceState.ratingStateAsOf === "string"
      ? safeSourceState.ratingStateAsOf
      : snapshot.asOf;
  const forecast: MatchForecast = {
    matchId: fixture.id,
    competition: "premier-league",
    season: fixture.season,
    home: { slug: fixture.homeSlug, name: getClub(fixture.homeSlug).name },
    away: { slug: fixture.awaySlug, name: getClub(fixture.awaySlug).name },
    kickoffUtc: fixture.kickoffUtc as string,
    generatedAt,
    cutoffAt: snapshot.asOf,
    modelVersion: snapshot.modelVersion,
    modelRole: "production",
    expectedGoals: {
      home: snapshot.homeGoalExpectation,
      away: snapshot.awayGoalExpectation,
      total: snapshot.homeGoalExpectation + snapshot.awayGoalExpectation,
    },
    ...math,
    scoreMatrix: matrix,
    provenance: {
      modelVersion: snapshot.modelVersion,
      modelRole: "production",
      generatedAt,
      cutoffAt: snapshot.asOf,
      competition: "premier-league",
      season: snapshot.season,
      predictionStage: snapshot.predictionStage,
      evaluationClass: "LIVE_OOS",
      trainingWindow: trainingWindow(snapshot),
      inputsUsed: [
        "walk-forward Premier League Elo ratings available at cutoff",
        "frozen true-home-advantage parameter",
        "frozen Dixon-Coles rho",
        "frozen goal-expectation mapping",
      ],
      inputSnapshots: safeSourceState,
      dataFreshness: {
        fixtureRetrievedAt:
          typeof safeSourceState.fixtureRetrievedAt === "string"
            ? safeSourceState.fixtureRetrievedAt
            : fixture.retrievedAt && Date.parse(fixture.retrievedAt) <= Date.parse(snapshot.asOf)
              ? fixture.retrievedAt
              : null,
        ratingStateAsOf,
        latestInputAt: snapshot.asOf,
      },
      immutableForecastId: snapshot.provenance.uniqueKey,
      scoreDistributionArtifact: artifact,
      reconstructionNote:
        artifact === "reconstructed-from-frozen-lambdas-and-rho"
          ? "Legacy immutable snapshots stored only the top scorelines. The complete normalized 9x9 matrix is deterministically reconstructed from the snapshot's frozen home/away goal expectations and frozen Dixon-Coles rho; the historical snapshot is not modified."
          : null,
    },
  };
  assertForecastInvariants(forecast);
  return forecast;
}

export async function latestMatchForecast(matchId: string): Promise<MatchForecast> {
  await hydrateDurableOps();
  const fixture = resolvePremierLeagueFixture(matchId);
  return buildMatchForecast(fixture, selectProductionSnapshot(fixture));
}

export function forecastFreshness(cutoffAt: string, now = new Date()): ForecastFreshness {
  const ageHours = Math.max(0, (now.getTime() - Date.parse(cutoffAt)) / 3_600_000);
  const rounded = Math.round(ageHours * 10) / 10;
  return ageHours > 72
    ? {
        status: "stale",
        ageHours: rounded,
        note: `Forecast inputs were frozen ${Math.round(ageHours / 24)} days ago; newer information may not be reflected.`,
      }
    : {
        status: "fresh",
        ageHours: rounded,
        note: "Forecast inputs were frozen within the last 72 hours.",
      };
}

export function upcomingMatchForecasts(limit = 6, now = new Date()): UpcomingMatchForecast[] {
  const nowMs = now.getTime();
  const fixtures = liveFixtures()
    .filter((fixture) => {
      const kickoff = Date.parse(fixture.kickoffUtc ?? "");
      return fixture.status !== "FINISHED" && Number.isFinite(kickoff) && kickoff > nowMs;
    })
    .sort((a, b) => Date.parse(a.kickoffUtc ?? "") - Date.parse(b.kickoffUtc ?? ""));
  const cards: UpcomingMatchForecast[] = [];
  for (const fixture of fixtures) {
    try {
      const forecast = buildMatchForecast(fixture, selectProductionSnapshot(fixture));
      cards.push({
        match: {
          id: fixture.id,
          competition: "premier-league",
          season: fixture.season,
          home: forecast.home,
          away: forecast.away,
          kickoffUtc: fixture.kickoffUtc as string,
          status: fixture.status,
        },
        forecast,
        freshness: forecastFreshness(forecast.cutoffAt, now),
      });
      if (cards.length >= limit) break;
    } catch (error) {
      if (!(error instanceof MatchForecastError)) throw error;
    }
  }
  return cards;
}

export function forecastTimeline(
  fixture: Fixture,
  snapshots: PredictionSnapshot[] = listLiveSnapshots({ fixtureId: fixture.id })
): ForecastTimelinePoint[] {
  return timelineSnapshotRows(fixture, snapshots).map(({ snapshot, fixtureAtFreeze, validForCurrentKickoff }) => {
      const forecast = buildMatchForecast(fixtureAtFreeze, snapshot);
      return {
        forecastId: forecast.provenance.immutableForecastId,
        cutoffAt: forecast.cutoffAt,
        generatedAt: forecast.generatedAt,
        kickoffAtFreeze: snapshot.kickoff,
        validForCurrentKickoff,
        predictionStage: forecast.provenance.predictionStage,
        modelVersion: forecast.modelVersion,
        result: forecast.result,
        over25: forecast.totals.over25,
        bttsYes: forecast.btts.yes,
        expectedGoalsTotal: forecast.expectedGoals.total,
      };
    });
}

function timelineSnapshotRows(
  fixture: Fixture,
  snapshots: PredictionSnapshot[]
): Array<{
  snapshot: PredictionSnapshot;
  fixtureAtFreeze: Fixture;
  validForCurrentKickoff: boolean;
}> {
  const currentKickoffMs = Date.parse(fixture.kickoffUtc ?? fixture.kickoff ?? "");
  return productionSnapshotsForMatch(fixture.id, snapshots)
    .map((snapshot) => {
      const kickoffAtFreeze = snapshot.kickoff ?? fixture.kickoffUtc ?? fixture.kickoff ?? null;
      const kickoffAtFreezeMs = Date.parse(kickoffAtFreeze ?? "");
      return {
        snapshot,
        fixtureAtFreeze: kickoffAtFreeze
          ? { ...fixture, kickoff: kickoffAtFreeze, kickoffUtc: kickoffAtFreeze }
          : fixture,
        validForCurrentKickoff: snapshotMatchesKickoff(snapshot, currentKickoffMs),
        kickoffAtFreezeMs,
      };
    })
    .filter(({ snapshot, kickoffAtFreezeMs }) =>
      snapshotIsValidBeforeKickoff(snapshot, kickoffAtFreezeMs)
    )
    .map(({ snapshot, fixtureAtFreeze, validForCurrentKickoff }) => ({
      snapshot,
      fixtureAtFreeze,
      validForCurrentKickoff,
    }));
}

function shallowInputDiff(
  oldInputs: Record<string, unknown>,
  newInputs: Record<string, unknown>
): ForecastComparison["inputChanges"] {
  const keys = new Set([...Object.keys(oldInputs), ...Object.keys(newInputs)]);
  const changes: ForecastComparison["inputChanges"] = [];
  for (const key of [...keys].sort()) {
    const before = oldInputs[key];
    const after = newInputs[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ key, before, after });
  }
  return changes;
}

export function compareForecastSnapshots(
  oldForecast: MatchForecast,
  newForecast: MatchForecast
): ForecastComparison {
  if (oldForecast.matchId !== newForecast.matchId) {
    throw new Error("Forecast comparison requires the same match.");
  }
  return {
    oldForecastId: oldForecast.provenance.immutableForecastId,
    newForecastId: newForecast.provenance.immutableForecastId,
    fromCutoff: oldForecast.cutoffAt,
    toCutoff: newForecast.cutoffAt,
    probabilityChanges: {
      homeWin: newForecast.result.homeWin - oldForecast.result.homeWin,
      draw: newForecast.result.draw - oldForecast.result.draw,
      awayWin: newForecast.result.awayWin - oldForecast.result.awayWin,
      over25: newForecast.totals.over25 - oldForecast.totals.over25,
      bttsYes: newForecast.btts.yes - oldForecast.btts.yes,
    },
    expectedGoalsChanges: {
      home: newForecast.expectedGoals.home - oldForecast.expectedGoals.home,
      away: newForecast.expectedGoals.away - oldForecast.expectedGoals.away,
      total: newForecast.expectedGoals.total - oldForecast.expectedGoals.total,
    },
    inputChanges: shallowInputDiff(
      oldForecast.provenance.inputSnapshots,
      newForecast.provenance.inputSnapshots
    ),
    causalAttribution: "not-established",
    causalNote:
      "The changed inputs preceded the newer frozen forecast. This comparison does not establish that any one input caused the full probability move.",
  };
}

export function isAvailableAtCutoff(value: Date | string, cutoffAt: string): boolean {
  const availableMs = Date.parse(value instanceof Date ? value.toISOString() : value);
  const cutoffMs = Date.parse(cutoffAt);
  return Number.isFinite(availableMs) && Number.isFinite(cutoffMs) && availableMs <= cutoffMs;
}

function approvedNewsAtCutoff(items: TeamNewsItem[], cutoffAt: string): TeamNewsItem[] {
  return items.filter(
    (item) => !item.demo && isAvailableAtCutoff(item.publishedAt, cutoffAt)
  );
}

async function contextNews(
  fixture: Fixture,
  cutoffAt: string
): Promise<MatchIntelligence["context"]["news"]> {
  const [home, away] = await Promise.all([
    getTeamNews(fixture.homeSlug, 12),
    getTeamNews(fixture.awaySlug, 12),
  ]);
  return approvedNewsAtCutoff([...home.items, ...away.items], cutoffAt)
    .sort((a, b) => Date.parse(String(b.publishedAt)) - Date.parse(String(a.publishedAt)))
    .slice(0, 12)
    .map((item) => ({
      team: item.team,
      title: item.title,
      summary: item.summary,
      category: item.category,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      availableAt: new Date(item.publishedAt).toISOString(),
      usedInForecast: false as const,
    }));
}

export async function getMatchIntelligence(matchId: string, now = new Date()): Promise<MatchIntelligence> {
  await hydrateDurableOps();
  const fixture = resolvePremierLeagueFixture(matchId);
  const snapshots = listLiveSnapshots({ fixtureId: fixture.id });
  const selected = selectProductionSnapshot(fixture, snapshots);
  const forecast = buildMatchForecast(fixture, selected);
  const timelineRows = timelineSnapshotRows(fixture, snapshots);
  const timeline = forecastTimeline(fixture, snapshots);
  const selectedIndex = timelineRows.findIndex(
    ({ snapshot }) => snapshot.provenance.uniqueKey === selected.provenance.uniqueKey
  );
  const previousRow = selectedIndex > 0
    ? timelineRows
        .slice(0, selectedIndex)
        .reverse()
        .find((row) => row.validForCurrentKickoff) ?? null
    : null;
  const previous = previousRow
    ? buildMatchForecast(previousRow.fixtureAtFreeze, previousRow.snapshot)
    : null;
  const news = await contextNews(fixture, forecast.cutoffAt);
  return {
    match: {
      id: fixture.id,
      competition: "premier-league",
      season: fixture.season,
      home: forecast.home,
      away: forecast.away,
      kickoffUtc: fixture.kickoffUtc as string,
      status: fixture.status,
    },
    forecast,
    freshness: forecastFreshness(forecast.cutoffAt, now),
    timeline,
    comparison: previous ? compareForecastSnapshots(previous, forecast) : null,
    context: {
      news,
      availability: {
        supported: false,
        items: [],
        note:
          "The Premier League production model has no timestamped availability input in this version, so availability is excluded rather than reconstructed from current state.",
      },
      tactics: {
        supported: false,
        items: [],
        note:
          "The Premier League production model does not read the current tactical-profile store. Historical tactical context without an auditable availability timestamp is excluded.",
      },
      temporalRule: "availableAt <= forecast.cutoffAt",
    },
    audit: forecast.provenance,
  };
}
