import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

// =============================================================================
// search_events
// =============================================================================

const eventTypesFilterSchema = z.array(
  z.enum([
    "default",
    "outOfOffice",
    "focusTime",
    "workingLocation",
    "birthday",
  ]),
);

const searchEventsInputSchema = z.object({
  query: z.string().optional(),
  calendar_id: z.string().optional().default("primary"),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  event_types: eventTypesFilterSchema.optional(),
  private_extended_property: z.record(z.string(), z.string()).optional(),
  max_results: z.number().int().min(1).max(250).optional().default(25),
});

type SearchEventsInput = z.input<typeof searchEventsInputSchema>;
type SearchEventsParsed = z.infer<typeof searchEventsInputSchema>;

type SearchEventsOutput = {
  events: SlimEvent[];
  next_page_token: string | null;
};

export const searchEventsTool = defineTool<
  SearchEventsInput,
  SearchEventsOutput,
  CalendarContext
>({
  name: "search_events",
  description: "Search events by text and filters",
  // Cast required because the schema has `.optional().default(...)` fields.
  inputSchema:
    searchEventsInputSchema as unknown as z.ZodType<SearchEventsInput>,
  handler: async (input, ctx) => {
    const parsed = input as SearchEventsParsed;
    const opts: Parameters<typeof ctx.client.listEvents>[0] = {
      calendarId: parsed.calendar_id,
      maxResults: parsed.max_results,
    };
    if (parsed.query !== undefined) opts.q = parsed.query;
    if (parsed.time_min !== undefined) opts.timeMin = parsed.time_min;
    if (parsed.time_max !== undefined) opts.timeMax = parsed.time_max;
    if (parsed.event_types !== undefined) opts.eventTypes = parsed.event_types;
    if (parsed.private_extended_property !== undefined) {
      opts.privateExtendedProperty = parsed.private_extended_property;
    }
    const result = await ctx.client.listEvents(opts);
    return {
      events: result.items.map((item) =>
        mapEvent(item, parsed.calendar_id),
      ),
      next_page_token: result.nextPageToken ?? null,
    };
  },
});
