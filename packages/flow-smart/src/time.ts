// Pure date/time-zone math for the flow doc tools. No API, HTTP, or storage —
// just glue that turns calendar-date keys + an IANA tz into the RFC 3339
// window bounds the CalendarClient expects, and back. Built on
// `Intl.DateTimeFormat.formatToParts` (Node 22 ships full ICU), so every IANA
// zone resolves without a third-party tz library.
//
// This mirrors the proven approach in calendar-smart's `time-zone.ts`; it is
// re-derived here (not imported) because calendar-smart only exposes its
// CLIENT over the `./client` subpath, not its internal helpers.

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Resolve the wall-clock components of `instant` as observed in `tz`. */
function partsInTz(instant: Date, tz: string): WallParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const lookup: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

/** Signed offset (localWallClock − instant) in ms observed in `tz` at `ms`. */
function offsetMsAt(ms: number, tz: string): number {
  const p = partsInTz(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - ms;
}

/** Whether the wall clock observed in `tz` at `ms` equals the given fields. */
function wallEquals(
  ms: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): boolean {
  const p = partsInTz(new Date(ms), tz);
  return (
    p.year === year &&
    p.month === month &&
    p.day === day &&
    p.hour === hour &&
    p.minute === minute &&
    p.second === second
  );
}

/**
 * The UTC `Date` whose wall clock in `tz` equals `Y-M-D H:M:S`. We invert the
 * zone offset on a candidate instant; a SINGLE inversion is wrong when a DST
 * transition lies between the naive instant and the candidate — for zones that
 * shift at local midnight (e.g. America/Santiago 2026-04-05, Asia/Beirut
 * 2026-03-29) it lands on the adjacent calendar DAY. So we re-derive the offset
 * at the first candidate and re-solve. When neither candidate reproduces the
 * requested wall clock the time falls in a spring-forward gap (it never
 * occurs); we then map it forward to the first valid instant using the smaller
 * (pre-transition) offset, deterministically preserving the calendar date.
 */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetA = offsetMsAt(targetMs, tz);
  const candAMs = targetMs - offsetA;
  const offsetB = offsetMsAt(candAMs, tz);
  // No transition between the two instants: the single inversion is exact.
  if (offsetB === offsetA) return new Date(candAMs);
  // Second pass: re-solve with the offset observed at the first candidate.
  const candBMs = targetMs - offsetB;
  if (wallEquals(candBMs, year, month, day, hour, minute, second, tz)) {
    return new Date(candBMs);
  }
  if (wallEquals(candAMs, year, month, day, hour, minute, second, tz)) {
    return new Date(candAMs);
  }
  // Spring-forward gap: requested wall time does not exist. Map it forward.
  return new Date(targetMs - Math.min(offsetA, offsetB));
}

/** Format a `Date` as RFC 3339 with the tz's offset suffix at that instant. */
function formatIso(date: Date, tz: string): string {
  const p = partsInTz(date, tz);
  const observedUtcMs = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  const offsetMinutes = Math.round((observedUtcMs - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function parseDateKey(dateKey: string): {
  year: number;
  month: number;
  day: number;
} {
  const m = DATE_KEY_RE.exec(dateKey);
  if (!m) throw new Error(`time: expected YYYY-MM-DD, got "${dateKey}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** "Today" (or the day of `ref`) in `tz` as a `YYYY-MM-DD` key. */
export function dateKeyInTz(tz: string, ref: Date = new Date()): string {
  const p = partsInTz(ref, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Add `days` (may be negative) to a date key via UTC calendar arithmetic. */
export function addDays(dateKey: string, days: number): string {
  const { year, month, day } = parseDateKey(dateKey);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}`;
}

/**
 * Monday-based week containing `dateKey`. `start` is that Monday, `endInclusive`
 * the Sunday, `endExclusive` the following Monday (the exclusive upper bound a
 * calendar `timeMax` wants).
 */
export function mondayWeek(dateKey: string): {
  start: string;
  endInclusive: string;
  endExclusive: string;
} {
  const { year, month, day } = parseDateKey(dateKey);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  // JS Sunday=0..Saturday=6; shift to Monday=0..Sunday=6.
  const dow = (anchor.getUTCDay() + 6) % 7;
  const start = addDays(dateKey, -dow);
  return {
    start,
    endInclusive: addDays(start, 6),
    endExclusive: addDays(start, 7),
  };
}

/** RFC 3339 instant of local midnight (00:00 in `tz`) on `dateKey`. */
export function tzMidnightIso(dateKey: string, tz: string): string {
  const { year, month, day } = parseDateKey(dateKey);
  return formatIso(zonedToUtc(year, month, day, 0, 0, 0, tz), tz);
}

/** RFC 3339 instant of local wall-clock `hour:minute` in `tz` on `dateKey`. */
export function tzWallClockIso(
  dateKey: string,
  hour: number,
  minute: number,
  tz: string,
): string {
  const { year, month, day } = parseDateKey(dateKey);
  return formatIso(zonedToUtc(year, month, day, hour, minute, 0, tz), tz);
}

/** Add `minutes` to an RFC 3339 instant, re-formatted in `tz`. */
export function addMinutesIso(iso: string, minutes: number, tz: string): string {
  const base = new Date(iso);
  return formatIso(new Date(base.getTime() + minutes * 60_000), tz);
}

/** Parse `"HH:MM"` into `{ hour, minute }`; throws on a malformed value. */
export function parseClock(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`time: expected HH:MM, got "${hhmm}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`time: "${hhmm}" is not a valid 24h clock time`);
  }
  return { hour, minute };
}
