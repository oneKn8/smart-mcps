import { nullableString } from "./null-helpers.js";

/**
 * Slim attendee shape. Mirrors Google's `attendees[]` entries with the
 * fields we expose. `optional` defaults to false when Google omits it.
 */
export type SlimAttendee = {
  email: string;
  response: "accepted" | "declined" | "tentative" | "needsAction";
  optional: boolean;
};

/**
 * Slim source shape. Mirrors Google's `source` block — a URL the event was
 * created from (e.g. a doc, an email thread). `title` is null when absent.
 */
export type SlimSource = {
  url: string;
  title: string | null;
};

/**
 * Slim extended-properties shape. `private` is single-user metadata visible
 * only to the calendar owner; `shared` propagates to copies on attendees'
 * calendars. Both are string→string maps. Returned as `null` when neither
 * sub-block is present.
 */
export type SlimExtendedProperties = {
  private: Record<string, string>;
  shared: Record<string, string>;
};

/**
 * Slim event shape. Strips upstream noise (`iCalUID`, `etag`, `created`,
 * `updated`, `kind`, `reminders`, etc.). Field-stripping is asserted in the
 * mapper unit tests via `Object.keys(...).sort()`.
 *
 * Time fields:
 * - `start` and `end` are ISO 8601 strings for timed events (with the
 *   tz offset Google emits, e.g. `"2026-05-13T10:00:00-05:00"`).
 * - For all-day events both fields are bare `YYYY-MM-DD` strings.
 *   `all_day` is the explicit boolean signal so callers do not have to
 *   parse the string format.
 *
 * Surface fields added in Phase 5.5 (read-side parity with the expanded
 * write-side schema): `visibility`, `transparency`, `color_id`,
 * `event_type`, the three `guests_can_*` permissions, `source`, and
 * `extended_properties`. All carry sensible Google defaults when the
 * upstream resource omits them so the slim shape stays total.
 */
export type SlimEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  attendees: SlimAttendee[];
  meeting_url: string | null;
  calendar_id: string;
  organizer_email: string | null;
  recurrence: string[] | null;
  status: "confirmed" | "tentative" | "cancelled";
  html_link: string;
  visibility: "default" | "public" | "private" | "confidential";
  transparency: "opaque" | "transparent";
  color_id: string | null;
  event_type:
    | "default"
    | "outOfOffice"
    | "focusTime"
    | "workingLocation"
    | "birthday"
    | "fromGmail";
  guests_can_invite_others: boolean;
  guests_can_modify: boolean;
  guests_can_see_other_guests: boolean;
  source: SlimSource | null;
  extended_properties: SlimExtendedProperties | null;
};

// Conferencing URL detection. Order matters within a single string scan but
// not between hosts. Anchored to `https://` so we never match bare hostnames.
const MEETING_URL_REGEX =
  /https:\/\/(?:meet\.google\.com|teams\.microsoft\.com|zoom\.us)\/[^\s]+/i;

const ATTENDEE_RESPONSES = new Set([
  "accepted",
  "declined",
  "tentative",
  "needsAction",
]);

const STATUS_VALUES = new Set(["confirmed", "tentative", "cancelled"]);

const VISIBILITY_VALUES = new Set([
  "default",
  "public",
  "private",
  "confidential",
]);

const TRANSPARENCY_VALUES = new Set(["opaque", "transparent"]);

