import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, eventTimeField, type SlimEvent } from "../event-mapper.js";

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
  attendees: z.array(z.string().email()).optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  recurrence: z.array(z.string().min(1)).optional(),
  calendar_id: z.string().optional().default("primary"),
});

type CreateEventInput = z.input<typeof createEventInputSchema>;
type CreateEventParsed = z.infer<typeof createEventInputSchema>;

type CreateEventOutput = { event: SlimEvent };

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
    // Build the body with only the keys that have values. Strip undefineds
    // explicitly so the upstream payload is minimal — Google echoes back
    // the exact fields we send and we don't want stray `attendees: null`
    // to wipe an existing attendee list on a future PATCH-like flow.
    const body: Record<string, unknown> = {
      summary: parsed.summary,
      start: eventTimeField(parsed.start),
      end: eventTimeField(parsed.end),
    };
    if (parsed.attendees !== undefined) {
      body.attendees = parsed.attendees.map((email) => ({ email }));
    }
    if (parsed.location !== undefined) body.location = parsed.location;
    if (parsed.description !== undefined) body.description = parsed.description;
    if (parsed.recurrence !== undefined) body.recurrence = parsed.recurrence;

    const raw = await ctx.client.insertEvent({
      calendarId: parsed.calendar_id,
      body,
    });
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
