// Pure time-zone math built on `Intl.DateTimeFormat.formatToParts`. No
// third-party tz library — Node 22 ships with full ICU data which already
// knows every IANA zone we care about.
//
// All functions take an IANA tz identifier (e.g. `"America/Chicago"`,
// `"Asia/Dhaka"`, `"UTC"`). They never mutate inputs and never depend on
// process-local `Date.toLocaleString` formatting (which is host-locale-
// sensitive). Output is a `Date` (UTC-anchored under the hood) or a string
// in a stable format matching the upstream Google Calendar shape.

type DateInput = string | Date;

/**
 * Resolve the YYYY-MM-DD calendar-date triple of `instant` as observed in
 * `tz`. Used internally to map a Date to its local-tz day key.
 */
function partsInTz(instant: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  // `formatToParts` with hourCycle: "h23" guarantees 00-23 not 1-24.
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
  const parts = fmt.formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
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

/**
 * Compute the UTC `Date` that corresponds to wall-clock
 * `Y-M-D H:M:S` in `tz`. Accurate across DST transitions because we
 * resolve the offset by inverting `partsInTz` on a candidate instant.
 *
 * Algorithm:
 *  1. Build a "naive" UTC instant from the wall-clock components.
 *  2. Ask the tz what wall-clock that instant maps to.
 *  3. Diff (target wall-clock – observed wall-clock) → offset in ms.
 *  4. Subtract offset from naive instant. One iteration is enough for
 *     any modern IANA zone because tz offsets are quarter-hour granular.
 */
function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const observed = partsInTz(new Date(naiveUtcMs), tz);
  const observedUtcMs = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
    observed.second,
  );
  // tz wall-clock is `observedUtcMs - naiveUtcMs` ahead of UTC, so the real
  // UTC instant is naive minus that offset.
  const offsetMs = observedUtcMs - naiveUtcMs;
  return new Date(naiveUtcMs - offsetMs);
}

/**
 * Parse a YYYY-MM-DD string, or a Date interpreted as that local-tz day.
 */
function resolveDateKey(date: DateInput, tz: string): {
  year: number;
  month: number;
  day: number;
} {
  if (typeof date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) {
      throw new Error(`time-zone: expected YYYY-MM-DD, got "${date}"`);
    }
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
    };
  }
  const parts = partsInTz(date, tz);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Returns the `Date` at midnight (local tz) of the given calendar date.
 * Accepts either a `YYYY-MM-DD` string or a `Date` (which is interpreted
 * as "the day this instant falls on in `tz`").
 */
export function startOfDay(date: DateInput, tz: string): Date {
  const { year, month, day } = resolveDateKey(date, tz);
  return zonedDateToUtc(year, month, day, 0, 0, 0, tz);
}

/**
 * Returns midnight (local tz) of the day AFTER `date`. Used as the exclusive
 * upper bound for a single-day window. Across DST transitions this is 23h
 * (spring forward) or 25h (fall back) after `startOfDay`, matching the
 * agenda window the user actually experiences.
 */
export function endOfDay(date: DateInput, tz: string): Date {
  const { year, month, day } = resolveDateKey(date, tz);
  // Add one day's worth of midnight directly in calendar arithmetic so we
  // do not double-apply DST when constructing the next-day instant.
  // `Date.UTC` handles month/year rollover for us.
  const nextUtcMidnight = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedDateToUtc(
    nextUtcMidnight.getUTCFullYear(),
    nextUtcMidnight.getUTCMonth() + 1,
    nextUtcMidnight.getUTCDate(),
    0,
    0,
    0,
    tz,
  );
}

/**
 * Returns Monday-based week bounds containing `date` in `tz`. `start` is
 * Monday 00:00 local-tz, `end` is the following Monday 00:00 local-tz
 * (exclusive).
 *
 * "Monday-based" matches the global user expectation per the Phase 5 spec;
 * Sunday is treated as the LAST day of the week, not the first.
 */
export function weekBounds(
  date: DateInput,
  tz: string,
): { start: Date; end: Date } {
  const { year, month, day } = resolveDateKey(date, tz);
  // Use UTC arithmetic on the calendar-date triple to find what day-of-week
  // it is, independent of tz wall-clock hours. This works because the date
  // triple itself is already the local-tz date.
  const anchor = new Date(Date.UTC(year, month - 1, day));
  // JavaScript: Sunday=0, Monday=1, ..., Saturday=6.
  // We want Monday=0, ..., Sunday=6.
  const dow = (anchor.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(year, month - 1, day - dow));
  const nextMonday = new Date(Date.UTC(year, month - 1, day - dow + 7));
  return {
    start: zonedDateToUtc(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
      0,
      0,
      0,
      tz,
    ),
    end: zonedDateToUtc(
      nextMonday.getUTCFullYear(),
      nextMonday.getUTCMonth() + 1,
      nextMonday.getUTCDate(),
      0,
      0,
      0,
      tz,
    ),
  };
}

/**
 * Format a `Date` as ISO 8601 with the given tz's offset suffix
 * (e.g. `"2026-05-13T10:00:00-05:00"`). Mirrors what Google Calendar emits
 * for timed events in a calendar configured to that tz.
 */
export function formatIso(date: Date, tz: string): string {
  const parts = partsInTz(date, tz);
  // Reconstruct the offset by diffing wall-clock observed in `tz` against
  // the same wall-clock interpreted as UTC.
  const observedUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMinutes = Math.round((observedUtcMs - date.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMinutes);
  const offHours = Math.floor(absMin / 60);
  const offMins = absMin % 60;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    `${sign}${pad(offHours)}:${pad(offMins)}`
  );
}

/**
 * Resolve "today" in `tz` (defaulting to `new Date()`) as a YYYY-MM-DD
 * string suitable for passing back into `startOfDay` / `endOfDay`.
 */
export function todayInTz(tz: string, ref: Date = new Date()): string {
  const parts = partsInTz(ref, tz);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}
