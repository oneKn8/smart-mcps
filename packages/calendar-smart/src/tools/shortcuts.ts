import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";
import {
  findFreeBlocks,
  mergeBusy,
  type BusyWindow,
  type FreeBlock as FreeBlockMath,
} from "../free-busy.js";
import {
  startOfDay,
  endOfDay,
  weekBounds,
  formatIso,
  todayInTz,
} from "../time-zone.js";

// Page size used by both briefs. A bounded day / week should comfortably fit
// in 250 entries even for an aggressively-scheduled calendar.
const BRIEF_PAGE_SIZE = 250;

// Minimum free-block duration surfaced by `daily_brief` / `weekly_brief`.
// Sub-15-minute gaps are too short to be actionable for a human reader; keeping
// the floor here keeps the brief signal-rich.
const MIN_FREE_BLOCK_MINUTES = 15;

/**
 * Wire-format `FreeBlock` returned by the brief tools. Same shape as the one
 * `find_availability` emits — ISO start/end + integer duration_minutes.
 */
type FreeBlock = {
  start: string;
  end: string;
  duration_minutes: number;
};

function toFreeBlockWire(block: FreeBlockMath, tz: string): FreeBlock {
  return {
    start: formatIso(block.start, tz),
    end: formatIso(block.end, tz),
    duration_minutes: block.durationMinutes,
  };
}

/**
 * Build a `BusyWindow[]` from raw Google event resources. All-day events are
 * expanded so their `date` boundaries map to local-tz midnight (otherwise a
 * bare `YYYY-MM-DD` string parses as UTC midnight and an all-day event in a
 * non-UTC tz would only block part of the user's calendar day).
 *
 * Events missing both `dateTime` and `date` on either side are silently
 * skipped — those are partial / malformed resources the mapper would also
 * reject.
 */
function rawEventsToBusy(items: unknown[], tz: string): BusyWindow[] {
  const windows: BusyWindow[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const start = obj.start as { dateTime?: unknown; date?: unknown } | undefined;
    const end = obj.end as { dateTime?: unknown; date?: unknown } | undefined;
    if (start === undefined || end === undefined) continue;
    let startDate: Date | null = null;
    let endDate: Date | null = null;
    if (typeof start.dateTime === "string" && typeof end.dateTime === "string") {
      startDate = new Date(start.dateTime);
      endDate = new Date(end.dateTime);
    } else if (
      typeof start.date === "string" &&
      typeof end.date === "string"
    ) {
      // All-day in local tz: midnight on the start date → midnight on the
      // end date (Google's `end.date` is exclusive, one day past the last
      // covered day, so `startOfDay(end.date)` is the right exclusive end).
      startDate = startOfDay(start.date, tz);
      endDate = startOfDay(end.date, tz);
    }
    if (startDate === null || endDate === null) continue;
    windows.push({ start: startDate, end: endDate });
  }
  return windows;
}

// ============================================================================
// daily_brief
// ============================================================================

const dailyBriefInputSchema = z.object({
  date: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
});

type DailyBriefInput = z.input<typeof dailyBriefInputSchema>;
type DailyBriefParsed = z.infer<typeof dailyBriefInputSchema>;

type DailyBriefOutput = {
  date: string;
  total: number;
  events: SlimEvent[];
  first_conflict: SlimEvent[] | null;
  biggest_free_block: FreeBlock | null;
};

/**
 * Compose-style "what's my day look like" brief. Bundles the agenda count,
 * first 3 events, the first overlapping pair (if any), and the biggest free
 * block of the day. The LLM caller uses this instead of stitching together
 * three separate tool calls.
 */
export const dailyBriefTool = defineTool<
  DailyBriefInput,
  DailyBriefOutput,
  CalendarContext
