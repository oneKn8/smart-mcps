// Pure readers over the RAW upstream resources the sibling clients return
// (Gmail message/thread, Tasks task, Calendar event) plus small Markdown
// formatting helpers. flow-smart deliberately does NOT import the sibling
// slim-mappers (they live behind each package's internals, not the `./client`
// subpath), so these read only the handful of fields the flow tools surface.
//
// Nothing here does I/O. Everything is total: missing/odd shapes collapse to
// `null` or `""` rather than throwing, so a malformed upstream item degrades
// one row instead of failing the whole flow.

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ===========================================================================
// Gmail message / thread
// ===========================================================================

/** Read a header value (case-insensitive name) off a raw Gmail message. */
export function messageHeader(rawMessage: unknown, name: string): string | null {
  const msg = asObject(rawMessage);
  if (!msg) return null;
  const payload = asObject(msg.payload);
  const headers = payload?.headers;
  if (!Array.isArray(headers)) return null;
  const target = name.toLowerCase();
  for (const h of headers) {
    const ho = asObject(h);
    if (ho && typeof ho.name === "string" && ho.name.toLowerCase() === target) {
      return str(ho.value);
    }
  }
  return null;
}

export function messageSubject(rawMessage: unknown): string | null {
  return messageHeader(rawMessage, "Subject");
}

export function messageFrom(rawMessage: unknown): string | null {
  return messageHeader(rawMessage, "From");
}

export function messageSnippet(rawMessage: unknown): string | null {
  const msg = asObject(rawMessage);
  return msg ? str(msg.snippet) : null;
}

/** The first message resource inside a raw `getThread` response, or null. */
export function firstThreadMessage(thread: {
  messages?: unknown[];
}): unknown | null {
  const list = thread.messages;
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

// ===========================================================================
// Tasks task
// ===========================================================================

export type SlimTaskView = {
  id: string;
  title: string;
  notes: string | null;
  status: "needsAction" | "completed";
  /** Date-only `YYYY-MM-DD`, or null. Tasks `due` never carries a time. */
  due: string | null;
  /** RFC 3339 completion instant (real time-of-day), or null. */
  completed: string | null;
  deleted: boolean;
};

/** Extract the date-only portion of a Tasks `due` timestamp. */
export function dueDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Expand a bare `YYYY-MM-DD` to the UTC-midnight instant Tasks stores. */
export function toDueTimestamp(dateOrTimestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOrTimestamp)
    ? `${dateOrTimestamp}T00:00:00.000Z`
    : dateOrTimestamp;
}

export function readTask(raw: unknown): SlimTaskView {
  const o = asObject(raw) ?? {};
  return {
    id: typeof o.id === "string" ? o.id : "",
    title: typeof o.title === "string" ? o.title : "",
    notes: str(o.notes),
    status: o.status === "completed" ? "completed" : "needsAction",
    due: dueDateOnly(o.due),
    completed: str(o.completed),
    deleted: o.deleted === true,
  };
}

// ===========================================================================
// Calendar event
// ===========================================================================

export type SlimEventView = {
  id: string;
  summary: string;
  /** RFC 3339 dateTime for timed events, `YYYY-MM-DD` for all-day, or null. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
};

function readTimePoint(value: unknown): { value: string | null; allDay: boolean } {
  const o = asObject(value);
  if (!o) return { value: null, allDay: false };
  if (typeof o.dateTime === "string") return { value: o.dateTime, allDay: false };
  if (typeof o.date === "string") return { value: o.date, allDay: true };
  return { value: null, allDay: false };
}

export function readEvent(raw: unknown): SlimEventView {
  const o = asObject(raw) ?? {};
  const start = readTimePoint(o.start);
  const end = readTimePoint(o.end);
  return {
    id: typeof o.id === "string" ? o.id : "",
    summary: typeof o.summary === "string" ? o.summary : "(no title)",
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    location: str(o.location),
    htmlLink: str(o.htmlLink),
  };
}

/**
 * Render the clock portion of an event start for a digest line. Timed events
 * show `HH:MM` (in whatever offset the upstream dateTime carries — Google
 * returns it in the calendar's own zone); all-day events show `all-day`.
 */
export function eventTimeLabel(ev: SlimEventView): string {
  if (ev.start === null) return "";
  if (ev.allDay) return "all-day";
  const m = /T(\d{2}:\d{2})/.exec(ev.start);
  return m ? (m[1] as string) : "";
}

// ===========================================================================
// Markdown helpers
// ===========================================================================

/** Collapse all whitespace (incl. newlines) so a value can sit on one line. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Make arbitrary text safe to drop INSIDE a Markdown line: collapse to one
 * line, then neutralize the inline emphasis/pipe markers the renderer parses
 * so a stray `*` or `|` in a subject can't restyle the document. A value can
 * also START a Doc line (a snippet pushed as its own paragraph), so we also
 * escape a LEADING list (`-`/`+`), ordered (`N.`/`N)`) or blockquote (`>`)
 * marker — otherwise an email beginning `- ` would open a bullet/quote block.
 * `*` and `#` are already escaped inline, so `* item` / `# h` are covered.
 */
export function mdInline(value: string): string {
  const inline = oneLine(value).replace(/[*_`|#]/g, (c) => `\\${c}`);
  return inline
    .replace(/^([-+>])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Truncate to `max` chars with an ellipsis, after one-lining. */
export function clamp(value: string, max: number): string {
  const s = oneLine(value);
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
