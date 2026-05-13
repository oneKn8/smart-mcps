import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

// =============================================================================
// list_calendars
// =============================================================================

const listCalendarsInputSchema = z.object({});

type ListCalendarsInput = z.infer<typeof listCalendarsInputSchema>;

type ListCalendarsOutput = {
  calendars: SlimCalendar[];
};

export const listCalendarsTool = defineTool<
  ListCalendarsInput,
  ListCalendarsOutput,
  CalendarContext
>({
  name: "list_calendars",
  description: "List all your calendars",
  inputSchema: listCalendarsInputSchema,
  handler: async (_input, ctx) => {
    const items = await ctx.client.listCalendars();
    return { calendars: items.map((item) => mapCalendar(item)) };
  },
});

// =============================================================================
// get_calendar
// =============================================================================

const getCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
});

type GetCalendarInput = z.infer<typeof getCalendarInputSchema>;

type GetCalendarOutput = {
  calendar: SlimCalendar;
};

export const getCalendarTool = defineTool<
  GetCalendarInput,
  GetCalendarOutput,
  CalendarContext
>({
  name: "get_calendar",
  description: "Get one calendar's details",
  inputSchema: getCalendarInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getCalendarListEntry(input.calendar_id);
    return { calendar: mapCalendar(raw) };
  },
});