>({
  name: "daily_brief",
  description: "Today: events, conflict, biggest gap",
  // Cast required: `calendar_id` has `.optional().default(...)`.
  inputSchema:
    dailyBriefInputSchema as unknown as z.ZodType<DailyBriefInput>,
  handler: async (input, ctx) => {
    const parsed = input as DailyBriefParsed;
    const tz = await ctx.client.ensureTimeZone();
    const dateKey = parsed.date ?? todayInTz(tz);
    const dayStart = startOfDay(dateKey, tz);
    const dayEnd = endOfDay(dateKey, tz);
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: formatIso(dayStart, tz),
      timeMax: formatIso(dayEnd, tz),
      maxResults: BRIEF_PAGE_SIZE,
    });
    const slim = result.items.map((item) =>
      mapEvent(item, parsed.calendar_id),
    );

    // Scan for first overlap. Items come back from listEvents ordered by
    // startTime (the client passes orderBy=startTime), so we trust that
    // order; only timed events are eligible for the overlap check.
    let firstConflict: SlimEvent[] | null = null;
    for (let i = 0; i < slim.length - 1; i++) {
      const a = slim[i];
      const b = slim[i + 1];
      if (a === undefined || b === undefined) continue;
      if (a.all_day || b.all_day) continue;
      const aEnd = new Date(a.end).getTime();
      const bStart = new Date(b.start).getTime();
      if (aEnd > bStart) {
        firstConflict = [a, b];
        break;
      }
    }

    // Biggest free block within the day window. Busy windows are taken from
    // the same raw items the agenda mapped above so the math is consistent.
    const busy = rawEventsToBusy(result.items, tz);
    const freeBlocks = findFreeBlocks(
      busy,
      dayStart,
      dayEnd,
      MIN_FREE_BLOCK_MINUTES,
    );
    let biggest: FreeBlockMath | null = null;
    for (const fb of freeBlocks) {
      if (biggest === null || fb.durationMinutes > biggest.durationMinutes) {
        biggest = fb;
      }
    }

    return {
      date: dateKey,
      total: slim.length,
      events: slim.slice(0, 3),
      first_conflict: firstConflict,
      biggest_free_block: biggest === null ? null : toFreeBlockWire(biggest, tz),
    };
  },
});

// ============================================================================
// weekly_brief
// ============================================================================

const weeklyBriefInputSchema = z.object({
  week_of: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
});

type WeeklyBriefInput = z.input<typeof weeklyBriefInputSchema>;
type WeeklyBriefParsed = z.infer<typeof weeklyBriefInputSchema>;

type WeeklyBriefOutput = {
  week_start: string;
  week_end: string;
  total: number;
  busiest_day: { date: string; count: number };
  biggest_free_block: FreeBlock | null;
  days: { date: string; count: number }[];
};

/**
 * Week-level rollup: total event count, per-day counts (7 entries, Monday
 * through Sunday), busiest day (ties broken by earliest date), and the
 * single biggest free block anywhere in the week.
 */
export const weeklyBriefTool = defineTool<
  WeeklyBriefInput,
  WeeklyBriefOutput,
  CalendarContext
>({
  name: "weekly_brief",
  description: "Week: total, busiest day, biggest gap",
  // Cast required: `calendar_id` has `.optional().default(...)`.
  inputSchema:
    weeklyBriefInputSchema as unknown as z.ZodType<WeeklyBriefInput>,
  handler: async (input, ctx) => {
    const parsed = input as WeeklyBriefParsed;
    const tz = await ctx.client.ensureTimeZone();
    const anchor = parsed.week_of ?? todayInTz(tz);
    const { start: weekStart, end: weekEnd } = weekBounds(anchor, tz);
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: formatIso(weekStart, tz),
      timeMax: formatIso(weekEnd, tz),
      maxResults: BRIEF_PAGE_SIZE,
    });
    const total = result.items.length;

    // Always emit 7 day buckets (Mon..Sun) keyed by YYYY-MM-DD in tz, even
    // when a day has zero events. Initialize from the week_start.
    const dayKeys: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = startOfDay(todayInTzAdd(tz, weekStart, i), tz);
      dayKeys.push(todayInTz(tz, d));
    }
    const counts = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    for (const item of result.items) {
      const obj = item as Record<string, unknown>;
      const startBlock = obj.start as
        | { dateTime?: unknown; date?: unknown }
        | undefined;
      if (startBlock === undefined) continue;
      const startIso =
        typeof startBlock.dateTime === "string"
          ? startBlock.dateTime
          : typeof startBlock.date === "string"
            ? startBlock.date
            : null;
      if (startIso === null) continue;
      // Day-key uses the cached tz, so a 23:00-05:00 event lands on its
      // local-tz calendar day, not on the UTC calendar day.
      const key = todayInTz(tz, new Date(startIso));
      const prev = counts.get(key);
      if (prev !== undefined) counts.set(key, prev + 1);
    }
    const days = dayKeys.map((date) => ({
      date,
      count: counts.get(date) ?? 0,
    }));

    // Busiest day: largest count, ties broken by earliest date — iterate in
    // dayKeys order (already Mon..Sun) and only replace on strict gain.
    // For an empty week this leaves Monday as the busiest_day with count 0,
    // which is the documented behavior.
    let busiest = { date: dayKeys[0] ?? "", count: 0 };
    for (const d of days) {
      if (d.count > busiest.count) busiest = d;
    }

    // Biggest free block across the entire week.
    const busy = rawEventsToBusy(result.items, tz);
    const freeBlocks = findFreeBlocks(
      mergeBusy(busy),
      weekStart,
      weekEnd,
      MIN_FREE_BLOCK_MINUTES,
    );
    let biggest: FreeBlockMath | null = null;
    for (const fb of freeBlocks) {
      if (biggest === null || fb.durationMinutes > biggest.durationMinutes) {
        biggest = fb;
      }
    }

    return {
      week_start: formatIso(weekStart, tz),
      week_end: formatIso(weekEnd, tz),
      total,
      busiest_day: busiest,
      biggest_free_block: biggest === null ? null : toFreeBlockWire(biggest, tz),
      days,
    };
  },
});

