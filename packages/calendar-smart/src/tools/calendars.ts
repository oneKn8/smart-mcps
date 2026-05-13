import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

// =============================================================================
// list_calendars
// =============================================================================

const minAccessRoleSchema = z.enum([
  "freeBusyReader",
  "reader",
  "writer",
  "owner",
]);

const listCalendarsInputSchema = z.object({
  show_hidden: z.boolean().optional().default(false),
  show_deleted: z.boolean().optional().default(false),
  min_access_role: minAccessRoleSchema.optional(),
});

type ListCalendarsInput = z.input<typeof listCalendarsInputSchema>;
type ListCalendarsParsed = z.infer<typeof listCalendarsInputSchema>;

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
  // Cast required because `show_hidden` and `show_deleted` have defaults.
  inputSchema:
    listCalendarsInputSchema as unknown as z.ZodType<ListCalendarsInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListCalendarsParsed;
    const opts: {
      showHidden: boolean;
      showDeleted: boolean;
      minAccessRole?: string;
    } = {
      showHidden: parsed.show_hidden,
      showDeleted: parsed.show_deleted,
    };
    if (parsed.min_access_role !== undefined) {
      opts.minAccessRole = parsed.min_access_role;
    }
    const items = await ctx.client.listCalendars(opts);
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
