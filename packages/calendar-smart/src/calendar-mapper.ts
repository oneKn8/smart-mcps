import { nullableString } from "./null-helpers.js";

/**
 * Slim calendar shape. Strips upstream `calendarList` noise (`kind`, `etag`,
 * `colorId`, `foregroundColor`, `selected`, `defaultReminders`, etc.). Both
 * the `/users/me/calendarList/{id}` and `/users/me/calendarList` endpoints
 * map through this — the former always carries `accessRole` / `primary`,
 * the latter does too. The bare `/calendars/{id}` endpoint does NOT carry
 * those, which is why the client uses `calendarList/{id}` for single-get.
 */
export type SlimCalendar = {
  id: string;
  summary: string;
  primary: boolean;
  time_zone: string;
  access_role: "owner" | "writer" | "reader" | "freeBusyReader";
  background_color: string | null;
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
  // we don't recognize it, treating it as "reader" is safe (read-only).
  return "reader";
}

/**
 * Convert a raw Google calendarList entry into the slim shape. Unknown
 * fields are dropped; missing fields collapse to safe defaults so the slim
 * shape is total.
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
  };
}
