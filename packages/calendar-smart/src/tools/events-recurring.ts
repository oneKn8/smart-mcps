import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, eventTimeField, type SlimEvent } from "../event-mapper.js";
import {
  applyUntilToRRule,
  attendeesSchema,
  birthdaySchema,
  buildBirthdayProperties,
  buildExtendedPropertiesField,
  buildFocusTimeProperties,
  buildMeetConferenceRequest,
  buildOutOfOfficeProperties,
  buildRemindersField,
  buildSourceField,
  buildUpdateEventBody,
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
// list_instances
// =============================================================================

const listInstancesInputSchema = z.object({
  event_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  original_start: z.string().optional(),
  max_results: z.number().int().min(1).max(250).optional().default(25),
  show_deleted: z.boolean().optional().default(false),
});

type ListInstancesInput = z.input<typeof listInstancesInputSchema>;
type ListInstancesParsed = z.infer<typeof listInstancesInputSchema>;

type ListInstancesOutput = {
  instances: SlimEvent[];
  next_page_token: string | null;
};

export const listInstancesTool = defineTool<
  ListInstancesInput,
  ListInstancesOutput,
  CalendarContext
>({
  name: "list_instances",
  description: "Expand recurring series into instances",
  // Cast required because the schema has `.optional().default(...)` fields.
  inputSchema:
    listInstancesInputSchema as unknown as z.ZodType<ListInstancesInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListInstancesParsed;
    const opts: {
      calendarId: string;
      eventId: string;
      maxResults: number;
      showDeleted: boolean;
      timeMin?: string;
      timeMax?: string;
      originalStart?: string;
    } = {
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
      maxResults: parsed.max_results,
      showDeleted: parsed.show_deleted,
    };
    if (parsed.time_min !== undefined) opts.timeMin = parsed.time_min;
    if (parsed.time_max !== undefined) opts.timeMax = parsed.time_max;
    if (parsed.original_start !== undefined) {
      opts.originalStart = parsed.original_start;
    }
    const result = await ctx.client.listInstances(opts);
    return {
      instances: result.items.map((item) =>
        mapEvent(item, parsed.calendar_id),
      ),
      next_page_token: result.nextPageToken ?? null,
    };
  },
});

// =============================================================================
// update_instance
// =============================================================================

const updateInstanceInputSchema = z.object({
  instance_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
  summary: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  attendees: attendeesSchema.optional(),
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
  // Mirrors update_event: schema accepts event_type so the LLM sees a clear
  // ValidationError message instead of a zod refusal that hides intent.
  event_type: eventTypeSchema.optional(),
  focus_time: focusTimeSchema.optional(),
  out_of_office: outOfOfficeSchema.optional(),
  working_location: workingLocationSchema.optional(),
  birthday: birthdaySchema.optional(),
});

type UpdateInstanceInput = z.input<typeof updateInstanceInputSchema>;
type UpdateInstanceParsed = z.infer<typeof updateInstanceInputSchema>;

type UpdateInstanceOutput = { event: SlimEvent };

export const updateInstanceTool = defineTool<
  UpdateInstanceInput,
  UpdateInstanceOutput,
  CalendarContext
