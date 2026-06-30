// Pure date helpers for the today / overdue bucketing shortcuts.
//
// `due` on a Google task is DATE-ONLY: the API discards the time portion and
// stores UTC midnight of the date the user set. The slim mapper already
// normalizes `due` to a bare `YYYY-MM-DD` calendar date. Bucketing is then a
// pure lexicographic comparison of `YYYY-MM-DD` strings, which is correct for
// dates and independent of any time-of-day or zone.
//
// "Today" is the user's SYSTEM-LOCAL calendar date (per the design): we read
// the local Y/M/D from the host clock. The UTC-midnight helpers exist only to
// build best-effort `dueMin`/`dueMax` payload-trim hints for the API call;
// they are never the source of truth for membership — the string comparison is.

/**
 * The user's local calendar date as `YYYY-MM-DD`, read from the system clock.
 * Uses `Date` local accessors so the result follows the host time zone
 * (`process.env.TZ`). Pass `ref` to compute the local date of a fixed instant.
 */
export function localDateKey(ref: Date = new Date()): string {
  return `${pad(ref.getFullYear(), 4)}-${pad(ref.getMonth() + 1)}-${pad(
    ref.getDate(),
  )}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Add `days` (may be negative) to a `YYYY-MM-DD` key and return the resulting
 * `YYYY-MM-DD`. Uses UTC calendar arithmetic so month/year rollover is exact
 * and no time-of-day or DST ever enters the computation.
 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) {
    throw new Error(`date-buckets: expected YYYY-MM-DD, got "${dateKey}"`);
  }
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  );
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}`;
}

/**
 * The UTC-midnight RFC 3339 timestamp that Google stores for a date-only
 * `due` on the given calendar date. Used only to build `dueMin`/`dueMax`
 * payload-trim hints — never as the membership test.
 */
export function dateKeyToUtcMidnight(dateKey: string): string {
  return `${dateKey}T00:00:00.000Z`;
}

/**
 * True only when `value` is a well-formed AND real `YYYY-MM-DD` calendar date:
 * correct shape, month 1-12, and a day that actually exists in that month.
 * `2026-13-45`, `2026-02-30`, and `2026-02-29` (non-leap) are all rejected.
 *
 * Implemented by round-tripping through UTC date math: a real date survives the
 * `Date.UTC` normalization unchanged, while an out-of-range month/day overflows
 * into a neighbouring month and fails the equality check.
 */
export function isValidDateKey(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}
