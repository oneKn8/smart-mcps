import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, eventTimeField, type SlimEvent } from "../event-mapper.js";
import {
  attendeesSchema,
  birthdaySchema,
  buildBirthdayProperties,
  buildExtendedPropertiesField,
  buildFocusTimeProperties,
  buildMeetConferenceRequest,
  buildOutOfOfficeProperties,
  buildRemindersField,
  buildSourceField,
  buildWorkingLocationProperties,
  eventTypeSchema,
  extendedPropertiesSchema,
  focusTimeSchema,
  normalizeAttendees,
  outOfOfficeSchema,
  remindersSchema,
  sendUpdatesSchema,
  sourceSchema,
  transparencySchema,
  visibilitySchema,
  workingLocationSchema,
} from "./event-write-fields.js";

// =============================================================================
// quick_add
// =============================================================================

const quickAddInputSchema = z.object({
  text: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
});

type QuickAddInput = z.input<typeof quickAddInputSchema>;
type QuickAddParsed = z.infer<typeof quickAddInputSchema>;

type QuickAddOutput = { event: SlimEvent };

export const quickAddTool = defineTool<
  QuickAddInput,
  QuickAddOutput,
  CalendarContext
>({
  name: "quick_add",
  description: "Create event from natural language",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema: quickAddInputSchema as unknown as z.ZodType<QuickAddInput>,
  handler: async (input, ctx) => {
    const parsed = input as QuickAddParsed;
    const raw = await ctx.client.quickAdd({
      calendarId: parsed.calendar_id,
      text: parsed.text,
    });
    return { event: mapEvent(raw, parsed.calendar_id) };
  },
});

// =============================================================================
// create_event
// =============================================================================

const createEventInputSchema = z.object({
  summary: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  attendees: attendeesSchema.optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  recurrence: z.array(z.string().min(1)).optional(),
  calendar_id: z.string().optional().default("primary"),
  // Phase 5.5: extended fields
  reminders: remindersSchema.optional(),
  create_meet_link: z.boolean().optional(),
  color_id: z.string().optional(),
  visibility: visibilitySchema.optional(),
  transparency: transparencySchema.optional(),
  guests_can_invite_others: z.boolean().optional(),
  guests_can_modify: z.boolean().optional(),
  guests_can_see_other_guests: z.boolean().optional(),
  source: sourceSchema.optional(),
  extended_properties: extendedPropertiesSchema.optional(),
  send_updates: sendUpdatesSchema.optional(),
  event_type: eventTypeSchema.optional(),
  focus_time: focusTimeSchema.optional(),
  out_of_office: outOfOfficeSchema.optional(),
  working_location: workingLocationSchema.optional(),
  birthday: birthdaySchema.optional(),
});

type CreateEventInput = z.input<typeof createEventInputSchema>;
type CreateEventParsed = z.infer<typeof createEventInputSchema>;

type CreateEventOutput = { event: SlimEvent };

/**
 * Determine the default `sendUpdates` value: when attendees are present we
 * default to "all" so Google sends invite emails (matches user expectation
 * of "I just invited people, they should hear about it"); otherwise "none".
 * An explicit `parsed.send_updates` always wins.
 */
function resolveCreateSendUpdates(
  parsed: CreateEventParsed,
): "all" | "externalOnly" | "none" {
  if (parsed.send_updates !== undefined) return parsed.send_updates;
  return parsed.attendees !== undefined && parsed.attendees.length > 0
    ? "all"
    : "none";
}

export const createEventTool = defineTool<
  CreateEventInput,
  CreateEventOutput,
  CalendarContext
