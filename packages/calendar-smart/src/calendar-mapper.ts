import { nullableString } from "./null-helpers.js";

/**
 * Slim calendar shape. Strips upstream `calendarList` noise (`kind`, `etag`,
 * `colorId`, `defaultReminders`, `notificationSettings`,
 * `conferenceProperties`, etc.). Both endpoint shapes feed through here:
 *
 *   - `/users/me/calendarList/{id}` (and the bare list) carry every field
 *     including `accessRole`, `primary`, `selected`, `hidden`,
 *     `summaryOverride`, `foregroundColor` — per-user view of the calendar.
 *   - `/calendars/{id}` (returned by `POST /calendars` / `PATCH /calendars`)
 *     carries only the calendar resource fields (`id`, `summary`,
 *     `description`, `location`, `timeZone`). Missing CalendarList fields
 *     collapse to safe defaults so callers can rely on a total shape.
 *
 * Convention: tools that mutate the underlying calendar (create/update/delete)
 * re-fetch via `getCalendarListEntry` after the write so the returned slim
 * carries `accessRole`/`primary` from the per-user view rather than the
 * stripped Calendars-resource shape.
 */
export type SlimCalendar = {
  id: string;
  summary: string;
  primary: boolean;
  time_zone: string;
  access_role: "owner" | "writer" | "reader" | "freeBusyReader";
  background_color: string | null;
  foreground_color: string | null;
  description: string | null;
  location: string | null;
  /**
   * CalendarList-only override of the displayed name in the user's sidebar.
   * Null on the bare `/calendars/{id}` shape and when the user hasn't set
   * one. Distinct from `summary` which is the canonical calendar title.
   */
  summary_override: string | null;
  /**
   * CalendarList-only flag — whether the calendar is selected for display in
   * the sidebar. Defaults to `true` on the bare `/calendars/{id}` shape
   * (Google's behavior is "newly subscribed calendars are visible").
   */
  selected: boolean;
  /**
   * CalendarList-only flag — whether the user explicitly hid this calendar
   * from their sidebar. Defaults to `false` on the bare `/calendars/{id}`
   * shape and when the field is absent.
   */
  hidden: boolean;
};

const ACCESS_ROLES = new Set([
  "owner",
  "writer",
  "reader",
  "freeBusyReader",
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickAccessRole(
  raw: Record<string, unknown>,
): SlimCalendar["access_role"] {
  if (
    typeof raw.accessRole === "string" &&
    ACCESS_ROLES.has(raw.accessRole)
  ) {
    return raw.accessRole as SlimCalendar["access_role"];
  }
  // Default to the most-restrictive role. If Google ever adds a new role and
  // we don't recognize it, treating it as "reader" is safe (read-only). Also
  // applied to the bare `/calendars/{id}` shape which omits accessRole.
  return "reader";
}

/**
 * Convert a raw Google calendar resource (CalendarList entry OR bare
 * Calendars resource) into the slim shape. Unknown fields are dropped;
 * missing fields collapse to safe defaults so the slim shape is total.
 */
export function mapCalendar(raw: unknown): SlimCalendar {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapCalendar: expected an object calendar resource");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    summary: typeof obj.summary === "string" ? obj.summary : "",
    primary: obj.primary === true,
    time_zone: typeof obj.timeZone === "string" ? obj.timeZone : "",
    access_role: pickAccessRole(obj),
    background_color: nullableString(obj.backgroundColor),
    foreground_color: nullableString(obj.foregroundColor),
    description: nullableString(obj.description),
    location: nullableString(obj.location),
    summary_override: nullableString(obj.summaryOverride),
    // CalendarList convention: when the field is absent, the calendar is
    // visible by default. The bare /calendars/{id} shape never carries this
    // field, so the default applies there too.
    selected: obj.selected === false ? false : true,
    hidden: obj.hidden === true,
  };
}
