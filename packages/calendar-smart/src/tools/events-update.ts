import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, eventTimeField, type SlimEvent } from "../event-mapper.js";
import {
  attendeesSchema,
  birthdaySchema,
  buildUpdateEventBody,
  eventTypeSchema,
  extendedPropertiesSchema,
  focusTimeSchema,
  outOfOfficeSchema,
  remindersSchema,
  sendUpdatesSchema,
  sourceSchema,
  transparencySchema,
  visibilitySchema,
  workingLocationSchema,
} from "./event-write-fields.js";

// =============================================================================
// update_event
// =============================================================================

const updateEventInputSchema = z.object({
  event_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
  summary: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  attendees: attendeesSchema.optional(),
  // Phase 5.5: extended fields
  recurrence: z.array(z.string().min(1)).optional(),
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
  // event_type itself is rejected on update (Google forbids changing it
  // post-insert), but the per-type property blocks ARE patchable on an
  // event whose type was set at creation time.
  event_type: eventTypeSchema.optional(),
  focus_time: focusTimeSchema.optional(),
  out_of_office: outOfOfficeSchema.optional(),
  working_location: workingLocationSchema.optional(),
  birthday: birthdaySchema.optional(),
});

type UpdateEventInput = z.input<typeof updateEventInputSchema>;
type UpdateEventParsed = z.infer<typeof updateEventInputSchema>;

type UpdateEventOutput = { event: SlimEvent };

export const updateEventTool = defineTool<
  UpdateEventInput,
  UpdateEventOutput,
  CalendarContext
>({
  name: "update_event",
  description:
    "Update event fields by ID; series ID hits whole series, instance ID one occurrence",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    updateEventInputSchema as unknown as z.ZodType<UpdateEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateEventParsed;

    // Google forbids changing eventType after insert. Surface this as a
    // ValidationError up front rather than letting Google return a 400 the
    // caller has to decode.
    if (parsed.event_type !== undefined) {
      throw new ValidationError(
        "Cannot change eventType after insert. Cancel the event and create a new one with the desired event_type instead.",
      );
    }

    // When recurrence is being patched in, Google requires an IANA timeZone
    // on start/end (DST disambiguation). Fetch the calendar's tz once.
    const tz =
      parsed.recurrence !== undefined && parsed.recurrence.length > 0
        ? await ctx.client.ensureTimeZone()
        : undefined;

    // Build the patch with only provided fields. Omitted fields are NOT sent;
    // Google's PATCH leaves untouched fields alone, which is the user intent.
    // Shared with update_instance — see buildUpdateEventBody.
    const body = buildUpdateEventBody(parsed, tz);

    // sendUpdates default differs from create_event: PATCH defaults to "none"
    // because most updates are non-invite-worthy (renaming a title, fixing a
    // typo). Explicit caller value always wins.
    const sendUpdates = parsed.send_updates ?? "none";

    const patchOpts: {
      calendarId: string;
      eventId: string;
      body: Record<string, unknown>;
      conferenceDataVersion?: 0 | 1;
      sendUpdates?: "all" | "externalOnly" | "none";
    } = {
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
      body,
    };
    if (parsed.create_meet_link === true) {
      patchOpts.conferenceDataVersion = 1;
    }
    patchOpts.sendUpdates = sendUpdates;

    const raw = await ctx.client.patchEvent(patchOpts);
    return { event: mapEvent(raw, parsed.calendar_id) };
  },
});

// =============================================================================
// reschedule
// =============================================================================

const rescheduleInputSchema = z.object({
  event_id: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
});

type RescheduleInput = z.input<typeof rescheduleInputSchema>;
type RescheduleParsed = z.infer<typeof rescheduleInputSchema>;

type RescheduleOutput = { event: SlimEvent };

export const rescheduleTool = defineTool<
  RescheduleInput,
  RescheduleOutput,
  CalendarContext
>({
  name: "reschedule",
  description: "Move event to new start/end time",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema: rescheduleInputSchema as unknown as z.ZodType<RescheduleInput>,
  handler: async (input, ctx) => {
    const parsed = input as RescheduleParsed;
    const raw = await ctx.client.patchEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
      body: {
        start: eventTimeField(parsed.start),
        end: eventTimeField(parsed.end),
      },
    });
    return { event: mapEvent(raw, parsed.calendar_id) };
  },
});

// =============================================================================
// cancel_event  (destructive — confirm-gated)
// =============================================================================

const cancelEventInputSchema = z.object({
  event_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
  confirm: z.boolean().optional().default(false),
});

type CancelEventInput = z.input<typeof cancelEventInputSchema>;
type CancelEventParsed = z.infer<typeof cancelEventInputSchema>;

type CancelEventOutput = { cancelled: true };

/**
 * Pull the start ISO string from a raw event resource. Returns the empty
 * string when neither block is present, which keeps the preview legible
 * even on a corrupted upstream payload.
 */
function readStartIso(event: Record<string, unknown>): string {
  const start = event.start as { dateTime?: unknown; date?: unknown } | undefined;
  if (start === undefined) return "";
  if (typeof start.dateTime === "string") return start.dateTime;
  if (typeof start.date === "string") return start.date;
  return "";
}

function readSummary(event: Record<string, unknown>): string {
  return typeof event.summary === "string" ? event.summary : "";
}

function readAttendeeCount(event: Record<string, unknown>): number {
  return Array.isArray(event.attendees) ? event.attendees.length : 0;
}

function readCalendarSummary(entry: unknown, fallback: string): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.summary === "string" && obj.summary.length > 0) {
      return obj.summary;
    }
  }
  return fallback;
}

export const cancelEventTool = defineTool<
  CancelEventInput,
  CancelEventOutput,
  CalendarContext
>({
  name: "cancel_event",
  description: "Cancel/delete an event",
  // Cast required because `calendar_id` and `confirm` have defaults.
  inputSchema:
    cancelEventInputSchema as unknown as z.ZodType<CancelEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as CancelEventParsed;
    // Fetch the event first so we can build a meaningful preview. A missing
    // event surfaces as NotFoundError here, which the caller wants to see
    // before being asked to confirm.
    const rawEvent = await ctx.client.getEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
    });
    const event = (rawEvent && typeof rawEvent === "object"
      ? rawEvent
      : {}) as Record<string, unknown>;

    // Calendar summary lookup is best-effort: if the calendar metadata can't
    // be fetched we fall back to the raw id rather than block confirmation.
    let calendarLabel = parsed.calendar_id;
    try {
      const entry = await ctx.client.getCalendarListEntry(parsed.calendar_id);
      calendarLabel = readCalendarSummary(entry, parsed.calendar_id);
    } catch {
      // swallow — preview still shows the calendar id verbatim
    }

    const summary = readSummary(event);
    const startIso = readStartIso(event);
    const attendeeCount = readAttendeeCount(event);
    const preview =
      `Cancel '${summary}' on ${startIso} in ${calendarLabel} ` +
      `(${attendeeCount} attendees)`;

    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
    });
    return { cancelled: true };
  },
});