>({
  name: "create_event",
  description: "Create event with structured fields",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    createEventInputSchema as unknown as z.ZodType<CreateEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as CreateEventParsed;

    // Recurring events require an IANA timeZone on start/end (DST disambig);
    // fetch the calendar's tz once when needed. Single-shot events can rely
    // on the offset embedded in the dateTime string alone.
    const tz =
      parsed.recurrence !== undefined && parsed.recurrence.length > 0
        ? await ctx.client.ensureTimeZone()
        : undefined;

    // Build the body with only the keys that have values. Strip undefineds
    // explicitly so the upstream payload is minimal — Google echoes back
    // the exact fields we send and we don't want stray `attendees: null`
    // to wipe an existing attendee list on a future PATCH-like flow.
    const body: Record<string, unknown> = {
      summary: parsed.summary,
      start: eventTimeField(parsed.start, tz),
      end: eventTimeField(parsed.end, tz),
    };
    if (parsed.attendees !== undefined) {
      body.attendees = normalizeAttendees(parsed.attendees);
    }
    if (parsed.location !== undefined) body.location = parsed.location;
    if (parsed.description !== undefined) body.description = parsed.description;
    if (parsed.recurrence !== undefined) body.recurrence = parsed.recurrence;

    // Extended fields ---------------------------------------------------------
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

    // Event type + per-type properties. Google rejects mismatched property
    // blocks (e.g. focusTimeProperties on an outOfOffice event), so we only
    // attach the property block that matches the declared event_type.
    if (parsed.event_type !== undefined && parsed.event_type !== "default") {
      body.eventType = parsed.event_type;
    }
    if (parsed.event_type === "focusTime" && parsed.focus_time !== undefined) {
      body.focusTimeProperties = buildFocusTimeProperties(parsed.focus_time);
    }
    if (
      parsed.event_type === "outOfOffice" &&
      parsed.out_of_office !== undefined
    ) {
      body.outOfOfficeProperties = buildOutOfOfficeProperties(
        parsed.out_of_office,
      );
    }
    if (
      parsed.event_type === "workingLocation" &&
      parsed.working_location !== undefined
    ) {
      body.workingLocationProperties = buildWorkingLocationProperties(
        parsed.working_location,
      );
      // Google requires both on workingLocation events; auto-set unless the
      // caller explicitly chose otherwise. Without these, Google returns 400
      // "malformedWorkingLocationEvent" before even checking workspace
      // eligibility — masking the real "not enterprise account" error.
      if (parsed.transparency === undefined) body.transparency = "transparent";
      if (parsed.visibility === undefined) body.visibility = "public";
    }
    if (parsed.event_type === "birthday" && parsed.birthday !== undefined) {
      body.birthdayProperties = buildBirthdayProperties(parsed.birthday);
    }

    const sendUpdates = resolveCreateSendUpdates(parsed);

    const insertOpts: {
      calendarId: string;
      body: Record<string, unknown>;
      conferenceDataVersion?: 0 | 1;
      sendUpdates?: "all" | "externalOnly" | "none";
    } = {
      calendarId: parsed.calendar_id,
      body,
    };
    if (parsed.create_meet_link === true) {
      insertOpts.conferenceDataVersion = 1;
    }
    // Always forward sendUpdates explicitly so behavior is predictable;
    // the client only attaches a query string when this is set.
    insertOpts.sendUpdates = sendUpdates;

    const raw = await ctx.client.insertEvent(insertOpts);
    return { event: mapEvent(raw, parsed.calendar_id) };
  },
});

// =============================================================================
// respond_to_event
// =============================================================================

const respondToEventInputSchema = z.object({
  event_id: z.string().min(1),
  response: z.enum(["accepted", "declined", "tentative"]),
  calendar_id: z.string().optional().default("primary"),
});

type RespondToEventInput = z.input<typeof respondToEventInputSchema>;
type RespondToEventParsed = z.infer<typeof respondToEventInputSchema>;

type RespondToEventOutput = { event: SlimEvent };

/**
 * Locate the calling user's attendee record (matched by email, case-insensitive)
 * and return a new attendees array with that record's `responseStatus` updated.
 * Untouched records are passed through verbatim so we never accidentally
 * downgrade other attendees' RSVPs.
 *
 * Returns null when the user is not in the attendees list — caller raises
 * a clear error rather than silently no-op'ing.
 */
function patchOwnRsvp(
  attendees: unknown[],
  myEmail: string,
  newResponse: "accepted" | "declined" | "tentative",
): Record<string, unknown>[] | null {
  let matched = false;
  const out: Record<string, unknown>[] = [];
  const myEmailLc = myEmail.toLowerCase();
  for (const entry of attendees) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const a = entry as Record<string, unknown>;
    const email =
      typeof a.email === "string" ? a.email.toLowerCase() : undefined;
    if (email === myEmailLc) {
      matched = true;
      out.push({ ...a, responseStatus: newResponse });
    } else {
      out.push({ ...a });
    }
  }
  return matched ? out : null;
}

export const respondToEventTool = defineTool<
  RespondToEventInput,
  RespondToEventOutput,
  CalendarContext
>({
  name: "respond_to_event",
  description: "Update your RSVP for an event",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    respondToEventInputSchema as unknown as z.ZodType<RespondToEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as RespondToEventParsed;
    const raw = await ctx.client.getEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
    });
    const event = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const organizer = event.organizer as
      | { self?: unknown; email?: unknown }
      | undefined;
    if (organizer?.self === true) {
      throw new ValidationError(
        "Cannot RSVP: not an attendee on this event (you are the organizer).",
      );
    }
    const attendees = Array.isArray(event.attendees) ? event.attendees : [];
    const myEmail = ctx.client.getAccountEmail();
    const updated = patchOwnRsvp(attendees, myEmail, parsed.response);
    if (updated === null) {
      throw new ValidationError(
        `Cannot RSVP: not an attendee on this event (no attendee record matched ${myEmail}).`,
      );
    }
    const patched = await ctx.client.patchEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
      body: { attendees: updated },
    });
    return { event: mapEvent(patched, parsed.calendar_id) };
  },
});
