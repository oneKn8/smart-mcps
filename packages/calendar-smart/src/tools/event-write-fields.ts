import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eventTimeField } from "../event-mapper.js";

/**
 * Shared zod schemas + body-building helpers for the extended write-side
 * fields on `create_event` and `update_event`. These are exported as
 * standalone primitives so each tool can compose its own input schema
 * without duplicating the field definitions.
 *
 * The split is intentional: the tools own their top-level shapes (which
 * differ — `create_event` requires `summary/start/end`, `update_event`
 * does not). Only the per-field schemas and the body-shaping helpers are
 * shared here.
 */

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

/**
 * Reminder override entry. Google caps at 5 overrides; we enforce the cap
 * at the array level via `.max(5)` on the parent reminders schema.
 * `minutes` is bounded by Google's documented [0, 40320] (4 weeks) range.
 */
export const reminderOverrideSchema = z.object({
  method: z.enum(["email", "popup"]),
  minutes: z.number().int().min(0).max(40320),
});

/**
 * Top-level `reminders` schema. When `overrides` is provided we flip
 * `use_default` to false unless the caller explicitly set it to true; the
 * normalizer in `buildRemindersField` handles that defaulting so the input
 * schema can stay simple.
 */
export const remindersSchema = z.object({
  use_default: z.boolean().optional(),
  overrides: z.array(reminderOverrideSchema).max(5).optional(),
});

/**
 * Attendee schema as a discriminated UNION between bare email strings (the
 * Phase 5 shape — preserved for back-compat) and rich objects with optional
 * RSVP status / resource-room flag. The handler normalizes both forms into
 * Google's `attendees[]` shape.
 */
export const attendeeObjectSchema = z.object({
  email: z.string().email(),
  optional: z.boolean().optional(),
  response: z
    .enum(["accepted", "declined", "tentative", "needsAction"])
    .optional(),
  resource: z.boolean().optional(),
});

export const attendeesSchema = z.union([
  z.array(z.string().email()),
  z.array(attendeeObjectSchema),
]);

/**
 * `source` accepts only http/https URLs — Google rejects other schemes and
 * we surface that earlier as a zod validation error.
 */
export const sourceSchema = z.object({
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), {
    message: "source.url must use http or https",
  }),
  title: z.string().optional(),
});

export const extendedPropertiesSchema = z.object({
  private: z.record(z.string(), z.string()).optional(),
  shared: z.record(z.string(), z.string()).optional(),
});

export const visibilitySchema = z.enum([
  "default",
  "public",
  "private",
  "confidential",
]);

export const transparencySchema = z.enum(["opaque", "transparent"]);

export const sendUpdatesSchema = z.enum(["all", "externalOnly", "none"]);

export const eventTypeSchema = z.enum([
  "default",
  "outOfOffice",
  "focusTime",
  "workingLocation",
  "birthday",
]);

const autoDeclineSchema = z.enum([
  "declineNone",
  "declineAllConflictingInvitations",
  "declineOnlyNewConflictingInvitations",
]);

export const focusTimeSchema = z.object({
  auto_decline: autoDeclineSchema.optional(),
  decline_message: z.string().optional(),
  chat_status: z.enum(["available", "doNotDisturb"]).optional(),
});

export const outOfOfficeSchema = z.object({
  auto_decline: autoDeclineSchema.optional(),
  decline_message: z.string().optional(),
});

export const workingLocationSchema = z.object({
  type: z.enum(["homeOffice", "customLocation"]),
  custom_label: z.string().optional(),
});

