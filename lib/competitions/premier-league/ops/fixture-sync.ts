/**
 * Fixture metadata sync.
 *
 * Logical identity never changes. Kickoff / certainty / status updates
 * append a schedule revision. Repeated syncs with no source change write
 * no logical change and no duplicate revision.
 */

import type { Fixture, KickoffCertainty, VerificationStatus } from "@/lib/identity/types";
import { canonicalizeFixtureStatus } from "../ingest";
import { kickoffLocalIso, utcIsoToLondonLocal } from "../timezone";
import type {
  DataConflict,
  FixtureScheduleRevision,
  SourceObservation,
} from "./types";
import { LIVE_SOURCES, SOURCE_OFFICIAL, type FixtureSource } from "./sources";
import { appendJsonl, readJsonl, rewriteJsonl } from "./jsonl";
import { scheduleRevisionPath, sourceObservationPath } from "./paths";

const KICKOFF_EQUAL_MS = 1000;

/**
 * Statuses that a live structured source may explicitly reopen back to
 * SCHEDULED. Only POSTPONED is auto-resumable. CANCELLED, ABANDONED,
 * SUSPENDED, LIVE and FINISHED are never reopened by a schedule payload —
 * those transitions require operator action or a dedicated correction flow.
 */
const AUTO_RESUMABLE_STATUSES: ReadonlySet<string> = new Set(["POSTPONED"]);

export interface FixtureSyncInput {
  fixtures: Fixture[];
  observations: SourceObservation[];
  now: string;
  persistObservations?: boolean;
}

export interface FixtureSyncResult {
  fixtures: Fixture[];
  revisions: FixtureScheduleRevision[];
  conflicts: DataConflict[];
  changedFixtureIds: string[];
  observationCount: number;
}

function kickoffEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return a === b;
  return Math.abs(da - db) < KICKOFF_EQUAL_MS;
}

export function sameLogicalSchedule(
  a: Pick<Fixture, "kickoffUtc" | "kickoff" | "kickoffCertainty" | "status">,
  b: Pick<Fixture, "kickoffUtc" | "kickoff" | "kickoffCertainty" | "status">
): boolean {
  return (
    kickoffEqual(a.kickoffUtc ?? a.kickoff, b.kickoffUtc ?? b.kickoff) &&
    (a.kickoffCertainty ?? null) === (b.kickoffCertainty ?? null) &&
    canonicalizeFixtureStatus(a.status) === canonicalizeFixtureStatus(b.status)
  );
}

function liveObsForFixture(observations: SourceObservation[], fixtureId: string): SourceObservation[] {
  return observations.filter((o) => o.fixtureId === fixtureId && LIVE_SOURCES.includes(o.source as (typeof LIVE_SOURCES)[number]));
}

function latestPerSource(rows: SourceObservation[]): SourceObservation[] {
  const by = new Map<string, SourceObservation>();
  for (const row of rows) {
    const prev = by.get(row.source);
    if (!prev || prev.retrievedAt <= row.retrievedAt) by.set(row.source, row);
  }
  return [...by.values()];
}