/**
 * Return the YYYY-MM-DD key for `offsetDays` days after `weekStart`, computed
 * in the local tz. Used to seed the 7-day key array without re-running
 * `weekBounds`.
 */
function todayInTzAdd(tz: string, weekStart: Date, offsetDays: number): Date {
  // weekStart is local-tz midnight as a UTC Date. Adding 24h * N gives the
  // next-day midnight ACROSS DST transitions only if the offset is fixed in
  // the week. Within a single week we accept the small risk: DST transitions
  // happen at most once per week, and per-day counting is robust to a one-
  // hour shift in the underlying offset because `todayInTz` re-resolves the
  // date in the tz.
  return new Date(weekStart.getTime() + offsetDays * 24 * 3600 * 1000);
}

// ============================================================================
// find_meeting_time
// ============================================================================

const MAX_TOP_N = 20;
const DEFAULT_TOP_N = 5;

const findMeetingTimeInputSchema = z.object({
  duration_minutes: z.number().int().min(1).max(24 * 60),
  time_min: z.string().min(1),
  time_max: z.string().min(1),
  my_calendar_ids: z.array(z.string().min(1)).optional(),
  extra_busy: z
    .array(
      z.object({
        start: z.string().min(1),
        end: z.string().min(1),
      }),
    )
    .optional(),
  top_n: z.number().int().min(1).max(MAX_TOP_N).optional().default(DEFAULT_TOP_N),
});

type FindMeetingTimeInput = z.input<typeof findMeetingTimeInputSchema>;
type FindMeetingTimeParsed = z.infer<typeof findMeetingTimeInputSchema>;

type FindMeetingTimeOutput = {
  slots: FreeBlock[];
};

/**
 * Compose-style "where can N people meet" finder. Combines two sources of
 * busy windows:
 *  - `my_calendar_ids`: queried via Google's `freeBusy` (any calendar the
 *    bound account has ACL on — shared family cal, work cal, etc.).
 *  - `extra_busy`: raw `{start, end}` windows the caller already knows
 *    about (typically external participants whose calendars the user can't
 *    see).
 *
 * Returns the top N earliest free blocks of at least `duration_minutes`.
 * No side effects — this just surfaces candidate slots; the LLM caller
 * picks one and follows up with `create_event` itself.
 */
export const findMeetingTimeTool = defineTool<
  FindMeetingTimeInput,
  FindMeetingTimeOutput,
  CalendarContext
>({
  name: "find_meeting_time",
  description: "Find best meeting times",
  // Cast required: `top_n` has `.optional().default(...)`.
  inputSchema:
    findMeetingTimeInputSchema as unknown as z.ZodType<FindMeetingTimeInput>,
  handler: async (input, ctx) => {
    const parsed = input as FindMeetingTimeParsed;
    const tz = await ctx.client.ensureTimeZone();
    const windows: BusyWindow[] = [];

    if (parsed.my_calendar_ids && parsed.my_calendar_ids.length > 0) {
      const result = await ctx.client.freeBusy({
        timeMin: parsed.time_min,
        timeMax: parsed.time_max,
        calendarIds: parsed.my_calendar_ids,
      });
      const calendarsRecord = result.calendars ?? {};
      for (const calendarId of parsed.my_calendar_ids) {
        const cal = calendarsRecord[calendarId];
        if (cal === undefined) continue;
        for (const b of cal.busy) {
          windows.push({ start: new Date(b.start), end: new Date(b.end) });
        }
      }
    }

    if (parsed.extra_busy && parsed.extra_busy.length > 0) {
      for (const w of parsed.extra_busy) {
        windows.push({ start: new Date(w.start), end: new Date(w.end) });
      }
    }

    const merged = mergeBusy(windows);
    const rangeStart = new Date(parsed.time_min);
    const rangeEnd = new Date(parsed.time_max);
    const free = findFreeBlocks(
      merged,
      rangeStart,
      rangeEnd,
      parsed.duration_minutes,
    );
    const top = free.slice(0, parsed.top_n);
    return {
      slots: top.map((b) => toFreeBlockWire(b, tz)),
    };
  },
});

// ============================================================================
// event_with_invite_preview
// ============================================================================

const eventWithInvitePreviewInputSchema = z.object({
  summary: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  attendees: z.array(z.string().min(1)),
  location: z.string().optional(),
  description: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
});

type EventWithInvitePreviewInput = z.input<
  typeof eventWithInvitePreviewInputSchema
