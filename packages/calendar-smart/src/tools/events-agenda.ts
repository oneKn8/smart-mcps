import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";
import {
  startOfDay,
  endOfDay,
  weekBounds,
  formatIso,
  todayInTz,
} from "../time-zone.js";

// All three agenda tools share the "ensure tz then bound a window then list"
// pattern. They never accept a page-token: agenda windows are bounded and
// the typical day/week always fits within the default 50-event cap. Callers
// who need pagination use `list_events` directly.

const DAILY_AGENDA_PAGE_SIZE = 250;
const WEEKLY_AGENDA_PAGE_SIZE = 250;

// =============================================================================
// daily_agenda
// =============================================================================

const dailyAgendaInputSchema = z.object({
  date: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
});

type DailyAgendaInput = z.input<typeof dailyAgendaInputSchema>;
type DailyAgendaParsed = z.infer<typeof dailyAgendaInputSchema>;

type DailyAgendaOutput = {
  date: string;
  events: SlimEvent[];
};

export const dailyAgendaTool = defineTool<
  DailyAgendaInput,
  DailyAgendaOutput,
  CalendarContext
>({
  name: "daily_agenda",
  description: "Events for a single day",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    dailyAgendaInputSchema as unknown as z.ZodType<DailyAgendaInput>,
  handler: async (input, ctx) => {
    const parsed = input as DailyAgendaParsed;
    const tz = await ctx.client.ensureTimeZone();
    const dateKey = parsed.date ?? todayInTz(tz);
    const start = startOfDay(dateKey, tz);
    const end = endOfDay(dateKey, tz);
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: formatIso(start, tz),
      timeMax: formatIso(end, tz),
      maxResults: DAILY_AGENDA_PAGE_SIZE,
    });
    return {
      date: dateKey,
      events: result.items.map((item) => mapEvent(item, parsed.calendar_id)),
    };
  },
});

// =============================================================================
// weekly_agenda
// =============================================================================

const weeklyAgendaInputSchema = z.object({
  week_of: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
});

type WeeklyAgendaInput = z.input<typeof weeklyAgendaInputSchema>;
type WeeklyAgendaParsed = z.infer<typeof weeklyAgendaInputSchema>;

type WeeklyAgendaOutput = {
  week_start: string;
  week_end: string;
  events: SlimEvent[];
};

/**
 * Format a Date as a YYYY-MM-DD calendar key in the given tz. Used to
 * label the week bounds in the response (so the LLM does not need to
 * re-parse an ISO string).
 */
function dateKeyInTz(d: Date, tz: string): string {
  return todayInTz(tz, d);
}

export const weeklyAgendaTool = defineTool<
  WeeklyAgendaInput,
  WeeklyAgendaOutput,
  CalendarContext
>({
  name: "weekly_agenda",
  description: "Events for a Mon-Sun week",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    weeklyAgendaInputSchema as unknown as z.ZodType<WeeklyAgendaInput>,
  handler: async (input, ctx) => {
    const parsed = input as WeeklyAgendaParsed;
    const tz = await ctx.client.ensureTimeZone();
    const dateKey = parsed.week_of ?? todayInTz(tz);
    const { start, end } = weekBounds(dateKey, tz);
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: formatIso(start, tz),
      timeMax: formatIso(end, tz),
      maxResults: WEEKLY_AGENDA_PAGE_SIZE,
    });
    return {
      week_start: dateKeyInTz(start, tz),
      week_end: dateKeyInTz(end, tz),
      events: result.items.map((item) => mapEvent(item, parsed.calendar_id)),
    };
  },
});

// =============================================================================
// next_event
// =============================================================================

const nextEventInputSchema = z.object({
  within_hours: z.number().int().min(1).max(720).optional().default(24),
  calendar_id: z.string().optional().default("primary"),
});

type NextEventInput = z.input<typeof nextEventInputSchema>;
type NextEventParsed = z.infer<typeof nextEventInputSchema>;

type NextEventOutput = {
  event: SlimEvent | null;
};

export const nextEventTool = defineTool<
  NextEventInput,
  NextEventOutput,
  CalendarContext
>({
  name: "next_event",
  description: "Next upcoming event",
  // Cast required because `calendar_id` and `within_hours` have defaults.
  inputSchema: nextEventInputSchema as unknown as z.ZodType<NextEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as NextEventParsed;
    const tz = await ctx.client.ensureTimeZone();
    const now = new Date();
    const horizon = new Date(now.getTime() + parsed.within_hours * 3600_000);
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: formatIso(now, tz),
      timeMax: formatIso(horizon, tz),
      maxResults: 1,
    });
    const first = result.items[0];
    return {
      event:
        first === undefined
          ? null
          : mapEvent(first, parsed.calendar_id),
    };
  },
});