function applyNormalized(
  current: Fixture,
  obs: SourceObservation,
  now?: string
): {
  next: Fixture;
  reason: string;
} | null {
  const n = obs.normalized;
  if (!n.homeSlug || !n.awaySlug) return null;
  if (n.homeSlug !== current.homeSlug || n.awaySlug !== current.awaySlug) return null;

  const next: Fixture = { ...current };
  let reason = "";
  let resumed = false;

  if (n.status && n.status !== "SCHEDULED") {
    next.status = n.status;
    next.statusUpdatedAt = obs.retrievedAt;
    if (n.status !== canonicalizeFixtureStatus(current.status)) reason = `status ${current.status} → ${n.status}`;
  }

  // Explicit source-driven resume: a live structured source that reports the
  // fixture as schedulable again (TIMED/NS → SCHEDULED) with a new, future,
  // CONFIRMED kickoff may reopen a POSTPONED fixture. The status is never
  // cleared from a bare kickoff change alone.
  const currentStatus = canonicalizeFixtureStatus(current.status);
  if (
    n.status === "SCHEDULED" &&
    AUTO_RESUMABLE_STATUSES.has(currentStatus) &&
    LIVE_SOURCES.includes(obs.source as (typeof LIVE_SOURCES)[number]) &&
    Boolean(n.kickoffUtc) &&
    Number.isFinite(Date.parse(n.kickoffUtc as string)) &&
    Boolean(now) &&
    Date.parse(n.kickoffUtc as string) > Date.parse(now as string) &&
    n.kickoffCertainty === "CONFIRMED"
  ) {
    next.status = "SCHEDULED";
    next.statusUpdatedAt = obs.retrievedAt;
    resumed = true;
  }

  if (n.status === "POSTPONED" || n.status === "CANCELLED" || n.status === "ABANDONED") {
    if (n.kickoffUtc && !kickoffEqual(n.kickoffUtc, current.kickoffUtc)) {
      next.kickoffUtc = n.kickoffUtc;
      next.kickoff = n.kickoffUtc;
    }
    next.kickoffCertainty = n.status === "POSTPONED" ? "TBD" : current.kickoffCertainty;
    if (!reason) reason = `${n.status.toLowerCase()} by ${obs.source}`;
  } else if (n.kickoffUtc && !kickoffEqual(n.kickoffUtc, current.kickoffUtc ?? current.kickoff)) {
    next.kickoffUtc = n.kickoffUtc;
    next.kickoff = n.kickoffUtc;
    if (n.scheduledDate) {
      next.date = n.scheduledDate;
      next.scheduledDate = n.scheduledDate;
    }
    if (n.kickoffLocal) next.kickoffLocal = n.kickoffLocal;
    else {
      try {
        const loc = utcIsoToLondonLocal(n.kickoffUtc);
        next.kickoffLocal = kickoffLocalIso(loc.date, loc.time);
        next.date = loc.date;
        next.scheduledDate = loc.date;
      } catch {
        /* keep */
      }
    }
    if (n.kickoffCertainty) next.kickoffCertainty = n.kickoffCertainty;
    reason = `kickoff ${current.kickoffUtc ?? current.kickoff} → ${n.kickoffUtc} (${n.kickoffCertainty ?? "n/a"})`;
  } else if (n.kickoffCertainty && n.kickoffCertainty !== current.kickoffCertainty) {
    next.kickoffCertainty = n.kickoffCertainty;
    reason = `certainty ${current.kickoffCertainty} → ${n.kickoffCertainty}`;
  }

  if (obs.sourceFixtureId && !current.sourceFixtureId) {
    next.sourceFixtureId = obs.sourceFixtureId;
  }
  next.sourceUpdatedAt = obs.sourceUpdatedAt ?? next.sourceUpdatedAt;
  next.retrievedAt = obs.retrievedAt;

  if (resumed) {
    reason = `rescheduled: ${currentStatus} → SCHEDULED (${obs.source}; kickoff ${n.kickoffUtc}; ${n.kickoffCertainty ?? "n/a"})`;
  }

  if (sameLogicalSchedule(current, next) && next.verificationStatus === current.verificationStatus) {
    return null;
  }
  return { next, reason: reason || `metadata update from ${obs.source}` };
}

export function detectKickoffConflict(live: SourceObservation[]): DataConflict | null {
  const withTime = live.filter((o) => o.normalized.kickoffUtc && o.normalized.status !== "POSTPONED");
  if (withTime.length < 2) return null;
  const first = withTime[0].normalized.kickoffUtc!;
  for (const row of withTime.slice(1)) {
    if (!kickoffEqual(first, row.normalized.kickoffUtc)) {
      return {
        kind: "fixture-kickoff",
        fixtureId: live[0].fixtureId ?? "unknown",
        sources: withTime.map((o) => o.source),
        detail: withTime.map((o) => `${o.source}=${o.normalized.kickoffUtc}`).join("; "),
        recordedAt: withTime.map((o) => o.retrievedAt).sort().slice(-1)[0],
      };
    }
  }
  return null;
}