const EVENT_TYPE_VALUES = new Set([
  "default",
  "outOfOffice",
  "focusTime",
  "workingLocation",
  "birthday",
  "fromGmail",
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the start/end ISO string out of either a `dateTime` (timed) or
 * `date` (all-day) sub-block. The presence of `dateTime` wins; Google
 * never sets both.
 */
function pickTimePoint(
  block: unknown,
): { iso: string; allDay: boolean } | null {
  const obj = asObject(block);
  if (!obj) return null;
  if (typeof obj.dateTime === "string") {
    return { iso: obj.dateTime, allDay: false };
  }
  if (typeof obj.date === "string") {
    return { iso: obj.date, allDay: true };
  }
  return null;
}

/**
 * Find the best video meeting URL: conferenceData.entryPoints first
 * (looking specifically for `entryPointType === "video"`), then a regex
 * scan of `location`, then `description`. Returns null if no candidate.
 */
function pickMeetingUrl(raw: Record<string, unknown>): string | null {
  const conf = asObject(raw.conferenceData);
  if (conf && Array.isArray(conf.entryPoints)) {
    for (const ep of conf.entryPoints) {
      const epObj = asObject(ep);
      if (
        epObj &&
        epObj.entryPointType === "video" &&
        typeof epObj.uri === "string"
      ) {
        return epObj.uri;
      }
    }
  }
  if (typeof raw.location === "string") {
    const m = MEETING_URL_REGEX.exec(raw.location);
    if (m) return m[0];
  }
  if (typeof raw.description === "string") {
    const m = MEETING_URL_REGEX.exec(raw.description);
    if (m) return m[0];
  }
  return null;
}

function pickAttendees(raw: Record<string, unknown>): SlimAttendee[] {
  if (!Array.isArray(raw.attendees)) return [];
  const out: SlimAttendee[] = [];
  for (const entry of raw.attendees) {
    const a = asObject(entry);
    if (!a) continue;
    if (typeof a.email !== "string") continue;
    const response =
      typeof a.responseStatus === "string" &&
      ATTENDEE_RESPONSES.has(a.responseStatus)
        ? (a.responseStatus as SlimAttendee["response"])
        : "needsAction";
    out.push({
      email: a.email,
      response,
      optional: a.optional === true,
    });
  }
  return out;
}

function pickRecurrence(raw: Record<string, unknown>): string[] | null {
  if (!Array.isArray(raw.recurrence) || raw.recurrence.length === 0) {
    return null;
  }
  const out: string[] = [];
  for (const r of raw.recurrence) {
    if (typeof r === "string") out.push(r);
  }
  return out.length > 0 ? out : null;
}

function pickStatus(raw: Record<string, unknown>): SlimEvent["status"] {
  if (
    typeof raw.status === "string" &&
    STATUS_VALUES.has(raw.status)
  ) {
    return raw.status as SlimEvent["status"];
  }
  return "confirmed";
}

function pickOrganizerEmail(raw: Record<string, unknown>): string | null {
  const org = asObject(raw.organizer);
  return org ? nullableString(org.email) : null;
}

/**
 * Default to "default" when the upstream value is missing or unrecognized.
 * Mirrors Google's documented enum.
 */
function pickVisibility(raw: Record<string, unknown>): SlimEvent["visibility"] {
  if (typeof raw.visibility === "string" && VISIBILITY_VALUES.has(raw.visibility)) {
    return raw.visibility as SlimEvent["visibility"];
  }
  return "default";
}

function pickTransparency(
  raw: Record<string, unknown>,
): SlimEvent["transparency"] {
  if (
    typeof raw.transparency === "string" &&
    TRANSPARENCY_VALUES.has(raw.transparency)
  ) {
    return raw.transparency as SlimEvent["transparency"];
  }
  return "opaque";
}

function pickEventType(raw: Record<string, unknown>): SlimEvent["event_type"] {
  if (
    typeof raw.eventType === "string" &&
    EVENT_TYPE_VALUES.has(raw.eventType)
  ) {
    return raw.eventType as SlimEvent["event_type"];
  }
  return "default";
}

/**
 * Extract a string→string sub-map from an `extendedProperties` block. Skips
 * non-string values silently — Google's docs constrain values to strings,
 * but we narrow defensively for safety.
 */
function pickStringMap(value: unknown): Record<string, string> {
  const obj = asObject(value);
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function pickExtendedProperties(
  raw: Record<string, unknown>,
): SlimExtendedProperties | null {
  const ext = asObject(raw.extendedProperties);
  if (!ext) return null;
  const priv = pickStringMap(ext.private);
  const shared = pickStringMap(ext.shared);
  if (Object.keys(priv).length === 0 && Object.keys(shared).length === 0) {
    return null;
  }
  return { private: priv, shared };
}

function pickSource(raw: Record<string, unknown>): SlimSource | null {
  const src = asObject(raw.source);
  if (!src) return null;
  if (typeof src.url !== "string" || src.url.length === 0) return null;
  return {
    url: src.url,
    title: nullableString(src.title),
  };
}

/**
 * Convert a raw Google Calendar event resource into the slim shape.
 * Unknown / missing fields collapse to nulls / empty arrays so the slim
 * shape is total — every key is always present.
 *
 * `calendarId` is supplied by the caller because Google does not echo it
 * back on the event resource; the LLM needs it to issue follow-up calls.
 */
export function mapEvent(raw: unknown, calendarId: string): SlimEvent {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapEvent: expected an object event resource");
  }
  const start = pickTimePoint(obj.start);
  const end = pickTimePoint(obj.end);
  if (!start || !end) {
    throw new Error("mapEvent: event missing start or end time block");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    summary: typeof obj.summary === "string" ? obj.summary : "",
    start: start.iso,
    end: end.iso,
    all_day: start.allDay,
    location: nullableString(obj.location),
    description: nullableString(obj.description),
    attendees: pickAttendees(obj),
    meeting_url: pickMeetingUrl(obj),
    calendar_id: calendarId,
    organizer_email: pickOrganizerEmail(obj),
    recurrence: pickRecurrence(obj),
    status: pickStatus(obj),
    html_link: typeof obj.htmlLink === "string" ? obj.htmlLink : "",
    visibility: pickVisibility(obj),
    transparency: pickTransparency(obj),
    color_id: nullableString(obj.colorId),
    event_type: pickEventType(obj),
    guests_can_invite_others: obj.guestsCanInviteOthers !== false,
    guests_can_modify: obj.guestsCanModify === true,
    guests_can_see_other_guests: obj.guestsCanSeeOtherGuests !== false,
    source: pickSource(obj),
    extended_properties: pickExtendedProperties(obj),
  };
}

/**
 * Build the Google Calendar `start` / `end` field for a write request.
 *
 * Google accepts two shapes: `{ dateTime: string }` for timed events (ISO
 * 8601 with offset, e.g. `2026-05-13T10:00:00-05:00`) and `{ date: string }`
 * for all-day events (calendar date `YYYY-MM-DD`). We detect the bare-date
 * form by exact regex and route to `{ date }`; everything else goes through
 * as `{ dateTime }`. Google itself validates the timed form; sending an
 * obviously-malformed string returns a 400 we surface to the caller.
 */
export function eventTimeField(
  value: string,
): { date: string } | { dateTime: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return { dateTime: value };
}
