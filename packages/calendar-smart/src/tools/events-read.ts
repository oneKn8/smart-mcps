import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

// =============================================================================
// list_events
// =============================================================================

const listEventsInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
  time_min: z.string().optional(),
  time_max: z.string().optional(),
  query: z.string().optional(),
  max_results: z.number().int().min(1).max(250).optional().default(50),
});

type ListEventsInput = z.input<typeof listEventsInputSchema>;
type ListEventsParsed = z.infer<typeof listEventsInputSchema>;

type ListEventsOutput = {
  events: SlimEvent[];
  next_page_token: string | null;
};

export const listEventsTool = defineTool<
  ListEventsInput,
  ListEventsOutput,
  CalendarContext
>({
  name: "list_events",
  description: "List events in a calendar window",
  // Cast required because the schema has `.optional().default(...)` fields.
  // ZodDefault widens the input type to include `undefined`, but the parsed
  // output type the handler receives is fully resolved.
  inputSchema: listEventsInputSchema as unknown as z.ZodType<ListEventsInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListEventsParsed;
    const result = await ctx.client.listEvents({
      calendarId: parsed.calendar_id,
      timeMin: parsed.time_min,
      timeMax: parsed.time_max,
      q: parsed.query,
      maxResults: parsed.max_results,
    });
    return {
      events: result.items.map((item) =>
        mapEvent(item, parsed.calendar_id),
      ),
      next_page_token: result.nextPageToken ?? null,
    };
  },
});