function makeRevision(
  fixtureId: string,
  at: string,
  prev: Fixture,
  next: Fixture,
  source: string,
  reason: string
): FixtureScheduleRevision {
  return {
    revisionId: `${fixtureId}::${at}::${source}`,
    fixtureId,
    changedAt: at,
    oldKickoff: prev.kickoffUtc ?? prev.kickoff ?? null,
    newKickoff: next.kickoffUtc ?? next.kickoff ?? null,
    oldCertainty: prev.kickoffCertainty,
    newCertainty: next.kickoffCertainty,
    oldStatus: prev.status,
    newStatus: next.status,
    source,
    reason,
  };
}

export function syncFixturesFromObservations(input: FixtureSyncInput): FixtureSyncResult {
  const byId = new Map(input.fixtures.map((f) => [f.id, { ...f }]));
  const revisions: FixtureScheduleRevision[] = [];
  const conflicts: DataConflict[] = [];
  const changed = new Set<string>();

  const grouped = new Map<string, SourceObservation[]>();
  for (const obs of input.observations) {
    if (!obs.fixtureId) continue;
    (grouped.get(obs.fixtureId) ?? grouped.set(obs.fixtureId, []).get(obs.fixtureId)!).push(obs);
  }

  for (const [fixtureId, rows] of grouped) {
    const current = byId.get(fixtureId);
    if (!current) continue;

    const live = latestPerSource(liveObsForFixture(rows, fixtureId));
    const kickoffConflict = detectKickoffConflict(live);
    if (kickoffConflict) {
      conflicts.push(kickoffConflict);
      const blocked: Fixture = { ...current, verificationStatus: "SOURCE_CONFLICT" };
      if (current.verificationStatus !== "SOURCE_CONFLICT") {
        revisions.push(makeRevision(fixtureId, input.now, current, blocked, live.map((l) => l.source).join("+"), kickoffConflict.detail));
        changed.add(fixtureId);
      }
      byId.set(fixtureId, blocked);
      continue;
    }

    const preferred =
      live.find((o) => o.normalized.status === "POSTPONED" || o.normalized.status === "CANCELLED") ??
      live[0] ??
      latestPerSource(rows.filter((r) => r.source === SOURCE_OFFICIAL))[0];

    if (!preferred) continue;
    // Date-only live rows (no real kickoff) must not erase official DEFAULT times.
    if (!preferred.normalized.kickoffUtc && preferred.normalized.status === "SCHEDULED") {
      continue;
    }
    // Baseline official CSV is not allowed to overwrite a later live confirmation.
    const currentKick = current.kickoffUtc ?? current.kickoff ?? "";
    const currentIsDateOnly = /T00:00:00(?:\.000)?Z$/.test(currentKick);
    if (
      preferred.source === SOURCE_OFFICIAL &&
      current.kickoffCertainty === "CONFIRMED" &&
      !currentIsDateOnly
    ) {
      continue;
    }

    const applied = applyNormalized(current, preferred, input.now);
    if (!applied) continue;
    const next: Fixture = {
      ...applied.next,
      verificationStatus: (current.verificationStatus === "SOURCE_CONFLICT"
        ? "VERIFIED"
        : current.verificationStatus) as VerificationStatus | undefined,
    };
    if (sameLogicalSchedule(current, next) && next.verificationStatus === current.verificationStatus) continue;
    byId.set(fixtureId, next);
    revisions.push(makeRevision(fixtureId, input.now, current, next, preferred.source, applied.reason));
    changed.add(fixtureId);
  }

  if (input.persistObservations) {
    persistLiveSourceObservations(input.observations);
  }

  return {
    fixtures: input.fixtures.map((f) => byId.get(f.id) ?? f),
    revisions,
    conflicts,
    changedFixtureIds: [...changed],
    observationCount: input.observations.length,
  };
}

