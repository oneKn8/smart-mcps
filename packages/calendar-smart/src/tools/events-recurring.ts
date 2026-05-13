import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";
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

    const body = buildUpdateEventBody(parsed);

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