>({
  name: "update_instance",
  description: "Update one occurrence of a recurring event",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    updateInstanceInputSchema as unknown as z.ZodType<UpdateInstanceInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateInstanceParsed;

    if (parsed.event_type !== undefined) {
      throw new ValidationError(
        "Cannot change eventType after insert. Cancel the event and create a new one with the desired event_type instead.",
      );
    }

    // recurrence on a single instance is unusual but if provided, Google
    // requires a timeZone on start/end. Mirror update_event behavior.
    const tz =
      parsed.recurrence !== undefined && parsed.recurrence.length > 0
        ? await ctx.client.ensureTimeZone()
        : undefined;

    const body = buildUpdateEventBody(parsed, tz);

    // sendUpdates default mirrors update_event: "none" for the typical
    // single-instance tweak (renaming, rescheduling one occurrence).
    const sendUpdates = parsed.send_updates ?? "none";

    const patchOpts: {
      calendarId: string;
      eventId: string;
      body: Record<string, unknown>;
      conferenceDataVersion?: 0 | 1;
      sendUpdates?: "all" | "externalOnly" | "none";
    } = {
      calendarId: parsed.calendar_id,
      eventId: parsed.instance_id,
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
// cancel_instance  (destructive — confirm-gated)
// =============================================================================

const cancelInstanceInputSchema = z.object({
  instance_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
  confirm: z.boolean().optional().default(false),
});

type CancelInstanceInput = z.input<typeof cancelInstanceInputSchema>;
type CancelInstanceParsed = z.infer<typeof cancelInstanceInputSchema>;

type CancelInstanceOutput = { cancelled: true };

function readInstanceSummary(event: Record<string, unknown>): string {
  return typeof event.summary === "string" ? event.summary : "";
}

function readOriginalStartIso(event: Record<string, unknown>): string {
  const original = event.originalStartTime as
    | { dateTime?: unknown; date?: unknown }
    | undefined;
  if (original !== undefined) {
    if (typeof original.dateTime === "string") return original.dateTime;
    if (typeof original.date === "string") return original.date;
  }
  // Fallback: the regular start block.
  const start = event.start as { dateTime?: unknown; date?: unknown } | undefined;
  if (start !== undefined) {
    if (typeof start.dateTime === "string") return start.dateTime;
    if (typeof start.date === "string") return start.date;
  }
  return "";
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

export const cancelInstanceTool = defineTool<
  CancelInstanceInput,
  CancelInstanceOutput,
  CalendarContext
>({
  name: "cancel_instance",
  description: "Skip one occurrence of a recurring event",
  // Cast required because `calendar_id` and `confirm` have defaults.
  inputSchema:
    cancelInstanceInputSchema as unknown as z.ZodType<CancelInstanceInput>,
  handler: async (input, ctx) => {
    const parsed = input as CancelInstanceParsed;
    // Fetch the instance for preview context. Missing instance surfaces as
    // NotFoundError here — caller wants to see that before being asked to
    // confirm.
    const rawInstance = await ctx.client.getEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.instance_id,
    });
    const event = (rawInstance && typeof rawInstance === "object"
      ? rawInstance
      : {}) as Record<string, unknown>;

    let calendarLabel = parsed.calendar_id;
    try {
      const entry = await ctx.client.getCalendarListEntry(parsed.calendar_id);
      calendarLabel = readCalendarSummary(entry, parsed.calendar_id);
    } catch {
      // swallow — preview still shows the calendar id verbatim
    }

    const summary = readInstanceSummary(event);
    const originalStart = readOriginalStartIso(event);
    const preview =
      `Cancel one occurrence of '${summary}' on ${originalStart} ` +
      `(${calendarLabel})`;

    guardDestructive({ confirm: parsed.confirm, preview });

    // PATCH with status: cancelled is the documented way to skip a single
    // instance without ending the parent series. DELETE on an instance id
    // has subtly different semantics (Google records an exception event
    // with cancelled status either way, but PATCH is the explicit form).
    await ctx.client.patchEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.instance_id,
      body: { status: "cancelled" },
    });
    return { cancelled: true };
  },
});

// =============================================================================
// split_recurrence
// =============================================================================

/**
 * Schema for the `new_event` sub-object: the series that picks up at the
 * split point. Mirrors `create_event` input minus `calendar_id` (the parent
 * call's `calendar_id` is the canonical scope; the new series must live in
 * the same calendar to preserve "split here" semantics).
 */
const newEventSchema = z.object({
  summary: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  attendees: attendeesSchema.optional(),
  location: z.string().optional(),
  description: z.string().optional(),
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
  event_type: eventTypeSchema.optional(),
  focus_time: focusTimeSchema.optional(),
  out_of_office: outOfOfficeSchema.optional(),
  working_location: workingLocationSchema.optional(),
  birthday: birthdaySchema.optional(),
});

type NewEventInput = z.infer<typeof newEventSchema>;

const splitRecurrenceInputSchema = z.object({
  event_id: z.string().min(1),
  target_start: z.string().min(1),
  new_event: newEventSchema,
  calendar_id: z.string().optional().default("primary"),
  send_updates: sendUpdatesSchema.optional(),
  confirm: z.boolean().optional().default(false),
});

type SplitRecurrenceInput = z.input<typeof splitRecurrenceInputSchema>;
type SplitRecurrenceParsed = z.infer<typeof splitRecurrenceInputSchema>;

type SplitRecurrenceOutput = {
  truncated_series: SlimEvent;
  new_series: SlimEvent;
};

/**
 * Convert an ISO datetime to Google's RRULE UNTIL stamp format
 * `YYYYMMDDTHHMMSSZ`, after subtracting one second so the UNTIL cap lands
 * strictly before the new series' first occurrence.
 *
 * The `target_start` we receive is whatever ISO the caller provided (with
 * offset or `Z`). `new Date(...)` parses both, and we re-emit in UTC.
 */