export const birthdaySchema = z.object({
  contact: z.string().optional(),
  type: z.enum(["birthday", "anniversary", "other", "custom"]),
  custom_type_name: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Type aliases (the parsed shapes — what handlers see after zod runs)
// ---------------------------------------------------------------------------

export type RemindersInput = z.infer<typeof remindersSchema>;
export type AttendeesInput = z.infer<typeof attendeesSchema>;
export type SourceInput = z.infer<typeof sourceSchema>;
export type ExtendedPropertiesInput = z.infer<typeof extendedPropertiesSchema>;
export type FocusTimeInput = z.infer<typeof focusTimeSchema>;
export type OutOfOfficeInput = z.infer<typeof outOfOfficeSchema>;
export type WorkingLocationInput = z.infer<typeof workingLocationSchema>;
export type BirthdayInput = z.infer<typeof birthdaySchema>;
export type EventTypeInput = z.infer<typeof eventTypeSchema>;

// ---------------------------------------------------------------------------
// Body-building helpers
// ---------------------------------------------------------------------------

/**
 * Normalize attendees from either the string-array form (Phase 5) or the
 * object-array form (Phase 5.5) into Google's `attendees[]` shape:
 * `{ email, optional?, responseStatus?, resource? }`. Empty arrays are
 * emitted verbatim so callers can clear the attendee list explicitly.
 */
export function normalizeAttendees(
  attendees: AttendeesInput,
): Record<string, unknown>[] {
  if (attendees.length === 0) return [];
  // Discriminate by checking the first entry; the union enforces homogeneity.
  if (typeof attendees[0] === "string") {
    return (attendees as string[]).map((email) => ({ email }));
  }
  return (attendees as z.infer<typeof attendeeObjectSchema>[]).map((a) => {
    const out: Record<string, unknown> = { email: a.email };
    if (a.optional !== undefined) out.optional = a.optional;
    if (a.response !== undefined) out.responseStatus = a.response;
    if (a.resource !== undefined) out.resource = a.resource;
    return out;
  });
}

/**
 * Build the `reminders` block. Per Google, when `overrides` is provided we
 * flip `use_default` to false (you can't have both), unless the caller
 * explicitly opted into useDefault=true. The default shape `{ use_default:
 * true }` preserves the user's calendar-wide reminder defaults.
 */
export function buildRemindersField(
  reminders: RemindersInput,
): Record<string, unknown> {
  const hasOverrides =
    Array.isArray(reminders.overrides) && reminders.overrides.length > 0;
  const useDefault =
    reminders.use_default ?? (hasOverrides ? false : true);
  const out: Record<string, unknown> = { useDefault };
  if (hasOverrides) {
    out.overrides = reminders.overrides;
  }
  return out;
}

/**
 * Build the `conferenceData.createRequest` block for Google Meet
 * auto-creation. The `requestId` must be unique per call (Google uses it
 * for idempotency); we mint a fresh UUID per invocation.
 */
export function buildMeetConferenceRequest(): Record<string, unknown> {
  return {
    createRequest: {
      requestId: randomUUID(),
      conferenceSolutionKey: { type: "hangoutsMeet" },
    },
  };
}

export function buildSourceField(source: SourceInput): Record<string, unknown> {
  const out: Record<string, unknown> = { url: source.url };
  if (source.title !== undefined) out.title = source.title;
  return out;
}

/**
 * Build the `extendedProperties` block, omitting empty sub-maps so we
 * don't accidentally clobber existing entries on a PATCH. Returns null
 * when both private and shared are empty/absent — caller skips the field.
 */
export function buildExtendedPropertiesField(
  ext: ExtendedPropertiesInput,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (ext.private !== undefined && Object.keys(ext.private).length > 0) {
    out.private = ext.private;
  }
  if (ext.shared !== undefined && Object.keys(ext.shared).length > 0) {
    out.shared = ext.shared;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function buildFocusTimeProperties(
  ft: FocusTimeInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ft.auto_decline !== undefined) out.autoDeclineMode = ft.auto_decline;
  if (ft.decline_message !== undefined) out.declineMessage = ft.decline_message;
  if (ft.chat_status !== undefined) out.chatStatus = ft.chat_status;
  return out;
}

export function buildOutOfOfficeProperties(
  oo: OutOfOfficeInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (oo.auto_decline !== undefined) out.autoDeclineMode = oo.auto_decline;
  if (oo.decline_message !== undefined) out.declineMessage = oo.decline_message;
  return out;
}

/**
 * Build the `workingLocationProperties` block. `homeOffice` is an empty
 * object signal (Google's documented shape); `customLocation` carries an
 * optional label. Office-building/floor/desk IDs are Workspace-only and
 * intentionally deferred.
 */
export function buildWorkingLocationProperties(
  wl: WorkingLocationInput,
): Record<string, unknown> {
  if (wl.type === "homeOffice") {
    return { homeOffice: {} };
  }
  // customLocation
  const customLocation: Record<string, unknown> = {};
  if (wl.custom_label !== undefined) customLocation.label = wl.custom_label;
  return { customLocation };
}

export function buildBirthdayProperties(
  bd: BirthdayInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: bd.type };
  if (bd.contact !== undefined) out.contact = bd.contact;
  if (bd.custom_type_name !== undefined) {
    out.customTypeName = bd.custom_type_name;
  }
  return out;
}

/**
 * Shared parsed-input shape for update_event / update_instance. Both tools
 * accept the same field set (minus the id field, which differs by name).
 * `event_type` is intentionally omitted — Google forbids changing the
 * event type after insert and the caller-side guard rejects it before the
 * body is built.
 */
export type UpdateEventBodyInput = {
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  attendees?: AttendeesInput;
  recurrence?: string[];
  reminders?: RemindersInput;
  create_meet_link?: boolean;
  color_id?: string;
  visibility?:
    | "default"
    | "public"
    | "private"
    | "confidential";
  transparency?: "opaque" | "transparent";
  guests_can_invite_others?: boolean;
  guests_can_modify?: boolean;
  guests_can_see_other_guests?: boolean;
  source?: SourceInput;
  extended_properties?: ExtendedPropertiesInput;
  focus_time?: FocusTimeInput;
  out_of_office?: OutOfOfficeInput;
  working_location?: WorkingLocationInput;
  birthday?: BirthdayInput;
};

/**
 * Build the PATCH body for an event update. Only the fields actually
 * present on the input are added to the body — Google's PATCH leaves
 * untouched fields alone, which is the user intent.
 *
 * Mirrors the per-type-property attachment policy from update_event: each
 * property block is forwarded unconditionally (no event_type gating).
 * Google validates the property block matches the event's existing type
 * and surfaces a clear error if it doesn't.
 */
export function buildUpdateEventBody(
  parsed: UpdateEventBodyInput,
  timeZone?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (parsed.summary !== undefined) body.summary = parsed.summary;
  if (parsed.start !== undefined) body.start = eventTimeField(parsed.start, timeZone);
  if (parsed.end !== undefined) body.end = eventTimeField(parsed.end, timeZone);
  if (parsed.location !== undefined) body.location = parsed.location;
  if (parsed.description !== undefined) body.description = parsed.description;
  if (parsed.attendees !== undefined) {
    body.attendees = normalizeAttendees(parsed.attendees);
  }
  if (parsed.recurrence !== undefined) body.recurrence = parsed.recurrence;

  if (parsed.reminders !== undefined) {
    body.reminders = buildRemindersField(parsed.reminders);
  }
  if (parsed.create_meet_link === true) {
    body.conferenceData = buildMeetConferenceRequest();
  }
  if (parsed.color_id !== undefined) body.colorId = parsed.color_id;
  if (parsed.visibility !== undefined) body.visibility = parsed.visibility;
  if (parsed.transparency !== undefined) {
    body.transparency = parsed.transparency;
  }
  if (parsed.guests_can_invite_others !== undefined) {
    body.guestsCanInviteOthers = parsed.guests_can_invite_others;
  }
  if (parsed.guests_can_modify !== undefined) {
    body.guestsCanModify = parsed.guests_can_modify;
  }
  if (parsed.guests_can_see_other_guests !== undefined) {
    body.guestsCanSeeOtherGuests = parsed.guests_can_see_other_guests;
  }
  if (parsed.source !== undefined) {
    body.source = buildSourceField(parsed.source);
  }
  if (parsed.extended_properties !== undefined) {
    const ext = buildExtendedPropertiesField(parsed.extended_properties);
    if (ext !== null) body.extendedProperties = ext;
  }
  if (parsed.focus_time !== undefined) {
    body.focusTimeProperties = buildFocusTimeProperties(parsed.focus_time);
  }
  if (parsed.out_of_office !== undefined) {
    body.outOfOfficeProperties = buildOutOfOfficeProperties(
      parsed.out_of_office,
    );
  }
  if (parsed.working_location !== undefined) {
    body.workingLocationProperties = buildWorkingLocationProperties(
      parsed.working_location,
    );
  }
  if (parsed.birthday !== undefined) {
    body.birthdayProperties = buildBirthdayProperties(parsed.birthday);
  }
  return body;
}

/**
 * Apply (insert or replace) an `UNTIL=<stamp>` clause on the first RRULE
 * entry in a recurrence array. Used by `split_recurrence` to cap the
 * original series at the split point.
 *
 * Behavior:
 *  - The stamp must be in Google's UTC RRULE format `YYYYMMDDTHHMMSSZ`. We
 *    do not parse or transform it; callers compute it once.
 *  - Any existing `UNTIL=` clause on the matched RRULE is replaced.
 *  - Any existing `COUNT=` clause is dropped — Google rejects an RRULE
 *    that carries both UNTIL and COUNT, and "this and following" semantics
 *    intend UNTIL, not COUNT.
 *  - Only the FIRST RRULE entry is modified; subsequent rules and non-RRULE
 *    entries (EXDATE, RDATE, etc.) pass through verbatim.
 *  - Throws when the input contains no RRULE — caller surfaces a clear
 *    error rather than silently dropping the operation.
 */
export function applyUntilToRRule(
  rules: string[],
  untilUtc: string,
): string[] {
  let modified = false;
  const out = rules.map((rule) => {
    if (modified || !rule.startsWith("RRULE:")) return rule;
    modified = true;
    const body = rule.slice("RRULE:".length);
    const parts = body
      .split(";")
      .filter(
        (p) =>
          p.length > 0 &&
          !p.toUpperCase().startsWith("UNTIL=") &&
          !p.toUpperCase().startsWith("COUNT="),
      );
    parts.push(`UNTIL=${untilUtc}`);
    return `RRULE:${parts.join(";")}`;
  });
  if (!modified) {
    throw new Error(
      "applyUntilToRRule: recurrence array contains no RRULE entry",
    );
  }
  return out;
}