>;
type EventWithInvitePreviewParsed = z.infer<
  typeof eventWithInvitePreviewInputSchema
>;

type CreateEventPayload = {
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  description?: string;
  calendar_id: string;
};

type EventWithInvitePreviewOutput = {
  create_event_payload: CreateEventPayload;
  invite_email_subject: string;
  invite_email_body: string;
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Format an instant as `"<Weekday>, <Month> <Day>"` in the given tz, e.g.
 * `"Friday, May 15"`. Used for the human-readable date in the invite
 * subject. The weekday comes from `Intl.DateTimeFormat`'s `weekday: "long"`
 * part; month + day come from the same parts pipe so the offset matches the
 * cached calendar tz.
 */
function formatHumanDate(instant: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  // formatToParts ensures we render in a known order independent of locale
  // tweaks. The "en-US" formatter normally returns "Friday, May 15" but
  // building it from parts is less brittle.
  const parts = fmt.formatToParts(instant);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  const weekday = lookup.weekday ?? "";
  const month = lookup.month ?? MONTH_NAMES[instant.getUTCMonth()] ?? "";
  const day = lookup.day ?? "";
  return `${weekday}, ${month} ${day}`;
}

/**
 * Pure preview builder. Composes two outputs the LLM caller will use to
 * (1) call `create_event` and (2) call `email-smart.send_email` with the
 * invite. NO side effects: this tool does not create the event and does
 * not send the email.
 */
export const eventWithInvitePreviewTool = defineTool<
  EventWithInvitePreviewInput,
  EventWithInvitePreviewOutput,
  CalendarContext
>({
  name: "event_with_invite_preview",
  description: "Preview event + invite email",
  // Cast required: `calendar_id` has `.optional().default(...)`.
  inputSchema:
    eventWithInvitePreviewInputSchema as unknown as z.ZodType<EventWithInvitePreviewInput>,
  handler: async (input, ctx) => {
    const parsed = input as EventWithInvitePreviewParsed;
    const tz = await ctx.client.ensureTimeZone();
    const startInstant = new Date(parsed.start);
    const endInstant = new Date(parsed.end);
    const humanDate = formatHumanDate(startInstant, tz);
    const startFormatted = formatIso(startInstant, tz);
    const endFormatted = formatIso(endInstant, tz);
    const subject = `Invite: ${parsed.summary} on ${humanDate}`;
    const body = [
      `When: ${startFormatted} - ${endFormatted}`,
      `Where: ${parsed.location ?? "TBD"}`,
      "",
      parsed.description ?? "",
    ].join("\n");
    const payload: CreateEventPayload = {
      summary: parsed.summary,
      start: parsed.start,
      end: parsed.end,
      attendees: parsed.attendees,
      calendar_id: parsed.calendar_id,
      ...(parsed.location !== undefined ? { location: parsed.location } : {}),
      ...(parsed.description !== undefined
        ? { description: parsed.description }
        : {}),
    };
    return {
      create_event_payload: payload,
      invite_email_subject: subject,
      invite_email_body: body,
    };
  },
});

// ============================================================================
// outdoor_event_check
// ============================================================================

const OUTDOOR_HINT =
  "Pass location to weather-smart.geocode then weather-smart.outdoor_window for forecast at this start time";

const outdoorEventCheckInputSchema = z.object({
  event_id: z.string().min(1),
  calendar_id: z.string().optional().default("primary"),
});

type OutdoorEventCheckInput = z.input<typeof outdoorEventCheckInputSchema>;
type OutdoorEventCheckParsed = z.infer<typeof outdoorEventCheckInputSchema>;

type OutdoorEventCheckOutput = {
  event: SlimEvent;
  location: string | null;
  hint: string;
};

/**
 * Cross-MCP composition hint: surfaces an event's location and the exact
 * follow-up tools the LLM should call to get a forecast. Does not geocode
 * or call weather-smart itself — keeping the calendar/weather domain split
 * clean (calendar-smart never imports weather-smart).
 */
export const outdoorEventCheckTool = defineTool<
  OutdoorEventCheckInput,
  OutdoorEventCheckOutput,
  CalendarContext
>({
  name: "outdoor_event_check",
  description: "Surface event location for weather check",
  // Cast required: `calendar_id` has `.optional().default(...)`.
  inputSchema:
    outdoorEventCheckInputSchema as unknown as z.ZodType<OutdoorEventCheckInput>,
  handler: async (input, ctx) => {
    const parsed = input as OutdoorEventCheckParsed;
    const raw = await ctx.client.getEvent({
      calendarId: parsed.calendar_id,
      eventId: parsed.event_id,
    });
    const slim = mapEvent(raw, parsed.calendar_id);
    return {
      event: slim,
      location: slim.location,
      hint: OUTDOOR_HINT,
    };
  },
});