export function persistScheduleRevisions(revisions: FixtureScheduleRevision[]): FixtureScheduleRevision[] {
  if (!revisions.length) return [];
  const existing = loadScheduleRevisions();
  const seen = new Set(existing.map((r) => `${r.fixtureId}::${r.changedAt}::${r.oldKickoff}::${r.newKickoff}::${r.oldCertainty}::${r.newCertainty}::${r.oldStatus}::${r.newStatus}`));
  const written: FixtureScheduleRevision[] = [];
  for (const rev of revisions) {
    const key = `${rev.fixtureId}::${rev.changedAt}::${rev.oldKickoff}::${rev.newKickoff}::${rev.oldCertainty}::${rev.newCertainty}::${rev.oldStatus}::${rev.newStatus}`;
    if (seen.has(key)) continue;
    seen.add(key);
    appendJsonl(scheduleRevisionPath(), rev);
    written.push(rev);
  }
  return written;
}

export function loadScheduleRevisions(): FixtureScheduleRevision[] {
  return readJsonl<FixtureScheduleRevision>(scheduleRevisionPath());
}

export function loadSourceObservations(): SourceObservation[] {
  return readJsonl<SourceObservation>(sourceObservationPath());
}

function observationDedupeKey(row: SourceObservation): string {
  return `${row.source}::${row.fixtureId ?? row.sourceFixtureId ?? row.observationId}`;
}

/** Drop bulky `raw` payloads. They are not used after the tick that produced them. */
export function stripObservationRaw(row: SourceObservation): SourceObservation {
  return { ...row, raw: null };
}

/**
 * Keep the latest observation per source+fixture.
 * Production stores this JSONL inside one Mongo document (16 MB limit).
 * Appending 380 football-data.org rows with `raw` every 5 minutes overflowed that document.
 */
export function compactSourceObservations(rows: SourceObservation[]): SourceObservation[] {
  const byKey = new Map<string, SourceObservation>();
  for (const row of rows) {
    if (row.source === SOURCE_OFFICIAL) continue;
    const key = observationDedupeKey(row);
    const prev = byKey.get(key);
    if (!prev || prev.retrievedAt <= row.retrievedAt) {
      byKey.set(key, stripObservationRaw(row));
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.retrievedAt.localeCompare(b.retrievedAt) ||
      (a.fixtureId ?? "").localeCompare(b.fixtureId ?? "") ||
      a.source.localeCompare(b.source)
  );
}

export function persistLiveSourceObservations(incoming: SourceObservation[]): void {
  const next = compactSourceObservations([
    ...loadSourceObservations(),
    ...incoming.filter((o) => o.source !== SOURCE_OFFICIAL),
  ]);
  rewriteJsonl(sourceObservationPath(), next);
}

export function compactPersistedSourceObservations(): void {
  rewriteJsonl(sourceObservationPath(), compactSourceObservations(loadSourceObservations()));
}

export async function collectSourceObservations(
  sources: FixtureSource[],
  nowIso: string
): Promise<{ observations: SourceObservation[]; errors: string[]; configuredLive: string[] }> {
  const observations: SourceObservation[] = [];
  const errors: string[] = [];
  const configuredLive: string[] = [];
  for (const src of sources) {
    if (src.kind === "live" && src.configured) configuredLive.push(src.id);
    if (!src.configured) continue;
    try {
      const rows = await src.fetch(nowIso);
      observations.push(...rows);
    } catch (err) {
      errors.push(`${src.id}: ${(err as Error).message}`);
    }
  }
  return { observations, errors, configuredLive };
}

export function fixtureAsOf(
  revisions: FixtureScheduleRevision[],
  fixtureId: string,
  atIso: string
): { kickoff: string | null; certainty: KickoffCertainty | null | undefined; status: string } | null {
  const rows = revisions
    .filter((r) => r.fixtureId === fixtureId && r.changedAt <= atIso)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return { kickoff: last.newKickoff, certainty: last.newCertainty, status: String(last.newStatus) };
}
