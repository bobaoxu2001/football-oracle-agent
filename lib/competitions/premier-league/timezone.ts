/**
 * Timezone-safe kickoff handling.
 *
 * Internal timestamps are UTC. Source kickoffs are Europe/London local
 * (BST/GMT). Prediction cutoffs compare Date instants, never calendar strings.
 */

export const LONDON_TZ = "Europe/London";

const LONDON_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsOf(ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of LONDON_FMT.formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Interpret `YYYY-MM-DD` + `HH:MM` as Europe/London civil time and return UTC ISO.
 */
export function londonLocalToUtcIso(date: string, time: string): string {
  const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || !t) throw new Error(`Invalid London local datetime: ${date} ${time}`);
  const want = {
    year: m[1],
    month: m[2],
    day: m[3],
    hour: pad(Number(t[1])),
    minute: pad(Number(t[2])),
    second: pad(Number(t[3] ?? "0")),
  };
  // Guess UTC = the wall-clock read as Z, then close the TZ offset.
  let utcMs = Date.parse(`${want.year}-${want.month}-${want.day}T${want.hour}:${want.minute}:${want.second}Z`);
  for (let i = 0; i < 6; i++) {
    const got = partsOf(utcMs);
    const gotIso = `${got.year}-${got.month}-${got.day}T${got.hour}:${got.minute}:${got.second}Z`;
    const wantIso = `${want.year}-${want.month}-${want.day}T${want.hour}:${want.minute}:${want.second}Z`;
    const delta = Date.parse(wantIso) - Date.parse(gotIso);
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs).toISOString();
}

export function utcIsoToLondonLocal(utcIso: string): { date: string; time: string; offsetMinutes: number } {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid UTC timestamp: ${utcIso}`);
  const p = partsOf(ms);
  const localAsZ = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  const offsetMinutes = Math.round((localAsZ - ms) / 60000);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    offsetMinutes,
  };
}

export function defaultKickoffLocal(date: string, explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  // Sat/Sun default 15:00; Mon–Fri default 20:00 (official midweek rule).
  return dow === 0 || dow === 6 ? "15:00" : "20:00";
}

export function kickoffUtcFromSource(date: string, time?: string | null): string {
  return londonLocalToUtcIso(date, defaultKickoffLocal(date, time));
}

export function kickoffLocalIso(date: string, time?: string | null): string {
  const hhmm = defaultKickoffLocal(date, time);
  return `${date}T${hhmm}:00`;
}

/** Instant comparison. `asOf` may be a date (`YYYY-MM-DD`) or a full ISO timestamp. */
export function parseAsOfInstant(asOf: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return Date.parse(`${asOf}T00:00:00.000Z`);
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) throw new Error(`Invalid asOf: ${asOf}`);
  return ms;
}

export function isBeforeKickoff(asOf: string, kickoffUtc: string): boolean {
  return parseAsOfInstant(asOf) < Date.parse(kickoffUtc);
}

export function hoursUntilKickoff(asOf: string, kickoffUtc: string): number {
  return (Date.parse(kickoffUtc) - parseAsOfInstant(asOf)) / 3_600_000;
}