function untilStampBefore(isoStart: string): string {
  const t = Date.parse(isoStart);
  if (!Number.isFinite(t)) {
    throw new ValidationError(
      `target_start \`${isoStart}\` is not a valid ISO datetime`,
    );
  }
  const d = new Date(t - 1000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Build the Google insert body for the new series. Mirrors the create_event
 * field-attachment policy: only attach the per-event-type property block
 * that matches `event_type`; Google rejects mismatched blocks.
 */
function buildNewSeriesBody(
  ne: NewEventInput,
  timeZone?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: ne.summary,
    start: eventTimeField(ne.start, timeZone),
    end: eventTimeField(ne.end, timeZone),
  };
  if (ne.attendees !== undefined) body.attendees = normalizeAttendees(ne.attendees);
  if (ne.location !== undefined) body.location = ne.location;
  if (ne.description !== undefined) body.description = ne.description;
  if (ne.recurrence !== undefined) body.recurrence = ne.recurrence;
  if (ne.reminders !== undefined) body.reminders = buildRemindersField(ne.reminders);
  if (ne.create_meet_link === true) body.conferenceData = buildMeetConferenceRequest();
  if (ne.color_id !== undefined) body.colorId = ne.color_id;
  if (ne.visibility !== undefined) body.visibility = ne.visibility;
  if (ne.transparency !== undefined) body.transparency = ne.transparency;
  if (ne.guests_can_invite_others !== undefined) {
    body.guestsCanInviteOthers = ne.guests_can_invite_others;
  }
  if (ne.guests_can_modify !== undefined) body.guestsCanModify = ne.guests_can_modify;
  if (ne.guests_can_see_other_guests !== undefined) {
    body.guestsCanSeeOtherGuests = ne.guests_can_see_other_guests;
  }
  if (ne.source !== undefined) body.source = buildSourceField(ne.source);
  if (ne.extended_properties !== undefined) {
    const ext = buildExtendedPropertiesField(ne.extended_properties);
    if (ext !== null) body.extendedProperties = ext;
  }
  if (ne.event_type !== undefined && ne.event_type !== "default") {
    body.eventType = ne.event_type;
  }
  if (ne.event_type === "focusTime" && ne.focus_time !== undefined) {
    body.focusTimeProperties = buildFocusTimeProperties(ne.focus_time);
  }
  if (ne.event_type === "outOfOffice" && ne.out_of_office !== undefined) {
    body.outOfOfficeProperties = buildOutOfOfficeProperties(ne.out_of_office);
  }
  if (ne.event_type === "workingLocation" && ne.working_location !== undefined) {
    body.workingLocationProperties = buildWorkingLocationProperties(
      ne.working_location,
    );
  }
  if (ne.event_type === "birthday" && ne.birthday !== undefined) {
    body.birthdayProperties = buildBirthdayProperties(ne.birthday);
  }
  // Mark unused helper to silence the linter; buildUpdateEventBody is not
  // used here (we build the create-side body), but kept imported as a hint
  // to maintainers that the recurrence module shares the helper namespace.
  void buildUpdateEventBody;
  return body;
}

export const splitRecurrenceTool = defineTool<
  SplitRecurrenceInput,
  SplitRecurrenceOutput,
  CalendarContext
>({
  name: "split_recurrence",
  description: "Split recurring series at a date",
  // Cast required because `calendar_id` and `confirm` have defaults.
  inputSchema:
    splitRecurrenceInputSchema as unknown as z.ZodType<SplitRecurrenceInput>,
  handler: async (input, ctx) => {
    const parsed = input as SplitRecurrenceParsed;

    // Fetch the master series first so we can validate it has a recurrence
    // rule before asking the caller to confirm.
    const rawMaster = await ctx.client.getEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
    });
    const master = (rawMaster && typeof rawMaster === "object"
      ? rawMaster
      : {}) as Record<string, unknown>;
    if (!Array.isArray(master.recurrence) || master.recurrence.length === 0) {
      throw new ValidationError(
        `Event \`${parsed.event_id}\` is not a recurring series (no RRULE).`,
      );
    }

    const summary = typeof master.summary === "string" ? master.summary : "";
    const preview =
      `Split recurring '${summary}' at ${parsed.target_start}: ` +
      `cap series with UNTIL, then create new series with provided fields`;
    guardDestructive({ confirm: parsed.confirm, preview });

    // Step 1: cap the master series with UNTIL = (target_start - 1s) in UTC.
    const untilUtc = untilStampBefore(parsed.target_start);
    const cappedRules = applyUntilToRRule(
      master.recurrence.filter((r): r is string => typeof r === "string"),
      untilUtc,
    );

    const sendUpdates = parsed.send_updates ?? "none";
    const truncatedRaw = await ctx.client.patchEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
      body: { recurrence: cappedRules },
      sendUpdates,
    });

    // Step 2: insert the new series. Always recurring → always needs tz.
    const newSeriesTz = await ctx.client.ensureTimeZone();
    const insertBody = buildNewSeriesBody(parsed.new_event, newSeriesTz);
    const insertOpts: {
      calendarId: string;
      body: Record<string, unknown>;
      conferenceDataVersion?: 0 | 1;
      sendUpdates?: "all" | "externalOnly" | "none";
    } = {
      calendarId: parsed.calendar_id,
      body: insertBody,
    };
    if (parsed.new_event.create_meet_link === true) {
      insertOpts.conferenceDataVersion = 1;
    }
    insertOpts.sendUpdates = sendUpdates;
    const newRaw = await ctx.client.insertEvent(insertOpts);

    return {
      truncated_series: mapEvent(truncatedRaw, parsed.calendar_id),
      new_series: mapEvent(newRaw, parsed.calendar_id),
    };
  },
});
