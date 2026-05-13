import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

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
