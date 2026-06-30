import { nullableString } from "./null-helpers.js";

/**
 * Slim task shape. Strips upstream `Task` noise (`kind`, `etag`, `selfLink`,
 * `position`, `links`, `assignmentInfo`). Field-stripping is asserted in
 * `task-mapper.test.ts` via `Object.keys(...).sort()`.
 *
 * CRITICAL — `due` is date-only:
 * The Google Tasks API discards the time portion of a due timestamp and
 * stores UTC midnight; "It isn't possible to read or write the time that a
 * task is due via the API." We therefore normalize `due` to a bare
 * `YYYY-MM-DD` calendar date and NEVER surface a time-of-day for it. The
 * date we keep is the calendar date of the UTC-midnight Google stores, which
 * is exactly the date the user set.
 *
 * Other time fields:
 * - `completed` is a real RFC 3339 completion timestamp (it carries a true
 *   time-of-day, unlike `due`), or `null` when the task is not completed.
 * - `updated` is omitted from the slim shape (transport noise).
 *
 * `position` is intentionally dropped: it is a server-managed string sort key,
 * the API already returns items in position order, and it is not writable
 * (reorder via `move_task`, not by setting it).
 */
export type SlimTask = {
  id: string;
  title: string;
  notes: string | null;
  status: "needsAction" | "completed";
  /** Date-only `YYYY-MM-DD`, or `null`. Never carries a time-of-day. */
  due: string | null;
  /** RFC 3339 completion timestamp, or `null` when not completed. */
  completed: string | null;
  /** Parent task id when nested, or `null` at the top level. */
  parent: string | null;
  deleted: boolean;
  hidden: boolean;
  web_view_link: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extract the date-only portion of a Google `due` timestamp. The wire value
 * is a full RFC 3339 string (e.g. `2026-06-30T00:00:00.000Z`) but only the
 * calendar date is meaningful. Returns `YYYY-MM-DD` or `null`.
 */
export function dueDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Inverse of `dueDateOnly` for the WRITE path. A bare `YYYY-MM-DD` is expanded
 * to the UTC-midnight RFC 3339 timestamp Google stores; any other string is
 * forwarded verbatim (the API discards the time portion anyway). The caller
 * sends a date, never a time-of-day.
 */
export function toDueTimestamp(dateOrTimestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOrTimestamp)
    ? `${dateOrTimestamp}T00:00:00.000Z`
    : dateOrTimestamp;
}

function pickStatus(raw: Record<string, unknown>): SlimTask["status"] {
  return raw.status === "completed" ? "completed" : "needsAction";
}

/**
 * Convert a raw Google `Task` resource into the slim shape. Unknown fields are
 * dropped; missing fields collapse to safe defaults so the slim shape is total.
 */
export function mapTask(raw: unknown): SlimTask {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapTask: expected an object task resource");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    title: typeof obj.title === "string" ? obj.title : "",
    notes: nullableString(obj.notes),
    status: pickStatus(obj),
    due: dueDateOnly(obj.due),
    completed: nullableString(obj.completed),
    parent: nullableString(obj.parent),
    deleted: obj.deleted === true,
    hidden: obj.hidden === true,
    web_view_link: nullableString(obj.webViewLink),
  };
}
