import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";
import { findFreeBlocks, type BusyWindow } from "../free-busy.js";
import { formatIso } from "../time-zone.js";

// Shared output shapes — matches the Phase 5 spec data shapes.

type FreeBlock = {
  start: string;
  end: string;
  duration_minutes: number;
};

type BusyBlock = {
  start: string;
  end: string;
  calendar_id: string;
};

// =============================================================================
// find_availability
// =============================================================================

const findAvailabilityInputSchema = z.object({
  duration_minutes: z.number().int().min(1).max(24 * 60),
  time_min: z.string().min(1),
  time_max: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
});

type FindAvailabilityInput = z.input<typeof findAvailabilityInputSchema>;
type FindAvailabilityParsed = z.infer<typeof findAvailabilityInputSchema>;

type FindAvailabilityOutput = {
  free_blocks: FreeBlock[];
};

export const findAvailabilityTool = defineTool<
  FindAvailabilityInput,
  FindAvailabilityOutput,
  CalendarContext
>({
  name: "find_availability",
  description: "Find free blocks of N minutes",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    findAvailabilityInputSchema as unknown as z.ZodType<FindAvailabilityInput>,
  handler: async (input, ctx) => {
    const parsed = input as FindAvailabilityParsed;
    const tz = await ctx.client.ensureTimeZone();
    const result = await ctx.client.freeBusy({
      timeMin: parsed.time_min,
      timeMax: parsed.time_max,
      calendarIds: [parsed.calendar_id],
    });
    const calendarsRecord = result.calendars ?? {};
    const cal = calendarsRecord[parsed.calendar_id];
    const windows: BusyWindow[] = (cal?.busy ?? []).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    }));
    const rangeStart = new Date(parsed.time_min);
    const rangeEnd = new Date(parsed.time_max);
    const free = findFreeBlocks(
      windows,
      rangeStart,
      rangeEnd,
      parsed.duration_minutes,
    );
    return {
      free_blocks: free.map((f) => ({
        start: formatIso(f.start, tz),
        end: formatIso(f.end, tz),
        duration_minutes: f.durationMinutes,
      })),
    };
  },
});

// =============================================================================
// busy_blocks
// =============================================================================

const busyBlocksInputSchema = z.object({
  time_min: z.string().min(1),
  time_max: z.string().min(1),
  calendar_ids: z.array(z.string().min(1)).optional().default(["primary"]),
});

type BusyBlocksInput = z.input<typeof busyBlocksInputSchema>;
type BusyBlocksParsed = z.infer<typeof busyBlocksInputSchema>;

type BusyBlocksOutput = {
  busy: BusyBlock[];
};

export const busyBlocksTool = defineTool<
  BusyBlocksInput,
  BusyBlocksOutput,
  CalendarContext
>({
  name: "busy_blocks",
  description: "List busy windows across calendars",
  // Cast required because `calendar_ids` has `.optional().default(...)`.
  inputSchema:
    busyBlocksInputSchema as unknown as z.ZodType<BusyBlocksInput>,
  handler: async (input, ctx) => {
    const parsed = input as BusyBlocksParsed;
    const tz = await ctx.client.ensureTimeZone();
    const result = await ctx.client.freeBusy({
      timeMin: parsed.time_min,
      timeMax: parsed.time_max,
      calendarIds: parsed.calendar_ids,
    });
    const calendarsRecord = result.calendars ?? {};
    const out: BusyBlock[] = [];
    // Preserve input order; calendars omitted from the response are skipped.
    for (const calendarId of parsed.calendar_ids) {
      const cal = calendarsRecord[calendarId];
      if (cal === undefined) continue;
      for (const b of cal.busy) {
        out.push({
          start: formatIso(new Date(b.start), tz),
          end: formatIso(new Date(b.end), tz),
          calendar_id: calendarId,
        });
      }
    }
    return { busy: out };
  },
});

// =============================================================================
// conflicts_check
// =============================================================================

const conflictsCheckInputSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
});

type ConflictsCheckInput = z.input<typeof conflictsCheckInputSchema>;
type ConflictsCheckParsed = z.infer<typeof conflictsCheckInputSchema>;

type ConflictsCheckOutput = {
  conflicts: SlimEvent[];
};

/**
 * Pull the timed-event start/end as ms since epoch. Returns null when the
 * event is all-day (date-only string), since adjacency rules around all-day
 * events are ambiguous and the upstream filter on `listEvents` already
 * scoped the window. All-day events that overlap the day are kept verbatim.
 */
function eventBoundsMs(
  raw: Record<string, unknown>,
): { startMs: number; endMs: number; allDay: boolean } | null {
  const start = raw.start as { dateTime?: unknown; date?: unknown } | undefined;
  const end = raw.end as { dateTime?: unknown; date?: unknown } | undefined;
  if (start === undefined || end === undefined) return null;
  if (typeof start.dateTime === "string" && typeof end.dateTime === "string") {
    return {
      startMs: new Date(start.dateTime).getTime(),
      endMs: new Date(end.dateTime).getTime(),
      allDay: false,
    };
  }
  if (typeof start.date === "string" && typeof end.date === "string") {
    return {
      startMs: new Date(start.date).getTime(),
      endMs: new Date(end.date).getTime(),
      allDay: true,
    };
  }
  return null;
}

export const conflictsCheckTool = defineTool<
  ConflictsCheckInput,
  ConflictsCheckOutput,
  CalendarContext
>({
  name: "conflicts_check",
  description: "Find events overlapping a window",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    conflictsCheckInputSchema as unknown as z.ZodType<ConflictsCheckInput>,
  handler: async (input, ctx) => {
    const parsed = input as ConflictsCheckParsed;
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: parsed.start,
      timeMax: parsed.end,
    });
    const proposedStartMs = new Date(parsed.start).getTime();
    const proposedEndMs = new Date(parsed.end).getTime();
    const conflicts: SlimEvent[] = [];
    for (const item of result.items) {
      const obj = item as Record<string, unknown>;
      const bounds = eventBoundsMs(obj);
      if (bounds === null) {
        // Conservative default: include the event when bounds are unparseable.
        conflicts.push(mapEvent(obj, parsed.calendar_id));
        continue;
      }
      // True half-open overlap: start < proposedEnd AND end > proposedStart.
      // Adjacency (event.end == proposedStart, event.start == proposedEnd)
      // is NOT a conflict.
      if (bounds.startMs < proposedEndMs && bounds.endMs > proposedStartMs) {
        conflicts.push(mapEvent(obj, parsed.calendar_id));
      }
    }
    return { conflicts };
  },
});
