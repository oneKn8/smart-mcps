import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

// =============================================================================
// create_calendar
// =============================================================================

const createCalendarInputSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  time_zone: z.string().optional(),
});

type CreateCalendarInput = z.infer<typeof createCalendarInputSchema>;
type CreateCalendarOutput = { calendar: SlimCalendar };

/**
 * Best-effort re-fetch of a freshly-mutated calendar via the CalendarList
 * endpoint so the slim shape carries `accessRole`/`primary`/`selected` from
 * the per-user view rather than the stripped Calendars-resource shape. If
 * the re-fetch fails (transient, race against quotas, etc.) we fall back to
 * the mutation response so the caller still sees the new id and metadata.
 */
async function refetchAsListEntryOrFallback(
  ctx: CalendarContext,
  fallbackRaw: unknown,
  calendarId: string,
): Promise<SlimCalendar> {
  try {
    const entry = await ctx.client.getCalendarListEntry(calendarId);
    return mapCalendar(entry);
  } catch {
    return mapCalendar(fallbackRaw);
  }
}

function readId(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
  }
  return fallback;
}

export const createCalendarTool = defineTool<
  CreateCalendarInput,
  CreateCalendarOutput,
  CalendarContext
>({
  name: "create_calendar",
  description: "Create a new secondary calendar",
  inputSchema: createCalendarInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { summary: input.summary };
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.time_zone !== undefined) body.timeZone = input.time_zone;

    const raw = await ctx.client.insertCalendar(body);
    const newId = readId(raw, "");
    return {
      calendar: await refetchAsListEntryOrFallback(ctx, raw, newId),
    };
  },
});

// =============================================================================
// update_calendar
// =============================================================================

const updateCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  time_zone: z.string().optional(),
});

type UpdateCalendarInput = z.infer<typeof updateCalendarInputSchema>;
type UpdateCalendarOutput = { calendar: SlimCalendar };

export const updateCalendarTool = defineTool<
  UpdateCalendarInput,
  UpdateCalendarOutput,
  CalendarContext
>({
  name: "update_calendar",
  description: "Update calendar metadata",
  inputSchema: updateCalendarInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.time_zone !== undefined) body.timeZone = input.time_zone;

    const raw = await ctx.client.patchCalendar({
      calendarId: input.calendar_id,
      body,
    });
    return {
      calendar: await refetchAsListEntryOrFallback(
        ctx,
        raw,
        input.calendar_id,
      ),
    };
  },
});
